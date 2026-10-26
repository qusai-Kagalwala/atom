-- 011_inventory.sql — places, asset categories, assets, asset history, import log (Phase 8).
-- Idempotent: safe to run again.
--   - One row per physical asset (per-asset inventory, ATOM_Decisions.md §17). Never deleted:
--     assets are retired, places and categories deactivated.
--   - Snipe-IT is the source until switch-over: the CSV import can be re-run; assets are matched
--     by asset tag. Assets added in ATOM have source 'atom'.

DO $$ BEGIN
  CREATE TYPE asset_status AS ENUM ('IN_STORE', 'IN_USE', 'IN_REPAIR', 'RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- places ----------
-- Room numbers are kept exactly as written. A letter after the room is the cubicle
-- (1615-C = room 1615, cubicle C). Building / floor are filled only when known.
CREATE TABLE IF NOT EXISTS places (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text        NOT NULL,
  room_no        text,
  cubicle        text,
  building       text,
  floor          text,
  notes          text,
  snipeit_name   text,                    -- the Snipe-IT location text this place came from
  is_active      boolean     NOT NULL DEFAULT TRUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT places_name_chk CHECK (char_length(name) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS places_snipeit_name_uq ON places (lower(snipeit_name)) WHERE snipeit_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS places_room_idx ON places (room_no);

DROP TRIGGER IF EXISTS places_set_updated_at ON places;
CREATE TRIGGER places_set_updated_at BEFORE UPDATE ON places FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- asset categories (+ the Snipe-IT names that map to them) ----------
CREATE TABLE IF NOT EXISTS asset_categories (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text        NOT NULL,
  service_unit_id  bigint      NOT NULL REFERENCES service_units (id),
  merged_into_id   bigint      REFERENCES asset_categories (id),
  is_active        boolean     NOT NULL DEFAULT TRUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_categories_name_chk CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_name_uq ON asset_categories (lower(name)) WHERE is_active;

-- A re-import keeps working after a category is renamed or merged in ATOM.
CREATE TABLE IF NOT EXISTS asset_category_aliases (
  alias        text   PRIMARY KEY,           -- lower-cased, trimmed Snipe-IT category name
  category_id  bigint NOT NULL REFERENCES asset_categories (id)
);

-- ---------- assets ----------
CREATE TABLE IF NOT EXISTS assets (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_tag           text         NOT NULL,
  name                text,
  category_id         bigint       NOT NULL REFERENCES asset_categories (id),
  manufacturer        text,
  model               text,
  model_no            text,
  serial              text,
  serial_needs_check  boolean      NOT NULL DEFAULT FALSE,   -- e.g. destroyed by Excel (1.23E+12)
  mac_address         text,
  ip_address          text,
  purchased_on        date,
  order_number        text,
  supplier            text,
  status              asset_status NOT NULL DEFAULT 'IN_STORE',
  place_id            bigint       REFERENCES places (id),
  holder_user_id      bigint       REFERENCES users (id),
  holder_unknown      boolean      NOT NULL DEFAULT FALSE,   -- in use, but not by a known ATOM user
  notes               text,
  service_unit_id     bigint       NOT NULL REFERENCES service_units (id),
  source              text         NOT NULL DEFAULT 'atom',
  snipeit_id          integer,
  imported_hash       text,         -- fingerprint of the last imported values (re-import: unchanged?)
  imported_at         timestamptz,
  edited_in_atom_at   timestamptz,  -- last change made in ATOM after the import
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT assets_tag_chk CHECK (char_length(asset_tag) BETWEEN 1 AND 60),
  CONSTRAINT assets_source_chk CHECK (source IN ('atom', 'snipeit')),
  CONSTRAINT assets_holder_chk CHECK (NOT (holder_user_id IS NOT NULL AND holder_unknown))
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_tag_uq ON assets (upper(asset_tag));
CREATE INDEX IF NOT EXISTS assets_category_idx ON assets (category_id);
CREATE INDEX IF NOT EXISTS assets_place_idx ON assets (place_id);
CREATE INDEX IF NOT EXISTS assets_holder_idx ON assets (holder_user_id) WHERE holder_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_status_idx ON assets (status);

DROP TRIGGER IF EXISTS assets_set_updated_at ON assets;
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- asset history ----------
CREATE TABLE IF NOT EXISTS asset_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id    bigint      NOT NULL REFERENCES assets (id),
  type        text        NOT NULL,
  actor_id    bigint      REFERENCES users (id),
  note        text,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_events_type_chk CHECK (type IN
    ('created', 'imported', 'reimported', 'edited', 'moved', 'assigned', 'returned', 'status')),
  CONSTRAINT asset_events_note_chk CHECK (note IS NULL OR char_length(note) <= 1000)
);
CREATE INDEX IF NOT EXISTS asset_events_asset_idx ON asset_events (asset_id, created_at, id);

-- ---------- import log ----------
CREATE TABLE IF NOT EXISTS asset_imports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name    text,
  file_sha256  text        NOT NULL,
  rows         integer     NOT NULL,
  summary      jsonb       NOT NULL,
  imported_by  bigint      REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
