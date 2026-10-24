-- 006_tickets.sql — tickets (Phase 6). Service requests reuse these tables in Phase 9.
-- Idempotent: safe to run again.
-- Rules: ATOM_Decisions.md §9–§10 and Phase 6 decisions (24 Oct 2026).

-- ---------- enums ----------
DO $$ BEGIN
  CREATE TYPE request_type AS ENUM ('TICKET', 'SERVICE_REQUEST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_status AS ENUM (
    'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT',
    'RESOLVED', 'CLOSED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE request_priority AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- categories (per service unit; Super Admin edits them later) ----------
CREATE TABLE IF NOT EXISTS categories (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  name             text        NOT NULL,
  sort_order       integer     NOT NULL DEFAULT 100,
  is_active        boolean     NOT NULL DEFAULT TRUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_unit_name_uq UNIQUE (service_unit_id, name)
);

DROP TRIGGER IF EXISTS categories_set_updated_at ON categories;
CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Starter set for AVIT. Never overwrites later edits.
INSERT INTO categories (service_unit_id, name, sort_order)
SELECT s.id, c.name, c.sort_order
  FROM service_units s
  CROSS JOIN (VALUES
    ('Computer / Laptop', 10), ('Printer / Scanner', 20), ('Projector / Display', 30),
    ('Audio / Mic / Speakers', 40), ('Network / Internet', 50), ('Email / Account', 60),
    ('Software', 70), ('CCTV', 80), ('Other', 999)
  ) AS c(name, sort_order)
 WHERE s.code = 'AVIT'
ON CONFLICT (service_unit_id, name) DO NOTHING;

-- ---------- requests (tickets now, service requests in Phase 9) ----------
CREATE SEQUENCE IF NOT EXISTS request_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS requests (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number                integer          NOT NULL DEFAULT nextval('request_number_seq'),  -- shown as T-1001 / R-1001
  type                  request_type     NOT NULL,
  status                request_status   NOT NULL DEFAULT 'OPEN',
  priority              request_priority NOT NULL DEFAULT 'NORMAL',
  title                 text             NOT NULL,
  description           text             NOT NULL,
  location              text,
  category_id           bigint           REFERENCES categories (id),
  service_unit_id       bigint           NOT NULL REFERENCES service_units (id),
  requester_id          bigint           NOT NULL REFERENCES users (id),   -- who it is for
  raised_by_id          bigint           NOT NULL REFERENCES users (id),   -- who raised it (= requester, or a Super Admin)
  assigned_engineer_id  bigint           REFERENCES users (id),
  resolution            text,
  rejection_note        text,
  created_at            timestamptz      NOT NULL DEFAULT now(),
  updated_at            timestamptz      NOT NULL DEFAULT now(),
  assigned_at           timestamptz,
  resolved_at           timestamptz,
  closed_at             timestamptz,
  rejected_at           timestamptz,
  CONSTRAINT requests_number_uq UNIQUE (number),
  CONSTRAINT requests_title_chk CHECK (char_length(title) BETWEEN 3 AND 120),
  CONSTRAINT requests_description_chk CHECK (char_length(description) BETWEEN 1 AND 5000),
  CONSTRAINT requests_rejection_chk CHECK (status <> 'REJECTED' OR char_length(coalesce(rejection_note, '')) >= 3),
  CONSTRAINT requests_assigned_chk CHECK (status IN ('OPEN', 'REJECTED') OR assigned_engineer_id IS NOT NULL)
);

ALTER SEQUENCE request_number_seq OWNED BY requests.number;

CREATE INDEX IF NOT EXISTS requests_requester_idx ON requests (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_raised_by_idx ON requests (raised_by_id);
CREATE INDEX IF NOT EXISTS requests_engineer_idx  ON requests (assigned_engineer_id, status);
CREATE INDEX IF NOT EXISTS requests_status_idx    ON requests (status, created_at DESC);

DROP TRIGGER IF EXISTS requests_set_updated_at ON requests;
CREATE TRIGGER requests_set_updated_at
  BEFORE UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- timeline: every change and every comment ----------
--   created · status (from → to, note) · assigned (data.engineerId / previousEngineerId)
--   comment (note = body, is_internal) · priority / category (data.from / data.to)
CREATE TABLE IF NOT EXISTS request_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   bigint         NOT NULL REFERENCES requests (id),
  type         text           NOT NULL,
  actor_id     bigint         REFERENCES users (id),
  from_status  request_status,
  to_status    request_status,
  note         text,
  is_internal  boolean        NOT NULL DEFAULT FALSE,
  data         jsonb,
  created_at   timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT request_events_type_chk CHECK (type IN ('created', 'status', 'assigned', 'comment', 'priority', 'category')),
  CONSTRAINT request_events_note_len_chk CHECK (note IS NULL OR char_length(note) <= 5000)
);

CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id, created_at, id);

-- ---------- photos (images only, compressed, stored outside the web root) ----------
CREATE TABLE IF NOT EXISTS request_attachments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id     bigint      NOT NULL REFERENCES requests (id),
  event_id       bigint      REFERENCES request_events (id),   -- the comment it came with (NULL = with the ticket)
  uploaded_by    bigint      NOT NULL REFERENCES users (id),
  stored_name    text        NOT NULL,                         -- <uuid>.webp under ATTACHMENT_DIR/requests/<id>/
  original_name  text,
  mime_type      text        NOT NULL,
  size_bytes     integer     NOT NULL,
  width          integer,
  height         integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_attachments_name_chk CHECK (stored_name ~ '^[0-9a-f-]{36}\.(webp|jpg|png)$')
);

CREATE INDEX IF NOT EXISTS request_attachments_request_idx ON request_attachments (request_id);
