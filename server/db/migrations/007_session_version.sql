-- 007_session_version.sql — sign out other devices when a password changes (Phase 7.1).
-- Every login token carries the user's session_version ("sv"). Changing or resetting a password
-- bumps it, so tokens issued before the change stop working on their next request.
-- Tokens issued before this migration have no "sv" and count as version 0.
-- Idempotent: safe to run again.

ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
