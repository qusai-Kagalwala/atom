-- 024_push.sql — Phase 14: Web Push when the app is closed (decided 2 Nov 2026). Idempotent.
--   One row per person per device (browser / installed app). Removed (revoked_at) when the person turns it
--   off on that device or the push service says the subscription is gone (404 / 410). Never deleted.
--   The Super Admin's global switch (notify_settings.push_enabled) is off by default, like email.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES users (id),
  endpoint      text        NOT NULL,
  p256dh        text        NOT NULL,
  auth          text        NOT NULL,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  failures      integer     NOT NULL DEFAULT 0,
  revoked_at    timestamptz,
  CONSTRAINT push_subscriptions_endpoint_chk CHECK (char_length(endpoint) BETWEEN 10 AND 1000 AND endpoint LIKE 'https://%')
);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uq ON push_subscriptions (endpoint) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE notify_settings ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT FALSE;
