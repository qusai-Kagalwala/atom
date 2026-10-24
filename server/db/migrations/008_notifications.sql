-- 008_notifications.sql — in-app notifications (Phase 13).
-- Idempotent: safe to run again.
--
-- role: which active role the notification belongs to.
--   NULL        = about the user's own ticket → shown in every role
--   ENGINEER    = engineer work (assigned to you, requester replied, …)
--   SUPER_ADMIN = desk work (new ticket, resolved → ready to close, …)
-- The bell shows rows where role IS NULL OR role = the active role (access follows the active role).
-- Rows are never deleted by the app (marked read only).

CREATE TABLE IF NOT EXISTS notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id),
  role        app_role,
  type        text        NOT NULL,
  title       text        NOT NULL,
  body        text,
  link        text,
  request_id  bigint      REFERENCES requests (id),
  actor_id    bigint      REFERENCES users (id),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_title_chk CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT notifications_body_chk CHECK (body IS NULL OR char_length(body) <= 300)
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
