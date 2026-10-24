-- 005_user_admin.sql — audit trail for Super Admin changes to users (Phase 5).
-- Idempotent: safe to run again.
-- Activation/deactivation stays in user_status_log (§8). This table records everything else:
-- user created, role granted/removed, service-unit tag added/removed, profile edited,
-- password reset by a Super Admin (never the password itself).

CREATE TABLE IF NOT EXISTS user_change_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id),
  action      text        NOT NULL,
  detail      jsonb,
  changed_by  bigint      REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_change_log_action_chk CHECK (action IN (
    'created', 'role_granted', 'role_removed', 'unit_tagged', 'unit_untagged',
    'profile_updated', 'password_reset'
  ))
);

CREATE INDEX IF NOT EXISTS user_change_log_user_idx ON user_change_log (user_id, created_at DESC);

-- Search helpers for the Users page.
CREATE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));
CREATE INDEX IF NOT EXISTS users_source_idx ON users (source);
