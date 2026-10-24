-- 003_people.sql — departments, posts, status log, sync run log, name preference (Phase 3).
-- Idempotent: safe to run again.
-- The mirror table src.idarah_tafveez_current_yr is NOT created here: the sync builds it
-- from the view's own column list (ATOM_Decisions.md §4 rule 1).

-- ---------- users: extra profile fields ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_arabic    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_language  text NOT NULL DEFAULT 'en';

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_name_language_chk CHECK (name_language IN ('en', 'ar'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- departments (one per Idarah) ----------
CREATE TABLE IF NOT EXISTS departments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idarah_id        text        NOT NULL,          -- source key from the view
  name             text,
  name_arabic      text,
  category         text,
  category_arabic  text,
  email            text,
  is_active        boolean     NOT NULL DEFAULT TRUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT departments_idarah_id_uq UNIQUE (idarah_id)
);

DROP TRIGGER IF EXISTS departments_set_updated_at ON departments;
CREATE TRIGGER departments_set_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- user_posts (user × department × post) ----------
-- post / post_tbq use '' instead of NULL so the unique key works.
CREATE TABLE IF NOT EXISTS user_posts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        bigint      NOT NULL REFERENCES users (id),
  department_id  bigint      NOT NULL REFERENCES departments (id),
  post           text        NOT NULL DEFAULT '',
  post_tbq       text        NOT NULL DEFAULT '',
  post_id        text,
  post_category  text,
  post_abbrev    text,
  intercom       text,
  office_no      text,
  is_active      boolean     NOT NULL DEFAULT TRUE,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_posts_uq UNIQUE (user_id, department_id, post, post_tbq)
);

CREATE INDEX IF NOT EXISTS user_posts_department_idx ON user_posts (department_id) WHERE is_active;

-- ---------- user_status_log ----------
CREATE TABLE IF NOT EXISTS user_status_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id),
  is_active   boolean     NOT NULL,                 -- the NEW state
  source      text        NOT NULL,
  reason      text,
  changed_by  bigint      REFERENCES users (id),    -- NULL for sync / import
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_status_log_source_chk CHECK (source IN ('sync', 'import', 'super_admin', 'seed'))
);

CREATE INDEX IF NOT EXISTS user_status_log_user_idx ON user_status_log (user_id, created_at DESC);

-- ---------- src.sync_runs ----------
CREATE TABLE IF NOT EXISTS src.sync_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job           text        NOT NULL,               -- 'idarah'
  status        text        NOT NULL DEFAULT 'running',
  forced        boolean     NOT NULL DEFAULT FALSE,
  triggered_by  bigint      REFERENCES users (id),  -- NULL = Task Scheduler / CLI
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  source_rows   integer,
  valid_rows    integer,
  skipped_rows  integer,
  summary       jsonb,                              -- counts + skipped reasons
  message       text,
  CONSTRAINT sync_runs_status_chk CHECK (status IN ('running', 'success', 'blocked', 'failed'))
);

CREATE INDEX IF NOT EXISTS sync_runs_job_started_idx ON src.sync_runs (job, started_at DESC);
