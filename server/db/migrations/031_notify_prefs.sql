-- 031_notify_prefs.sql — How each person is notified (decided 6 Nov 2026). Idempotent.
--   notify_in_app  bell count, pop-ups and phone push. Off = notifications still go to the Notifications
--                  list, already marked read (a history), with no count, pop-up or push.
--   notify_email   email copies (also needs an email address and email switched on in Settings).
--   At least one stays on (checked by the API and here).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_in_app boolean NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT TRUE;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_notify_one_chk;
ALTER TABLE users ADD CONSTRAINT users_notify_one_chk CHECK (notify_in_app OR notify_email);
