-- 025_user_theme.sql — Appearance: each person's colour theme and light/dark choice (Nov 2026). Idempotent.
--   One row per person, written only when they change it. No row = they have not chosen: the app uses
--   whatever this device already shows (teal + light by default).
--   Kept in its own table on purpose: the session query (loadSessionUser) never reads it, so a server
--   that is running before this migration is applied still signs everyone in. Allowed values are checked
--   by the API (shared/themes.json), not here, so adding a theme later needs no migration.
CREATE TABLE IF NOT EXISTS user_theme (
  user_id    bigint      PRIMARY KEY REFERENCES users (id),
  theme      text        NOT NULL,
  mode       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_theme_values_chk CHECK (char_length(theme) BETWEEN 1 AND 32 AND char_length(mode) BETWEEN 1 AND 32)
);
