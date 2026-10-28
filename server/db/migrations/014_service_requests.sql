-- 014_service_requests.sql — catalogue + service requests (Phase 9, decided 28 Oct 2026).
-- Idempotent: safe to run again. (Needs PostgreSQL 12+ for ADD VALUE inside a transaction.)
--   A service request (R-1001, same numbering as tickets) holds one or more items: catalogue items
--   or "something else" typed by the requester. Super Admin approves or rejects each item.
--   PENDING_APPROVAL → (any approved) OPEN → assign → … → RESOLVED (all approved items delivered) → CLOSED
--                    → (all rejected) REJECTED

ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL' BEFORE 'OPEN';

-- A request waiting for approval has no engineer yet. (Compared as text: the new enum value can't
-- be used in the same transaction that adds it.)
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_assigned_chk;
ALTER TABLE requests ADD CONSTRAINT requests_assigned_chk
  CHECK (status::text IN ('PENDING_APPROVAL', 'OPEN', 'REJECTED') OR assigned_engineer_id IS NOT NULL);

-- ---------- catalogue ----------
CREATE TABLE IF NOT EXISTS catalogue_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               text        NOT NULL,
  kind               text        NOT NULL DEFAULT 'physical',   -- physical · software · service
  description        text,
  asset_category_id  bigint      REFERENCES asset_categories (id), -- physical items: where delivery picks assets from
  service_unit_id    bigint      NOT NULL REFERENCES service_units (id),
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT TRUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalogue_items_kind_chk CHECK (kind IN ('physical', 'software', 'service')),
  CONSTRAINT catalogue_items_name_chk CHECK (char_length(name) BETWEEN 2 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS catalogue_items_name_uq ON catalogue_items (lower(name)) WHERE is_active;
DROP TRIGGER IF EXISTS catalogue_items_set_updated_at ON catalogue_items;
CREATE TRIGGER catalogue_items_set_updated_at BEFORE UPDATE ON catalogue_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Starter list (Super Admin edits it later). Only when the catalogue is empty.
INSERT INTO catalogue_items (name, kind, description, service_unit_id, sort_order)
SELECT v.name, v.kind, v.description, s.id, v.sort_order
  FROM service_units s
  CROSS JOIN (VALUES
    ('Office 365', 'software', 'Word, Excel, PowerPoint, Outlook licence.', 10),
    ('Adobe Creative Cloud', 'software', 'Photoshop, Illustrator, InDesign and other Adobe apps.', 20),
    ('Software installation', 'software', 'Any other software you need installed — say which.', 30),
    ('New email account', 'service', 'A new email account or mailbox.', 40),
    ('Headset', 'physical', NULL, 50),
    ('Keyboard', 'physical', NULL, 60),
    ('Mouse', 'physical', NULL, 70),
    ('Webcam', 'physical', NULL, 80),
    ('Monitor', 'physical', NULL, 90)
  ) AS v(name, kind, description, sort_order)
 WHERE s.code = 'AVIT'
   AND NOT EXISTS (SELECT 1 FROM catalogue_items);

-- ---------- request items ----------
--   status: PENDING → APPROVED | REJECTED (Super Admin) · APPROVED → DELIVERED (engineer)
CREATE TABLE IF NOT EXISTS request_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id         bigint      NOT NULL REFERENCES requests (id),
  catalogue_item_id  bigint      REFERENCES catalogue_items (id),   -- NULL = "something else"
  name               text        NOT NULL,                          -- catalogue name at the time, or what was typed
  kind               text        NOT NULL DEFAULT 'service',
  quantity           integer     NOT NULL DEFAULT 1,
  reason             text        NOT NULL,
  status             text        NOT NULL DEFAULT 'PENDING',
  decision_note      text,
  decided_by         bigint      REFERENCES users (id),
  decided_at         timestamptz,
  delivery_note      text,
  delivered_by       bigint      REFERENCES users (id),
  delivered_at       timestamptz,
  sort_order         integer     NOT NULL DEFAULT 0,
  CONSTRAINT request_items_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'DELIVERED')),
  CONSTRAINT request_items_kind_chk CHECK (kind IN ('physical', 'software', 'service')),
  CONSTRAINT request_items_qty_chk CHECK (quantity BETWEEN 1 AND 50),
  CONSTRAINT request_items_name_chk CHECK (char_length(name) BETWEEN 2 AND 200),
  CONSTRAINT request_items_reason_chk CHECK (char_length(reason) BETWEEN 3 AND 1000),
  CONSTRAINT request_items_reject_chk CHECK (status <> 'REJECTED' OR char_length(coalesce(decision_note, '')) >= 3)
);
CREATE INDEX IF NOT EXISTS request_items_request_idx ON request_items (request_id, sort_order, id);

-- Assets handed over for an item (assigned to the requester at delivery).
CREATE TABLE IF NOT EXISTS request_item_assets (
  request_item_id  bigint      NOT NULL REFERENCES request_items (id),
  asset_id         bigint      NOT NULL REFERENCES assets (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_item_id, asset_id)
);

ALTER TABLE request_events DROP CONSTRAINT IF EXISTS request_events_type_chk;
ALTER TABLE request_events ADD CONSTRAINT request_events_type_chk
  CHECK (type IN ('created', 'status', 'assigned', 'comment', 'priority', 'category', 'invoice_linked', 'invoice_unlinked',
                  'item_approved', 'item_rejected', 'item_delivered'));
