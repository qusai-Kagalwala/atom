-- 018_companies.sql — three companies, per-company Admins, staff occupations (decided 28 Oct 2026).
-- Idempotent. The tables keep their old names: a "company" is a row of service_units, and
-- service_unit_id on requests, categories, catalogue, assets, invoices, … is its company.
--
--   AVIT · Siyanaat · Tanzeem — all active. Each company's data is visible only inside that company.
--   ADMIN        runs one company (what Super Admin did before, for that company only).
--   ENGINEER     "Staff": works in one company, with one occupation (Engineer, Carpenter, Peon, …).
--   SUPER_ADMIN  appoints Admins, runs the global pages (sync, AI, time frames, email), enters any company.
--   People and places are shared by all companies.

-- ---------- companies ----------
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100;
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS tagline text;

INSERT INTO service_units (code, name, is_active) VALUES ('TANZEEM', 'Tanzeem', TRUE) ON CONFLICT (code) DO NOTHING;
UPDATE service_units SET is_active = TRUE WHERE code IN ('AVIT', 'SIYANAAT', 'TANZEEM');
UPDATE service_units s SET sort_order = d.ord, tagline = COALESCE(s.tagline, d.tagline)
  FROM (VALUES ('AVIT', 1, 'Audio-visual and IT help'),
               ('SIYANAAT', 2, 'Maintenance and repairs'),
               ('TANZEEM', 3, 'Stationery, courier and supplies')) d(code, ord, tagline)
 WHERE s.code = d.code;

-- ---------- occupations (each company keeps its own list; never deleted, switched off) ----------
CREATE TABLE IF NOT EXISTS occupations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  name             text        NOT NULL,
  sort_order       integer     NOT NULL DEFAULT 100,
  is_active        boolean     NOT NULL DEFAULT TRUE,
  created_by       bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT occupations_name_chk CHECK (char_length(name) BETWEEN 2 AND 60),
  CONSTRAINT occupations_id_unit_uq UNIQUE (id, service_unit_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS occupations_unit_name_uq ON occupations (service_unit_id, lower(name));
DROP TRIGGER IF EXISTS occupations_set_updated_at ON occupations;
CREATE TRIGGER occupations_set_updated_at BEFORE UPDATE ON occupations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO occupations (service_unit_id, name, sort_order)
SELECT s.id, d.name, d.ord
  FROM (VALUES ('AVIT', 'Engineer', 1),
               ('TANZEEM', 'Peon', 1),
               ('SIYANAAT', 'Electrician', 1), ('SIYANAAT', 'Carpenter', 2), ('SIYANAAT', 'Plumber', 3),
               ('SIYANAAT', 'AC Technician', 4), ('SIYANAAT', 'Mechanic', 5), ('SIYANAAT', 'Housekeeping', 6),
               ('SIYANAAT', 'Pest Control', 7), ('SIYANAAT', 'Painter', 8), ('SIYANAAT', 'Mason', 9),
               ('SIYANAAT', 'Gardener', 10)) d(code, name, ord)
  JOIN service_units s ON s.code = d.code
 WHERE NOT EXISTS (SELECT 1 FROM occupations o WHERE o.service_unit_id = s.id AND lower(o.name) = lower(d.name));

-- ---------- the one company an Admin / Staff member works for ----------
-- A row exists while the user holds ADMIN or ENGINEER. occupation_id: set while they hold ENGINEER,
-- and must be one of that company's occupations.
CREATE TABLE IF NOT EXISTS user_company (
  user_id          bigint      PRIMARY KEY REFERENCES users (id),
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  occupation_id    bigint,
  granted_by       bigint      REFERENCES users (id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_company_occupation_fk FOREIGN KEY (occupation_id, service_unit_id)
    REFERENCES occupations (id, service_unit_id)
);
CREATE INDEX IF NOT EXISTS user_company_unit_idx ON user_company (service_unit_id);
DROP TRIGGER IF EXISTS user_company_set_updated_at ON user_company;
CREATE TRIGGER user_company_set_updated_at BEFORE UPDATE ON user_company FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- user_service_units (Phase 4) is no longer used: kept, never read again.

ALTER TABLE user_change_log DROP CONSTRAINT IF EXISTS user_change_log_action_chk;
ALTER TABLE user_change_log ADD CONSTRAINT user_change_log_action_chk CHECK (action IN (
  'created', 'role_granted', 'role_removed', 'unit_tagged', 'unit_untagged',
  'profile_updated', 'password_reset', 'occupation_changed'
));

-- ---------- move today's people into the new model (first run only) ----------
DO $$
DECLARE
  avit  bigint;
  owner bigint;
BEGIN
  SELECT id INTO avit FROM service_units WHERE code = 'AVIT';

  -- Engineers → staff of the company they were tagged to (AVIT), occupation "Engineer".
  INSERT INTO user_company (user_id, service_unit_id)
  SELECT r.user_id, COALESCE((SELECT min(t.service_unit_id) FROM user_service_units t WHERE t.user_id = r.user_id), avit)
    FROM user_roles r WHERE r.role = 'ENGINEER'
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE user_company uc
     SET occupation_id = (SELECT o.id FROM occupations o WHERE o.service_unit_id = uc.service_unit_id ORDER BY o.sort_order, o.id LIMIT 1)
   WHERE uc.occupation_id IS NULL
     AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = uc.user_id AND r.role = 'ENGINEER');

  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE role = 'ADMIN') THEN
    -- Today's Super Admins → Admins of AVIT.
    INSERT INTO user_company (user_id, service_unit_id)
    SELECT user_id, avit FROM user_roles WHERE role = 'SUPER_ADMIN'
    ON CONFLICT (user_id) DO NOTHING;
    WITH added AS (
      INSERT INTO user_roles (user_id, role)
      SELECT r.user_id, 'ADMIN' FROM user_roles r
        JOIN user_company uc ON uc.user_id = r.user_id AND uc.service_unit_id = avit
       WHERE r.role = 'SUPER_ADMIN'
      ON CONFLICT (user_id, role) DO NOTHING
      RETURNING user_id
    )
    INSERT INTO user_change_log (user_id, action, detail)
    SELECT user_id, 'role_granted', '{"role": "ADMIN", "company": "AVIT", "source": "companies change"}'::jsonb FROM added;

    -- The project owner (ITS 30328701) is the Super Admin. If that account isn't in this database,
    -- today's Super Admins keep the role (nobody is locked out of the global pages).
    SELECT id INTO owner FROM users WHERE its_number = '30328701' AND is_active;
    IF owner IS NOT NULL THEN
      INSERT INTO user_roles (user_id, role) VALUES (owner, 'SUPER_ADMIN') ON CONFLICT (user_id, role) DO NOTHING;
      WITH gone AS (
        DELETE FROM user_roles WHERE role = 'SUPER_ADMIN' AND user_id <> owner RETURNING user_id
      )
      INSERT INTO user_change_log (user_id, action, detail)
      SELECT user_id, 'role_removed', '{"role": "SUPER_ADMIN", "source": "companies change"}'::jsonb FROM gone;
    END IF;
  END IF;
END $$;

-- ---------- notifications: which company each one is about ----------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE notifications n SET service_unit_id = r.service_unit_id FROM requests r
 WHERE r.id = n.request_id AND n.service_unit_id IS NULL;
UPDATE notifications SET role = 'ADMIN' WHERE role = 'SUPER_ADMIN';

-- ---------- uniqueness is per company now ----------
DROP INDEX IF EXISTS assets_tag_uq;
CREATE UNIQUE INDEX IF NOT EXISTS assets_unit_tag_uq ON assets (service_unit_id, upper(asset_tag));
CREATE INDEX IF NOT EXISTS assets_tag_idx ON assets (upper(asset_tag));

DROP INDEX IF EXISTS asset_categories_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_unit_name_uq ON asset_categories (service_unit_id, lower(name)) WHERE is_active;

DROP INDEX IF EXISTS catalogue_items_name_uq;
CREATE UNIQUE INDEX IF NOT EXISTS catalogue_items_unit_name_uq ON catalogue_items (service_unit_id, lower(name)) WHERE is_active;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_sha256_uq;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_unit_sha256_uq;
ALTER TABLE invoices ADD CONSTRAINT invoices_unit_sha256_uq UNIQUE (service_unit_id, file_sha256);

CREATE INDEX IF NOT EXISTS requests_unit_status_idx ON requests (service_unit_id, status);

-- Import / export logs belong to a company too.
ALTER TABLE asset_imports ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE asset_imports SET service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT') WHERE service_unit_id IS NULL;
ALTER TABLE asset_imports ALTER COLUMN service_unit_id SET NOT NULL;
ALTER TABLE inventory_exports ADD COLUMN IF NOT EXISTS service_unit_id bigint REFERENCES service_units (id);
UPDATE inventory_exports SET service_unit_id = (SELECT id FROM service_units WHERE code = 'AVIT') WHERE service_unit_id IS NULL;
ALTER TABLE inventory_exports ALTER COLUMN service_unit_id SET NOT NULL;
