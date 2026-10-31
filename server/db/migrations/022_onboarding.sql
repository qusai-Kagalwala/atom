-- 022_onboarding.sql — Phase 10: onboarding / offboarding (decided 31 Oct 2026). Idempotent.
--   Onboarding: the company's Admin assigns in-store assets to a person one at a time.
--   Offboarding: the Admin ticks the person's assets and marks them received in one go.
--   To recover: when someone is deactivated (Idarah / HR sync or the Super Admin) while still holding
--   assets, those assets are flagged; each company's Admins are told. Receiving or reassigning an asset
--   clears the flag; so does the person becoming active again.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS to_recover_since timestamptz;
CREATE INDEX IF NOT EXISTS assets_to_recover_idx ON assets (service_unit_id, to_recover_since) WHERE to_recover_since IS NOT NULL;

ALTER TABLE asset_events DROP CONSTRAINT IF EXISTS asset_events_type_chk;
ALTER TABLE asset_events ADD CONSTRAINT asset_events_type_chk CHECK (type IN
  ('created', 'imported', 'reimported', 'edited', 'moved', 'assigned', 'returned', 'status', 'to_recover', 'recover_cleared'));

-- Anyone already inactive who still holds assets: flag them now.
UPDATE assets a SET to_recover_since = now()
  FROM users u
 WHERE u.id = a.holder_user_id AND NOT u.is_active AND a.to_recover_since IS NULL AND a.status <> 'RETIRED';
