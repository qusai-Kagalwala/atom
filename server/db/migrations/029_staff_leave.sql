-- 029_staff_leave.sql — Staff leave (decided 6 Nov 2026). Idempotent.
--   Staff of a company apply for leave with dates; the company's Admin (or someone given "Staff leave")
--   approves or rejects it. Only APPROVED leave covering today makes someone "On leave": they can't be
--   assigned and auto-assign skips them. Dates are calendar days in the app's time zone (APP_TIME_ZONE).
--   Rows are never deleted: cancelled / rejected stay as history.
CREATE TABLE IF NOT EXISTS staff_leave (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint      NOT NULL REFERENCES users (id),
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  type             text        NOT NULL,
  start_date       date        NOT NULL,
  end_date         date        NOT NULL,
  note             text,
  status           text        NOT NULL DEFAULT 'PENDING',
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_by       bigint      REFERENCES users (id),
  decided_at       timestamptz,
  decision_note    text,
  cancelled_by     bigint      REFERENCES users (id),
  cancelled_at     timestamptz,
  CONSTRAINT staff_leave_type_chk CHECK (type IN ('LEAVE', 'SICK', 'TRAINING', 'OTHER')),
  CONSTRAINT staff_leave_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT staff_leave_dates_chk CHECK (end_date >= start_date AND end_date - start_date <= 90),
  CONSTRAINT staff_leave_note_chk CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE INDEX IF NOT EXISTS staff_leave_user_idx ON staff_leave (user_id, start_date DESC);
CREATE INDEX IF NOT EXISTS staff_leave_company_idx ON staff_leave (service_unit_id, status, start_date);
