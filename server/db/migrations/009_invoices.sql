-- 009_invoices.sql — invoices linked to tickets / service requests (Phase 11, ATOM_Decisions.md §11).
-- Idempotent: safe to run again.
--   - No amounts. The file is enough; supplier / reference / date / note are optional labels.
--   - One invoice → many tickets. Unlinking keeps the row (unlinked_at / by / reason); linking the
--     same pair again adds a new row, so the history stays complete.
--   - Duplicate check: SHA-256 of the ORIGINAL uploaded bytes, unique.
--   - Never deleted.

CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START WITH 1001;   -- shown as INV-1001

CREATE TABLE IF NOT EXISTS invoices (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number           integer     NOT NULL DEFAULT nextval('invoice_number_seq'),
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  file_sha256      text        NOT NULL,
  stored_name      text        NOT NULL,
  mime_type        text        NOT NULL,
  size_bytes       integer     NOT NULL,
  original_name    text,
  supplier         text,
  reference        text,                 -- the supplier's own invoice number
  invoice_date     date,
  note             text,
  uploaded_by_id   bigint      NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_number_uq UNIQUE (number),
  CONSTRAINT invoices_sha256_uq UNIQUE (file_sha256),
  CONSTRAINT invoices_sha256_chk CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invoices_mime_chk CHECK (mime_type IN ('application/pdf', 'image/webp')),
  CONSTRAINT invoices_size_chk CHECK (size_bytes > 0),
  CONSTRAINT invoices_supplier_chk CHECK (supplier IS NULL OR char_length(supplier) <= 120),
  CONSTRAINT invoices_reference_chk CHECK (reference IS NULL OR char_length(reference) <= 80),
  CONSTRAINT invoices_note_chk CHECK (note IS NULL OR char_length(note) <= 1000)
);

ALTER SEQUENCE invoice_number_seq OWNED BY invoices.number;

DROP TRIGGER IF EXISTS invoices_set_updated_at ON invoices;
CREATE TRIGGER invoices_set_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS invoices_created_idx ON invoices (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_uploader_idx ON invoices (uploaded_by_id);

CREATE TABLE IF NOT EXISTS invoice_links (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id      bigint      NOT NULL REFERENCES invoices (id),
  request_id      bigint      NOT NULL REFERENCES requests (id),
  linked_by_id    bigint      NOT NULL REFERENCES users (id),
  linked_at       timestamptz NOT NULL DEFAULT now(),
  unlinked_by_id  bigint      REFERENCES users (id),
  unlinked_at     timestamptz,
  unlink_reason   text,
  CONSTRAINT invoice_links_unlink_chk CHECK (
    (unlinked_at IS NULL AND unlinked_by_id IS NULL AND unlink_reason IS NULL)
    OR (unlinked_at IS NOT NULL AND unlinked_by_id IS NOT NULL AND char_length(coalesce(unlink_reason, '')) BETWEEN 3 AND 500)
  )
);

-- One ACTIVE link per invoice + ticket (unlinked rows don't count).
CREATE UNIQUE INDEX IF NOT EXISTS invoice_links_active_uq ON invoice_links (invoice_id, request_id) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS invoice_links_request_idx ON invoice_links (request_id) WHERE unlinked_at IS NULL;

-- Ticket timeline: invoice linked / unlinked (internal events — requesters never see invoices).
ALTER TABLE request_events DROP CONSTRAINT IF EXISTS request_events_type_chk;
ALTER TABLE request_events ADD CONSTRAINT request_events_type_chk
  CHECK (type IN ('created', 'status', 'assigned', 'comment', 'priority', 'category', 'invoice_linked', 'invoice_unlinked'));
