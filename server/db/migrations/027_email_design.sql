-- 027_email_design.sql — styled HTML emails + the Super Admin's email design (decided 5 Nov 2026). Idempotent.
--   email_outbox.body_html: queued notification emails keep a plain-text copy (body_text) and the HTML.
--     Rows queued before this migration have no HTML and are sent as plain text.
--   email_design: one row, the look of every email (colours, style, header / footer wording) as JSON.
--     Checked by the API (services/emailDesign.js), so new fields need no migration. No row = default look.
--   email_design_log: every save / reset, with who did it.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS body_html text;

CREATE TABLE IF NOT EXISTS email_design (
  id          integer     PRIMARY KEY DEFAULT 1,
  design      jsonb       NOT NULL,
  updated_by  bigint      REFERENCES users (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_design_one_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS email_design_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text        NOT NULL,
  design      jsonb       NOT NULL,
  actor_id    bigint      REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_design_log_kind_chk CHECK (kind IN ('save', 'reset'))
);
CREATE INDEX IF NOT EXISTS email_design_log_time_idx ON email_design_log (created_at DESC);
