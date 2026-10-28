-- 017_admin_role.sql — the per-company Admin role (decided 28 Oct 2026). Idempotent.
-- On its own because a new enum value can't be used in the transaction that adds it;
-- 018_companies.sql uses it.
--   EMPLOYEE · ENGINEER (shown as "Staff" + their occupation) · ADMIN (one company) · SUPER_ADMIN (all companies)

ALTER TYPE app_role ADD VALUE IF NOT EXISTS 'ADMIN' BEFORE 'SUPER_ADMIN';
