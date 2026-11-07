-- 035_wifi_groups_hod_access.sql — Jamea Internet Access (decided 7 Nov 2026). Idempotent.
-- 1. Passes given together (one "Give" of 2+ passes) share give_group: they are taken back together only
--    ("Take back all"), never one by one. A single pass given to one person has no group.
-- 2. HOD access set by the Super Admin, on top of the Idarah posts (Masool):
--      grant  → this person is HOD of this department (any number of departments per person)
--      revoke → this person is NOT HOD of this department, even if their Idarah post says so
--    One row per person + department; removing the row undoes it (it is a setting, logged in wifi_log).
ALTER TABLE wifi_passes ADD COLUMN IF NOT EXISTS give_group uuid;
CREATE INDEX IF NOT EXISTS wifi_passes_give_group_idx ON wifi_passes (give_group) WHERE give_group IS NOT NULL;

CREATE TABLE IF NOT EXISTS wifi_hod_access (
  user_id        bigint      NOT NULL REFERENCES users (id),
  department_id  bigint      NOT NULL REFERENCES departments (id),
  kind           text        NOT NULL,
  set_by         bigint      REFERENCES users (id),
  set_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, department_id),
  CONSTRAINT wifi_hod_access_kind_chk CHECK (kind IN ('grant', 'revoke'))
);
CREATE INDEX IF NOT EXISTS wifi_hod_access_dept_idx ON wifi_hod_access (department_id);
