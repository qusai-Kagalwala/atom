-- 010_hr_staff.sql — second people source: dbo.Vw_User_Department_Details_New (Phase 3.1).
-- That view = HR employee master (Active = 1) UNION the current-year Idarah view, joined to
-- MST_Idarah_Table (department name, email, building, floor, room).
-- Idempotent: safe to run again. (Needs PostgreSQL 12+ for ADD VALUE inside a transaction.)

-- Employee-ID staff created from the HR list.
ALTER TYPE user_source ADD VALUE IF NOT EXISTS 'hr';

-- First password = employee ID → must be changed at first sign-in (decided 26 Oct 2026).
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT FALSE;

-- Department location + which view(s) currently list the department.
-- A department stays active while EITHER view lists it (the two syncs don't fight).
ALTER TABLE departments ADD COLUMN IF NOT EXISTS building       text;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS floor          text;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS room_no        text;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS in_idarah_view boolean NOT NULL DEFAULT TRUE;   -- existing rows came from it
ALTER TABLE departments ADD COLUMN IF NOT EXISTS in_hr_view     boolean NOT NULL DEFAULT FALSE;

-- Which departments a person belongs to according to the HR view (posts stay in user_posts).
CREATE TABLE IF NOT EXISTS user_departments (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint      NOT NULL REFERENCES users (id),
  department_id  bigint      NOT NULL REFERENCES departments (id),
  is_active      boolean     NOT NULL DEFAULT TRUE,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_departments_uq UNIQUE (user_id, department_id)
);

CREATE INDEX IF NOT EXISTS user_departments_user_idx ON user_departments (user_id) WHERE is_active;
