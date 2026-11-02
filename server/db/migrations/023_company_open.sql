-- 023_company_open.sql — the Super Admin opens / closes each company (decided 31 Oct 2026). Idempotent.
--   Closed: hidden from the company picker, the login page and every company list for everyone except
--   the Super Admin (incl. that company's Admins and Staff). Nothing is deleted; syncs keep running;
--   reopening brings everything back. At least one company stays open (checked by the API).
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS is_open boolean NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS company_open_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  is_open          boolean     NOT NULL,          -- the NEW state
  changed_by       bigint      NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS company_open_log_idx ON company_open_log (service_unit_id, created_at DESC);
