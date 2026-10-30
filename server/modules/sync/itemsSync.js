// Support Log item lists → ATOM (companies step B, decided 30 Oct 2026). Called by:
//   - POST /Atom/api/sync/items        Super Admin → Sync status → "Support Log items" (Preview / Sync now)
//   - sync/run-items-sync.js           Windows Task Scheduler, once a night
//
// One run (same safety rules as the people syncs):
//   lock → read Item_Master + Main_Item_Master (named columns) → column check → plan → guard per company →
//   ONE transaction: refresh the two mirrors, apply each chosen company → log run → unlock.
//   Preview runs exactly the same steps and rolls back at the end (nothing saved, nothing logged).
//
//   AVIT / Siyanaat → problem list (categories > ticket_items > ticket_problems), matched on Item_Id.
//   Tanzeem        → catalogue items (price, pack size, stock), matched on Item_Id.
// Never deletes: rows missing from the Support Log or with Tag = 1 are switched off.
// "Keep changes made in ATOM" (default on): rows an Admin changed in ATOM since the last sync — and
// Tanzeem stock changed in ATOM (adjustments, deliveries) — are left as they are and listed.
const defaultPool = require('../../db/pool');
const { readSupportLogItems } = require('./sqlServer');
const { buildItemsPlan, checkCompanyGuard, CODES, DEFAULT_OCCUPATION } = require('./itemsPlan');
const { readMirrorColumns, compareColumns, loadMirror, ITEM_MIRROR, MAIN_ITEM_MIRROR } = require('./mirror');

const JOB = 'items';
const LOCK_KEY = 727308; // 727306 occupancy · 727307 FAQ import
const SAMPLE = 30;

class Rollback extends Error {}

// ---------- run log ----------
async function startRun(pool, { forced, triggeredBy }) {
  await pool.query(
    `UPDATE src.sync_runs SET status = 'failed', finished_at = now(), message = 'Interrupted (process stopped).'
      WHERE job = $1::text AND status = 'running'`,
    [JOB]
  );
  const { rows } = await pool.query(
    `INSERT INTO src.sync_runs (job, forced, triggered_by) VALUES ($1::text, $2::boolean, $3::bigint) RETURNING id`,
    [JOB, forced, triggeredBy]
  );
  return rows[0].id;
}

async function finishRun(pool, runId, { status, counts, summary, message }) {
  await pool.query(
    `UPDATE src.sync_runs SET status = $2::text, finished_at = now(), source_rows = $3::int, valid_rows = $4::int,
            skipped_rows = $5::int, summary = $6::jsonb, message = $7::text
      WHERE id = $1::bigint`,
    [runId, status, counts?.sourceRows ?? null, counts?.validRows ?? null, counts?.skippedRows ?? null,
      summary ? JSON.stringify(summary) : null, message ?? null]
  );
}

// Last good count per company (from earlier successful runs that included it).
async function lastGoodPerCompany(pool) {
  const { rows } = await pool.query(
    `SELECT summary FROM src.sync_runs WHERE job = $1::text AND status = 'success' ORDER BY started_at DESC LIMIT 30`,
    [JOB]
  );
  const out = {};
  for (const r of rows) {
    for (const [code, c] of Object.entries(r.summary?.companies || {})) {
      if (out[code] == null && Number.isInteger(c?.valid)) out[code] = c.valid;
    }
  }
  return out;
}

const changedInAtom = (row) => row.edited_in_atom_at && (!row.imported_at || row.edited_in_atom_at > row.imported_at);

// ---------- problem list (AVIT, Siyanaat) ----------
async function applyProblems(client, company, entries, { keepAtomEdits }) {
  const r = {
    problems: { created: 0, updated: 0, unchanged: 0, switchedOff: 0, missing: 0, kept: 0 },
    categoriesCreated: 0,
    itemsCreated: 0,
    kept: [],
  };

  // Categories: by the Support Log name they came from, else by name; created when missing.
  const { rows: cats } = await client.query(
    'SELECT id, name, legacy_name FROM categories WHERE service_unit_id = $1::bigint',
    [company.id]
  );
  const catBy = new Map();
  for (const c of cats) catBy.set(c.name.toLowerCase(), c.id);
  for (const c of cats) if (c.legacy_name) catBy.set(`legacy:${c.legacy_name.toLowerCase()}`, c.id);
  const { rows: occs } = await client.query(
    'SELECT id, name FROM occupations WHERE service_unit_id = $1::bigint AND is_active',
    [company.id]
  );
  const occBy = new Map(occs.map((o) => [o.name.toLowerCase(), o.id]));
  let order = 10;
  async function categoryId(e) {
    const found = catBy.get(`legacy:${e.category.toLowerCase()}`) || catBy.get(e.category.toLowerCase());
    if (found) return found;
    const occ = occBy.get(String(DEFAULT_OCCUPATION[e.category.toLowerCase()] || '').toLowerCase()) || null;
    const { rows } = await client.query(
      `INSERT INTO categories (service_unit_id, name, sort_order, source, legacy_name, occupation_id)
       VALUES ($1::bigint, $2::text, $3::int, 'supportlog', $4::text, $5::bigint) RETURNING id`,
      [company.id, e.category, (order += 10), e.category, occ]
    );
    r.categoriesCreated += 1;
    catBy.set(e.category.toLowerCase(), rows[0].id);
    catBy.set(`legacy:${e.category.toLowerCase()}`, rows[0].id);
    return rows[0].id;
  }

  // Items: by category + Support Log item name.
  const { rows: items } = await client.query(
    'SELECT id, category_id, name, legacy_name FROM ticket_items WHERE service_unit_id = $1::bigint',
    [company.id]
  );
  const itemBy = new Map();
  for (const i of items) itemBy.set(`${i.category_id}:${(i.legacy_name || i.name).toLowerCase()}`, i.id);
  async function itemId(catId, name) {
    const k = `${catId}:${name.toLowerCase()}`;
    if (itemBy.has(k)) return itemBy.get(k);
    const { rows } = await client.query(
      `INSERT INTO ticket_items (service_unit_id, category_id, name, legacy_name, source)
       VALUES ($1::bigint, $2::bigint, $3::text, $3::text, 'supportlog') RETURNING id`,
      [company.id, catId, name]
    );
    r.itemsCreated += 1;
    itemBy.set(k, rows[0].id);
    return rows[0].id;
  }

  const { rows: existing } = await client.query(
    `SELECT id, item_id, name, legacy_item_id, is_active, imported_hash, imported_at, edited_in_atom_at
       FROM ticket_problems WHERE service_unit_id = $1::bigint AND legacy_item_id IS NOT NULL`,
    [company.id]
  );
  const byLegacy = new Map(existing.map((p) => [p.legacy_item_id, p]));
  const inSource = new Set();

  for (const e of entries) {
    inSource.add(e.legacyId);
    const cur = byLegacy.get(e.legacyId);
    if (cur && cur.imported_hash === e.hash) {
      r.problems.unchanged += 1;
      continue;
    }
    if (cur && keepAtomEdits && changedInAtom(cur)) {
      r.problems.kept += 1;
      if (r.kept.length < SAMPLE) r.kept.push(`${e.item} > ${e.problem}`);
      continue;
    }
    const catId = await categoryId(e);
    const itId = await itemId(catId, e.item);
    if (!cur) {
      await client.query(
        `INSERT INTO ticket_problems (service_unit_id, item_id, name, legacy_item_id, source, is_active, imported_hash, imported_at)
         VALUES ($1::bigint, $2::bigint, $3::text, $4::int, 'supportlog', $5::boolean, $6::text, now())`,
        [company.id, itId, e.problem, e.legacyId, e.active, e.hash]
      );
      r.problems.created += 1;
    } else {
      await client.query(
        `UPDATE ticket_problems SET item_id = $2::bigint, name = $3::text, is_active = $4::boolean, imported_hash = $5::text,
                imported_at = now(), edited_in_atom_at = NULL
          WHERE id = $1::bigint`,
        [cur.id, itId, e.problem, e.active, e.hash]
      );
      if (cur.is_active && !e.active) r.problems.switchedOff += 1;
      else r.problems.updated += 1;
    }
  }

  // No longer in the Support Log → switched off (never deleted).
  const gone = existing.filter((p) => !inSource.has(p.legacy_item_id) && p.is_active).map((p) => p.id);
  if (gone.length) {
    await client.query(`UPDATE ticket_problems SET is_active = FALSE, imported_at = now() WHERE id = ANY($1::bigint[])`, [gone]);
    r.problems.missing = gone.length;
  }

  // Items / categories that came from the Support Log (and weren't changed in ATOM) follow their problems.
  await client.query(
    `UPDATE ticket_items i SET is_active = EXISTS (SELECT 1 FROM ticket_problems p WHERE p.item_id = i.id AND p.is_active)
      WHERE i.service_unit_id = $1::bigint AND i.source = 'supportlog' AND i.edited_in_atom_at IS NULL`,
    [company.id]
  );
  await client.query(
    `UPDATE categories c SET is_active = EXISTS (SELECT 1 FROM ticket_items i WHERE i.category_id = c.id AND i.is_active)
      WHERE c.service_unit_id = $1::bigint AND c.source = 'supportlog' AND c.edited_in_atom_at IS NULL`,
    [company.id]
  );
  return r;
}

// ---------- catalogue (Tanzeem) ----------
async function applyCatalogue(client, company, entries, { keepAtomEdits, actorId }) {
  const r = {
    catalogue: { created: 0, updated: 0, unchanged: 0, switchedOff: 0, missing: 0, kept: 0, stockKept: 0, stockSet: 0 },
    kept: [],
  };
  const { rows: existing } = await client.query(
    `SELECT id, name, legacy_item_id, is_active, stock, imported_hash, imported_at, edited_in_atom_at, stock_edited_at
       FROM catalogue_items WHERE service_unit_id = $1::bigint AND legacy_item_id IS NOT NULL`,
    [company.id]
  );
  const byLegacy = new Map(existing.map((c) => [c.legacy_item_id, c]));
  const inSource = new Set();

  // A name already used by another active item of the company gets the Support Log id added.
  async function freeName(name, selfId) {
    const { rows } = await client.query(
      `SELECT 1 FROM catalogue_items WHERE service_unit_id = $1::bigint AND is_active AND lower(name) = lower($2::text)
          AND id IS DISTINCT FROM $3::bigint`,
      [company.id, name, selfId ?? null]
    );
    return rows.length ? null : name;
  }

  async function setStock(id, from, to, reason) {
    await client.query('UPDATE catalogue_items SET stock = $2::int, stock_edited_at = NULL WHERE id = $1::bigint', [id, to]);
    if (to != null && to !== (from ?? 0)) {
      await client.query(
        `INSERT INTO stock_movements (catalogue_item_id, kind, change, stock_after, reason, actor_id)
         VALUES ($1::bigint, 'sync', $2::int, $3::int, $4::text, $5::bigint)`,
        [id, to - (from ?? 0), to, reason, actorId]
      );
    }
  }

  let order = 0;
  for (const e of entries) {
    inSource.add(e.legacyId);
    order += 1;
    const cur = byLegacy.get(e.legacyId);
    // Stock first (kept apart from the other fields): the Support Log figure, unless stock was
    // changed in ATOM (adjustments, deliveries) and edits are kept.
    if (cur && e.stock !== cur.stock) {
      if (keepAtomEdits && cur.stock_edited_at) r.catalogue.stockKept += 1;
      else {
        await setStock(cur.id, cur.stock, e.stock, 'From the Support Log');
        r.catalogue.stockSet += 1;
      }
    }
    if (cur && cur.imported_hash === e.hash) {
      r.catalogue.unchanged += 1;
      continue;
    }
    if (!cur) {
      const name = (e.active && !(await freeName(e.name))) ? `${e.name.slice(0, 110)} (#${e.legacyId})` : e.name;
      const { rows } = await client.query(
        `INSERT INTO catalogue_items (name, kind, group_name, price, pack_size, stock, service_unit_id, sort_order, is_active,
                                      legacy_item_id, source, imported_hash, imported_at)
         VALUES ($1::text, $2::text, $3::text, $4::numeric, $5::int, NULL, $6::bigint, $7::int, $8::boolean,
                 $9::int, 'supportlog', $10::text, now()) RETURNING id`,
        [name, e.kind, e.group, e.price, e.packSize, company.id, 1000 + order, e.active, e.legacyId, e.hash]
      );
      if (e.stock != null) await setStock(rows[0].id, 0, e.stock, 'From the Support Log');
      r.catalogue.created += 1;
      continue;
    }
    if (keepAtomEdits && changedInAtom(cur)) {
      r.catalogue.kept += 1;
      if (r.kept.length < SAMPLE) r.kept.push(cur.name);
      continue;
    }
    const name = (e.active && !(await freeName(e.name, cur.id))) ? `${e.name.slice(0, 110)} (#${e.legacyId})` : e.name;
    await client.query(
      `UPDATE catalogue_items SET name = $2::text, kind = $3::text, group_name = $4::text, price = $5::numeric, pack_size = $6::int,
              is_active = $7::boolean, imported_hash = $8::text, imported_at = now(), edited_in_atom_at = NULL
        WHERE id = $1::bigint`,
      [cur.id, name, e.kind, e.group, e.price, e.packSize, e.active, e.hash]
    );
    if (cur.is_active && !e.active) r.catalogue.switchedOff += 1;
    else r.catalogue.updated += 1;
  }

  const gone = existing.filter((c) => !inSource.has(c.legacy_item_id) && c.is_active).map((c) => c.id);
  if (gone.length) {
    await client.query('UPDATE catalogue_items SET is_active = FALSE, imported_at = now() WHERE id = ANY($1::bigint[])', [gone]);
    r.catalogue.missing = gone.length;
  }
  return r;
}

// ---------- the run ----------
// options: companies (codes, default all three) · keepAtomEdits (default true) · force · preview · triggeredBy
async function runItemsSync({
  companies = CODES,
  keepAtomEdits = true,
  force = false,
  preview = false,
  triggeredBy = null,
  readSource = readSupportLogItems,
  pool = defaultPool,
  log = console.log,
} = {}) {
  const chosen = CODES.filter((c) => companies.includes(c));
  if (!chosen.length) return { status: 'failed', message: 'Choose at least one company.' };

  const lockClient = await pool.connect();
  let runId = null;
  let counts = null;
  try {
    const { rows: lock } = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    if (!lock[0].ok) return { status: 'busy', message: 'Another items sync is already running.' };

    try {
      if (!preview) runId = await startRun(pool, { forced: force, triggeredBy });
      const fail = async (message) => {
        if (runId) await finishRun(pool, runId, { status: 'failed', counts, message });
        log(`Items sync FAILED. ${message}`);
        return { status: 'failed', runId, preview, message };
      };

      const source = await readSource();
      const cmpItems = compareColumns(source.items.columns, await readMirrorColumns(pool, ITEM_MIRROR));
      const cmpMain = compareColumns(source.main.columns, await readMirrorColumns(pool, MAIN_ITEM_MIRROR));
      const problems = [...cmpItems.problems.map((p) => `Item_Master: ${p}`), ...cmpMain.problems.map((p) => `Main_Item_Master: ${p}`)];
      if (problems.length) return fail(`Column check failed: ${problems.join(' ')}`);

      const plan = buildItemsPlan(source.items.rows, { companies: chosen });
      counts = plan.counts;
      const lastGood = await lastGoodPerCompany(pool);
      const blocked = chosen.map((code) => checkCompanyGuard(code, plan.companies[code].valid, lastGood[code], force)).filter((g) => !g.ok);
      if (blocked.length) {
        const message = blocked.map((g) => g.reason).join(' ');
        if (runId) await finishRun(pool, runId, { status: 'blocked', counts, message });
        log(`Items sync BLOCKED. ${message}`);
        return { status: 'blocked', runId, preview, message, counts };
      }

      const { rows: units } = await pool.query('SELECT id, code, name FROM service_units WHERE code = ANY($1::text[])', [chosen]);
      const unitBy = new Map(units.map((u) => [u.code, u]));

      const client = await pool.connect();
      let summary;
      try {
        await client.query('BEGIN');
        const mirrored = await loadMirror(client, cmpItems, source.items.rows, ITEM_MIRROR);
        await loadMirror(client, cmpMain, source.main.rows, MAIN_ITEM_MIRROR);
        summary = { mirroredRows: mirrored, mainItems: source.main.rows.length, keepAtomEdits, companies: {} };
        for (const code of chosen) {
          const c = plan.companies[code];
          const unit = unitBy.get(code);
          const base = {
            name: unit.name,
            rows: c.rows,
            valid: c.valid,
            inactive: c.inactive,
            duplicates: c.duplicates.length,
            duplicateSample: c.duplicates.slice(0, SAMPLE),
            errors: c.errors.slice(0, SAMPLE),
          };
          const applied = code === 'TANZEEM'
            ? await applyCatalogue(client, unit, c.entries, { keepAtomEdits, actorId: triggeredBy })
            : await applyProblems(client, unit, c.entries, { keepAtomEdits });
          summary.companies[code] = { ...base, ...applied };
        }
        if (preview) throw new Rollback();
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (!(err instanceof Rollback)) throw err;
      } finally {
        client.release();
      }

      if (preview) return { status: 'success', preview: true, counts, summary };
      await finishRun(pool, runId, { status: 'success', counts, summary, message: force ? 'Forced run (50% guard overridden).' : null });
      log(`Items sync OK: ${chosen.join(', ')} · ${counts.validRows}/${counts.sourceRows} rows`);
      return { status: 'success', preview: false, runId, counts, summary };
    } catch (err) {
      const message = `Sync error: ${err.message}`;
      if (runId) await finishRun(pool, runId, { status: 'failed', counts, message }).catch(() => {});
      log(`Items sync FAILED. ${message}`);
      return { status: 'failed', runId, preview, message };
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

module.exports = { runItemsSync, JOB, LOCK_KEY };
