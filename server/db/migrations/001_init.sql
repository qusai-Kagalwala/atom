-- 001_init.sql — ATOM base setup.
-- Idempotent: safe to run again.

-- Mirror of SQL Server sources (e.g. src.idarah_tafveez_current_yr, src.sync_runs).
CREATE SCHEMA IF NOT EXISTS src;
