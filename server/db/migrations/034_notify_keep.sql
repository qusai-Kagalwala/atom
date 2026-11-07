-- 034_notify_keep.sql — Each person chooses how long notifications are kept (decided 7 Nov 2026). Idempotent.
--   notify_keep_days  7 (1 week) | 15 | 30 (1 month) | NULL = never cleared (the default).
--   The background job (jobs.js, every minute) deletes that person's notifications older than this,
--   read or unread — an approved exception to "never hard-delete" (notifications are not records;
--   the ticket timeline keeps the history).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_keep_days int;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_notify_keep_chk;
ALTER TABLE users ADD CONSTRAINT users_notify_keep_chk CHECK (notify_keep_days IN (7, 15, 30));
