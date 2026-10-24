-- 004_service_units.sql — service units and engineer tags (Phase 4, ATOM_Decisions.md §7).
-- Idempotent: safe to run again.
--
-- A service unit is the team that does the work. Tickets, requests, catalogue items, assets,
-- FAQs and invoices will each carry a service_unit_id (later phases).
--   AVIT     — active (launch)
--   SIYANAAT — inactive: backend only, no front end yet

CREATE TABLE IF NOT EXISTS service_units (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text        NOT NULL,      -- stable key used in code and shared/statuses.json
  name        text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT TRUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_units_code_uq UNIQUE (code),
  CONSTRAINT service_units_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]*$')
);

DROP TRIGGER IF EXISTS service_units_set_updated_at ON service_units;
CREATE TRIGGER service_units_set_updated_at
  BEFORE UPDATE ON service_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed. Never overwrite later changes (e.g. Siyanaat switched on by hand).
INSERT INTO service_units (code, name, is_active) VALUES
  ('AVIT', 'AVIT', TRUE),
  ('SIYANAAT', 'Siyanaat', FALSE)
ON CONFLICT (code) DO NOTHING;

-- Engineers are tagged to the service units they work for (Super Admin manages this in Phase 5).
CREATE TABLE IF NOT EXISTS user_service_units (
  user_id          bigint      NOT NULL REFERENCES users (id),
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  granted_by       bigint      REFERENCES users (id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, service_unit_id)
);

CREATE INDEX IF NOT EXISTS user_service_units_unit_idx ON user_service_units (service_unit_id);
