-- 016_inventory_file.sql — inventory export / re-import (decided 28 Oct 2026). Idempotent.
--   Super Admin exports the inventory as .xlsx (to share and edit), then imports it back: matched by
--   asset tag, preview first, only the editable columns are applied. Every export and import is logged.

CREATE TABLE IF NOT EXISTS inventory_exports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exported_by  bigint      REFERENCES users (id),
  filters      jsonb       NOT NULL DEFAULT '{}',
  rows         integer     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- asset_imports now logs both kinds of import.
ALTER TABLE asset_imports ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'snipeit';
ALTER TABLE asset_imports DROP CONSTRAINT IF EXISTS asset_imports_kind_chk;
ALTER TABLE asset_imports ADD CONSTRAINT asset_imports_kind_chk CHECK (kind IN ('snipeit', 'atom_file'));
