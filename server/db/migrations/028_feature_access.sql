-- 028_feature_access.sql — Delegate access (decided 6 Nov 2026). Idempotent.
--   A company's Admin (or the Super Admin) gives single Admin features (Assign queue, Approvals, Inventory, …)
--   to a person on that company's staff. The person then has Admin powers for that feature only, in that
--   company only, whatever role they are using. Removing access sets revoked_at (rows are kept as history).
--   Feature keys are checked by the API (shared/roles.json "features"), so new features need no migration.
CREATE TABLE IF NOT EXISTS user_features (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id),
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  feature          text        NOT NULL,
  granted_by       bigint      REFERENCES users (id),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  revoked_by       bigint      REFERENCES users (id),
  revoked_at       timestamptz,
  CONSTRAINT user_features_feature_chk CHECK (feature ~ '^[a-z]{2,30}$')
);
-- One live grant per person, company and feature.
CREATE UNIQUE INDEX IF NOT EXISTS user_features_live_uq ON user_features (user_id, service_unit_id, feature) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_features_company_idx ON user_features (service_unit_id) WHERE revoked_at IS NULL;
