-- 019_problem_list_stock.sql — companies step B (decided 28–30 Oct 2026). Idempotent.
--   - Problem list per company: Category (categories) > Item (ticket_items) > Problem (ticket_problems).
--     Filled by the Support Log items sync (Item_Master: company 1 AVIT, 2 Siyanaat) and edited by Admins.
--   - Each category can be linked to an occupation; with the company's auto-assign switched on, a new
--     ticket in that category goes straight to a staff member of that occupation.
--   - Tanzeem's request catalogue (company 3): price, pack size, stock, stock movements.
--   - Never deleted: rows are switched off.

-- ---------- categories: occupation link, source ----------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS occupation_id bigint REFERENCES occupations (id);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'atom';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS legacy_name text;          -- the Support Log category it came from
ALTER TABLE categories ADD COLUMN IF NOT EXISTS edited_in_atom_at timestamptz;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_source_chk;
ALTER TABLE categories ADD CONSTRAINT categories_source_chk CHECK (source IN ('atom', 'supportlog'));

-- Siyanaat and Tanzeem need at least one category to raise a ticket before the first sync.
INSERT INTO categories (service_unit_id, name, sort_order)
SELECT s.id, 'Other', 999 FROM service_units s WHERE s.code IN ('SIYANAAT', 'TANZEEM')
ON CONFLICT (service_unit_id, name) DO NOTHING;

-- ---------- items and problems ----------
CREATE TABLE IF NOT EXISTS ticket_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id    bigint      NOT NULL REFERENCES service_units (id),
  category_id        bigint      NOT NULL REFERENCES categories (id),
  name               text        NOT NULL,
  legacy_name        text,                           -- Support Log item name (re-sync matches on it)
  source             text        NOT NULL DEFAULT 'atom',
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT TRUE,
  edited_in_atom_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_items_name_chk CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT ticket_items_source_chk CHECK (source IN ('atom', 'supportlog'))
);
CREATE INDEX IF NOT EXISTS ticket_items_category_idx ON ticket_items (category_id, sort_order, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ticket_items_legacy_uq ON ticket_items (category_id, lower(legacy_name)) WHERE legacy_name IS NOT NULL;
DROP TRIGGER IF EXISTS ticket_items_set_updated_at ON ticket_items;
CREATE TRIGGER ticket_items_set_updated_at BEFORE UPDATE ON ticket_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS ticket_problems (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_unit_id    bigint      NOT NULL REFERENCES service_units (id),
  item_id            bigint      NOT NULL REFERENCES ticket_items (id),
  name               text        NOT NULL,
  legacy_item_id     integer,                        -- Item_Master.Item_Id (per company)
  source             text        NOT NULL DEFAULT 'atom',
  sort_order         integer     NOT NULL DEFAULT 100,
  is_active          boolean     NOT NULL DEFAULT TRUE,
  imported_hash      text,
  imported_at        timestamptz,
  edited_in_atom_at  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_problems_name_chk CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT ticket_problems_source_chk CHECK (source IN ('atom', 'supportlog'))
);
CREATE INDEX IF NOT EXISTS ticket_problems_item_idx ON ticket_problems (item_id, sort_order, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ticket_problems_legacy_uq ON ticket_problems (service_unit_id, legacy_item_id) WHERE legacy_item_id IS NOT NULL;
DROP TRIGGER IF EXISTS ticket_problems_set_updated_at ON ticket_problems;
CREATE TRIGGER ticket_problems_set_updated_at BEFORE UPDATE ON ticket_problems FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What the ticket is about: item and problem from the list, or "Other" with the person's own words.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS ticket_item_id bigint REFERENCES ticket_items (id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS ticket_problem_id bigint REFERENCES ticket_problems (id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS problem_text text;
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_problem_text_chk;
ALTER TABLE requests ADD CONSTRAINT requests_problem_text_chk CHECK (problem_text IS NULL OR char_length(problem_text) <= 200);

-- ---------- auto-assign (per company) ----------
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS auto_assign boolean NOT NULL DEFAULT FALSE;
ALTER TABLE service_units ADD COLUMN IF NOT EXISTS auto_assign_set boolean NOT NULL DEFAULT FALSE; -- an Admin chose it
UPDATE service_units SET auto_assign = TRUE WHERE code = 'SIYANAAT' AND NOT auto_assign_set;

-- ---------- Tanzeem catalogue: price, pack, stock ----------
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS group_name text;          -- e.g. Stationery, Courier Service
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS price numeric(12,2);      -- approximate, per unit requested
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS pack_size integer;        -- pieces per pack (Qty_Multiples)
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS stock integer;            -- NULL = not tracked
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS legacy_item_id integer;
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'atom';
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS imported_hash text;
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS imported_at timestamptz;
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS edited_in_atom_at timestamptz;
ALTER TABLE catalogue_items ADD COLUMN IF NOT EXISTS stock_edited_at timestamptz; -- stock changed in ATOM (adjust / delivery)
ALTER TABLE catalogue_items DROP CONSTRAINT IF EXISTS catalogue_items_kind_chk;
ALTER TABLE catalogue_items ADD CONSTRAINT catalogue_items_kind_chk CHECK (kind IN ('physical', 'software', 'service', 'supply'));
ALTER TABLE catalogue_items DROP CONSTRAINT IF EXISTS catalogue_items_source_chk;
ALTER TABLE catalogue_items ADD CONSTRAINT catalogue_items_source_chk CHECK (source IN ('atom', 'supportlog'));
ALTER TABLE catalogue_items DROP CONSTRAINT IF EXISTS catalogue_items_stock_chk;
ALTER TABLE catalogue_items ADD CONSTRAINT catalogue_items_stock_chk CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE catalogue_items DROP CONSTRAINT IF EXISTS catalogue_items_name_chk;
ALTER TABLE catalogue_items ADD CONSTRAINT catalogue_items_name_chk CHECK (char_length(name) BETWEEN 2 AND 120);
CREATE UNIQUE INDEX IF NOT EXISTS catalogue_items_legacy_uq ON catalogue_items (service_unit_id, legacy_item_id) WHERE legacy_item_id IS NOT NULL;

ALTER TABLE request_items ADD COLUMN IF NOT EXISTS unit_price numeric(12,2);   -- the price when it was requested
ALTER TABLE request_items DROP CONSTRAINT IF EXISTS request_items_kind_chk;
ALTER TABLE request_items ADD CONSTRAINT request_items_kind_chk CHECK (kind IN ('physical', 'software', 'service', 'supply'));

-- Every stock change: sync, adjust (Admin, reason required), delivery (request item).
CREATE TABLE IF NOT EXISTS stock_movements (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  catalogue_item_id  bigint      NOT NULL REFERENCES catalogue_items (id),
  kind               text        NOT NULL,
  change             integer     NOT NULL,
  stock_after        integer     NOT NULL,
  reason             text,
  request_item_id    bigint      REFERENCES request_items (id),
  actor_id           bigint      REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_kind_chk CHECK (kind IN ('sync', 'adjust', 'delivery')),
  CONSTRAINT stock_movements_reason_chk CHECK (reason IS NULL OR char_length(reason) <= 500)
);
CREATE INDEX IF NOT EXISTS stock_movements_item_idx ON stock_movements (catalogue_item_id, created_at DESC, id DESC);
