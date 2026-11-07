-- 032_contact_details.sql — People add / correct their own email and mobile (decided 7 Nov 2026). Idempotent.
-- The HR list and the Idarah view are missing many emails and mobiles. Anyone can now set their own in
-- Profile, and the Super Admin can set anyone's. Saved straight away (no confirmation code).
--   email_set_by / mobile_set_by  who last set the value by hand: 'self' | 'admin'. NULL = it came from a
--                                 sync or import. While set, the Idarah sync never overwrites that field.
--   Clearing a value by hand puts it back to NULL (the sync may fill it again).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_set_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_set_by text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_set_by_chk;
ALTER TABLE users ADD CONSTRAINT users_email_set_by_chk CHECK (email_set_by IN ('self', 'admin'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mobile_set_by_chk;
ALTER TABLE users ADD CONSTRAINT users_mobile_set_by_chk CHECK (mobile_set_by IN ('self', 'admin'));
