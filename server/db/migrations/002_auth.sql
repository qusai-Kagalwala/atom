-- 002_auth.sql — users, roles and password-reset tokens (Phase 2).
-- Idempotent: safe to run again.
--
-- Employee-ID passwords are stored in PLAIN TEXT (client decision, 22 Oct 2026).
-- Rules: never SELECT * on users; legacy_password is read only by login / change / reset code;
-- never returned by any API, shown, exported or logged.
-- ITS users have no password in ATOM (checked by eJamaat only).

-- ---------- Enums ----------
DO $$ BEGIN
  CREATE TYPE login_type AS ENUM ('ITS', 'EMPLOYEE_ID');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_source AS ENUM ('idarah', 'legacy', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app_role AS ENUM ('EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- updated_at helper (reused by later tables) ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_type       login_type  NOT NULL,
  its_number       text,                  -- ITS users only: exactly 8 digits
  employee_id      text,                  -- EMPLOYEE_ID users only: digits, not 8 long
  name             text,
  email            text,
  mobile           text,
  legacy_password  text,                  -- EMPLOYEE_ID users only, plain text (see header)
  source           user_source NOT NULL DEFAULT 'manual',
  is_active        boolean     NOT NULL DEFAULT TRUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_identity_chk CHECK (
    (login_type = 'ITS'
      AND its_number ~ '^[0-9]{8}$'
      AND employee_id IS NULL
      AND legacy_password IS NULL)
    OR
    (login_type = 'EMPLOYEE_ID'
      AND employee_id ~ '^[0-9]+$'
      AND length(employee_id) <> 8
      AND its_number IS NULL
      AND legacy_password IS NOT NULL
      AND length(legacy_password) > 0)
  )
);

-- Users are never deleted, so a number stays reserved for its (possibly inactive) owner.
CREATE UNIQUE INDEX IF NOT EXISTS users_its_number_uq  ON users (its_number)  WHERE its_number  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_employee_id_uq ON users (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_active_idx ON users (is_active);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- user_roles ----------
-- A user can hold several roles; the active one travels in the JWT and is re-checked on every request.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     bigint      NOT NULL REFERENCES users (id),
  role        app_role    NOT NULL,
  granted_by  bigint      REFERENCES users (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role);

-- ---------- password_reset_tokens ----------
-- Employee-ID users only. Token stored as SHA-256 hex, single use, 30-minute expiry.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id),
  token_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_hash_chk CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_uq ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);
