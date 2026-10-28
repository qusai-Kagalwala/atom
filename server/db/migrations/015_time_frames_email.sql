-- 015_time_frames_email.sql — priorities, time frames, overdue, email notifications (decided 28 Oct 2026).
-- Idempotent: safe to run again.
--   Priorities are High / Normal / Low (Urgent retired: existing Urgent → High; the enum value stays, unused).
--   Every ticket / service request gets a time frame from the moment it is raised (24/7 clock):
--     High 30 min – 2 h · Normal 2 – 4 h · Low 4 – 48 h   (Super Admin can change these)
--   "Done" = resolved / delivered (or rejected / closed). Past the end of the window = overdue
--   (Super Admins and the engineer are told once).
--   Email: every in-app notification to a person with an email address is also queued as an email
--   (when the Super Admin switch is on); a background sender works through the queue.

UPDATE requests SET priority = 'HIGH' WHERE priority::text = 'URGENT';

CREATE TABLE IF NOT EXISTS priority_targets (
  priority     request_priority PRIMARY KEY,
  min_minutes  integer     NOT NULL,
  max_minutes  integer     NOT NULL,
  updated_by   bigint,                     -- no FK: settings must survive any clean-up of users
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT priority_targets_range_chk CHECK (min_minutes >= 0 AND max_minutes >= min_minutes AND max_minutes <= 525600)
);
INSERT INTO priority_targets (priority, min_minutes, max_minutes) VALUES
  ('HIGH', 30, 120), ('NORMAL', 120, 240), ('LOW', 240, 2880)
ON CONFLICT (priority) DO NOTHING;

ALTER TABLE requests ADD COLUMN IF NOT EXISTS due_from timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS due_by timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz;

-- Existing requests get their window from when they were raised.
UPDATE requests r
   SET due_from = r.created_at + make_interval(mins => t.min_minutes),
       due_by   = r.created_at + make_interval(mins => t.max_minutes)
  FROM priority_targets t
 WHERE t.priority = r.priority AND r.due_by IS NULL;

CREATE INDEX IF NOT EXISTS requests_overdue_idx ON requests (due_by)
  WHERE overdue_notified_at IS NULL AND status NOT IN ('RESOLVED', 'CLOSED', 'REJECTED');

-- ---------- email ----------
CREATE TABLE IF NOT EXISTS notify_settings (
  id             smallint    PRIMARY KEY DEFAULT 1,
  email_enabled  boolean     NOT NULL DEFAULT FALSE,
  updated_by     bigint,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notify_settings_one_row CHECK (id = 1)
);
INSERT INTO notify_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- status: queued → sent | failed (after 3 tries). Bodies are kept for 90 days for the email log.
CREATE TABLE IF NOT EXISTS email_outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      REFERENCES users (id),
  to_email      text        NOT NULL,
  subject       text        NOT NULL,
  body_text     text        NOT NULL,
  request_id    bigint      REFERENCES requests (id),
  status        text        NOT NULL DEFAULT 'queued',
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  next_try_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  CONSTRAINT email_outbox_status_chk CHECK (status IN ('queued', 'sent', 'failed'))
);
CREATE INDEX IF NOT EXISTS email_outbox_queue_idx ON email_outbox (next_try_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS email_outbox_created_idx ON email_outbox (created_at DESC);
