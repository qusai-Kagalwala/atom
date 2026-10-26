// Snipe-IT CSV → ATOM (Phase 8). Called by POST /Atom/api/inventory/import.
// Preview and commit run the SAME steps inside one transaction under one lock; a preview rolls
// back at the end, so its numbers are exactly what a commit would do.
//   - New tags → created (source 'snipeit'), "imported" history entry.
//   - Existing tags with identical values → unchanged.
//   - Existing tags with new values → updated ("reimported" entry listing the changed fields).
//     Snipe-IT is the master until switch-over: values changed in ATOM since the last import are
//     overwritten — unless keepAtomEdits, in which case those assets are skipped.
//   - A tag that was added by hand in ATOM is never overwritten (reported as a conflict).
//   - Assets in ATOM but not in this file are left alone (reported).
//   - Rows with errors block the import, unless skipErrors (then only those rows are skipped).
const crypto = require('crypto');
const defaultPool = require('../../db/pool');
const { parseCsv } = require('../../utils/csv');
const { buildSnipeitPlan } = require('./snipeitPlan');
const { HttpError } = require('../../utils/httpError');

const LOCK_KEY = 727305; // inventory import
const LIST_LIMIT = 200; // longest list returned in a report

const IMPORT_FIELDS = {
  name: 'name', manufacturer: 'manufacturer', model: 'model', model_no: 'modelNo', serial: 'serial',
  serial_needs_check: 'serialNeedsCheck', mac_address: 'macAddress', ip_address: 'ipAddress',
  purchased_on: 'purchasedOn', order_number: 'orderNumber', supplier: 'supplier', status: 'status',
  holder_unknown: 'holderUnknown', notes: 'notes',
};

// A user-facing 400 (the app's error handler shows HttpError messages as they are).
class ImportError extends HttpError {
  constructor(message, code) {
    super(400, message, code);
  }
}

async function avitUnitId(db) {
  const { rows } = await db.query(`SELECT id FROM service_units WHERE code = 'AVIT'`);
  if (!rows[0]) throw new ImportError('The AVIT service unit is missing.', 'no_service_unit');
  return rows[0].id;
}

// Category for a Snipe-IT name: alias (survives renames/merges in ATOM) → same-named active
// category → new category. Records the alias. → Map(snipeName lower → category id), created count
async function resolveCategories(db, plan, unitId) {
  const { rows: aliases } = await db.query(
    `SELECT a.alias, COALESCE(m.id, c.id) AS id
       FROM asset_category_aliases a
       JOIN asset_categories c ON c.id = a.category_id
       LEFT JOIN asset_categories m ON m.id = c.merged_into_id`
  );
  const byAlias = new Map(aliases.map((a) => [a.alias, a.id]));
  const { rows: active } = await db.query('SELECT id, name FROM asset_categories WHERE is_active');
  const byName = new Map(active.map((c) => [c.name.toLowerCase(), c.id]));
  const result = new Map();
  let created = 0;

  for (const cat of plan.categories) {
    let id = cat.snipeNames.map((n) => byAlias.get(n.toLowerCase())).find(Boolean) || byName.get(cat.name.toLowerCase());
    if (!id) {
      const { rows } = await db.query(
        `INSERT INTO asset_categories (name, service_unit_id) VALUES ($1::text, $2::bigint) RETURNING id`,
        [cat.name, unitId]
      );
      id = rows[0].id;
      byName.set(cat.name.toLowerCase(), id);
      created += 1;
    }
    for (const n of cat.snipeNames) {
      const alias = n.toLowerCase();
      if (!byAlias.has(alias)) {
        await db.query(
          `INSERT INTO asset_category_aliases (alias, category_id) VALUES ($1::text, $2::bigint) ON CONFLICT (alias) DO NOTHING`,
          [alias, id]
        );
        byAlias.set(alias, id);
      }
      result.set(alias, byAlias.get(alias));
    }
  }
  return { ids: result, created };
}

// Places by their Snipe-IT text. Existing places keep any edits made in ATOM. → Map(key → id), created
async function resolvePlaces(db, plan) {
  const { rows } = await db.query(`SELECT id, lower(snipeit_name) AS key FROM places WHERE snipeit_name IS NOT NULL`);
  const ids = new Map(rows.map((p) => [p.key, p.id]));
  let created = 0;
  for (const p of plan.places) {
    if (ids.has(p.key)) continue;
    const { rows: ins } = await db.query(
      `INSERT INTO places (name, room_no, cubicle, building, floor, snipeit_name)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text) RETURNING id`,
      [p.name, p.roomNo, p.cubicle, p.building, p.floor, p.snipeName]
    );
    ids.set(p.key, ins[0].id);
    created += 1;
  }
  // Fill building / floor from the department with the same room (Phase 3.1 data), where unknown.
  await db.query(
    `UPDATE places p SET building = COALESCE(p.building, d.building), floor = COALESCE(p.floor, d.floor)
       FROM (SELECT DISTINCT ON (room_no) room_no, building, floor FROM departments
              WHERE room_no IS NOT NULL ORDER BY room_no, is_active DESC, idarah_id) d
      WHERE p.room_no = d.room_no AND (p.building IS NULL OR p.floor IS NULL)
        AND (d.building IS NOT NULL OR d.floor IS NOT NULL)`
  );
  return { ids, created };
}

function rowValues(a, categoryId, placeId) {
  const out = { category_id: categoryId, place_id: placeId };
  for (const [col, key] of Object.entries(IMPORT_FIELDS)) out[col] = a[key];
  return out;
}

// Dates are read as text (purchased_on::text), so no time-zone shift can fake a change.
const sameValue = (x, y) => (x == null ? null : String(x)) === (y == null ? null : String(y));

async function applyAssets(db, plan, { categoryIds, placeIds, unitId, keepAtomEdits, userId }) {
  const { rows: existing } = await db.query(
    `SELECT id, upper(asset_tag) AS key, source, imported_hash, imported_at, edited_in_atom_at,
            category_id, place_id, holder_user_id,
            ${Object.keys(IMPORT_FIELDS).map((col) => (col === 'purchased_on' ? 'purchased_on::text AS purchased_on' : col)).join(', ')}
       FROM assets`
  );
  const byTag = new Map(existing.map((a) => [a.key, a]));
  const c = { created: 0, updated: 0, unchanged: 0, keptAtomEdits: 0, overwroteAtomEdits: 0 };
  const lists = { conflicts: [], overwritten: [], kept: [] };
  const inFile = new Set();

  for (const a of plan.assets) {
    const key = a.tag.toUpperCase();
    inFile.add(key);
    const categoryId = categoryIds.get(a.categorySnipeName.toLowerCase());
    const placeId = a.placeKey ? placeIds.get(a.placeKey) : null;
    const values = rowValues(a, categoryId, placeId);
    const cur = byTag.get(key);

    if (!cur) {
      const cols = ['asset_tag', 'service_unit_id', 'source', 'snipeit_id', 'imported_hash', 'imported_at', ...Object.keys(values)];
      const params = [a.tag, unitId, 'snipeit', a.snipeitId, a.hash, new Date(), ...Object.values(values)];
      const { rows } = await db.query(
        `INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        params
      );
      await db.query(
        `INSERT INTO asset_events (asset_id, type, actor_id, data) VALUES ($1::bigint, 'imported', $2::bigint, $3::jsonb)`,
        [rows[0].id, userId, JSON.stringify({ from: 'Snipe-IT', snipeitId: a.snipeitId })]
      );
      c.created += 1;
      continue;
    }
    if (cur.source !== 'snipeit') {
      lists.conflicts.push(a.tag);
      continue;
    }
    const editedInAtom = cur.edited_in_atom_at && (!cur.imported_at || cur.edited_in_atom_at > cur.imported_at);
    if (cur.imported_hash === a.hash && !editedInAtom) {
      c.unchanged += 1;
      continue;
    }
    if (editedInAtom && keepAtomEdits) {
      c.keptAtomEdits += 1;
      lists.kept.push(a.tag);
      continue;
    }
    const changed = Object.keys(values).filter((col) => !sameValue(cur[col], values[col]));
    if (cur.holder_user_id) changed.push('holder_user_id');
    if (!changed.length) {
      // Same values (e.g. only the Snipe-IT category spelling changed): refresh the fingerprint quietly.
      await db.query(
        `UPDATE assets SET imported_hash = $2::text, snipeit_id = $3, imported_at = now(), edited_in_atom_at = NULL WHERE id = $1::bigint`,
        [cur.id, a.hash, a.snipeitId]
      );
      c.unchanged += 1;
      continue;
    }
    const sets = Object.keys(values).map((col, i) => `${col} = $${i + 2}`);
    await db.query(
      `UPDATE assets SET ${sets.join(', ')}, holder_user_id = NULL, snipeit_id = $${sets.length + 2},
              imported_hash = $${sets.length + 3}, imported_at = now(), edited_in_atom_at = NULL
        WHERE id = $1::bigint`,
      [cur.id, ...Object.values(values), a.snipeitId, a.hash]
    );
    await db.query(
      `INSERT INTO asset_events (asset_id, type, actor_id, data) VALUES ($1::bigint, 'reimported', $2::bigint, $3::jsonb)`,
      [cur.id, userId, JSON.stringify({ from: 'Snipe-IT', changed })]
    );
    c.updated += 1;
    if (editedInAtom) {
      c.overwroteAtomEdits += 1;
      lists.overwritten.push(a.tag);
    }
  }

  const notInFile = existing.filter((a) => a.source === 'snipeit' && !inFile.has(a.key)).map((a) => a.key);
  return { ...c, ...lists, notInFile };
}

// csvBuffer → report. options: { commit, keepAtomEdits, skipErrors, fileName, userId }
async function runSnipeitImport(csvBuffer, { commit = false, keepAtomEdits = false, skipErrors = false, fileName = null, userId = null, pool = defaultPool } = {}) {
  let parsed;
  try {
    parsed = parseCsv(csvBuffer);
  } catch (err) {
    throw new ImportError(`Could not read the CSV: ${err.message}`, 'bad_csv');
  }
  if (!parsed.records.length) throw new ImportError('The CSV has no rows.', 'empty_csv');
  const plan = buildSnipeitPlan(parsed);
  if (plan.fatal) throw new ImportError(plan.fatal, 'not_snipeit');

  const blocked = plan.errors.length > 0 && !skipErrors;
  const report = {
    mode: commit ? 'commit' : 'preview',
    fileName,
    rows: plan.counts.rows,
    valid: plan.counts.valid,
    byStatus: plan.counts.byStatus,
    flagged: { serialNeedsCheck: plan.counts.serialNeedsCheck, holderUnknown: plan.counts.holderUnknown },
    categoryChanges: plan.categoryChanges,
    errors: plan.errors.slice(0, LIST_LIMIT),
    errorCount: plan.errors.length,
    warnings: plan.warnings.slice(0, LIST_LIMIT),
    warningCount: plan.warnings.length,
    blocked,
    saved: false,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const unitId = await avitUnitId(client);
    const cats = await resolveCategories(client, plan, unitId);
    const places = await resolvePlaces(client, plan);
    const result = await applyAssets(client, plan, {
      categoryIds: cats.ids, placeIds: places.ids, unitId, keepAtomEdits, userId,
    });
    Object.assign(report, {
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      keptAtomEdits: result.keptAtomEdits,
      overwroteAtomEdits: result.overwroteAtomEdits,
      newCategories: cats.created,
      newPlaces: places.created,
      conflicts: result.conflicts.slice(0, LIST_LIMIT),
      conflictCount: result.conflicts.length,
      overwritten: result.overwritten.slice(0, LIST_LIMIT),
      kept: result.kept.slice(0, LIST_LIMIT),
      notInFile: result.notInFile.slice(0, LIST_LIMIT),
      notInFileCount: result.notInFile.length,
    });

    if (!commit || blocked) {
      await client.query('ROLLBACK');
      return report;
    }
    await client.query(
      `INSERT INTO asset_imports (file_name, file_sha256, rows, summary, imported_by)
       VALUES ($1::text, $2::text, $3::int, $4::jsonb, $5::bigint)`,
      [
        fileName,
        crypto.createHash('sha256').update(csvBuffer).digest('hex'),
        plan.counts.rows,
        JSON.stringify({
          created: report.created, updated: report.updated, unchanged: report.unchanged, keptAtomEdits: report.keptAtomEdits,
          overwroteAtomEdits: report.overwroteAtomEdits, skippedErrors: skipErrors ? plan.errors.length : 0,
          newCategories: report.newCategories, newPlaces: report.newPlaces, notInFile: report.notInFileCount,
        }),
        userId,
      ]
    );
    await client.query('COMMIT');
    report.saved = true;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSnipeitImport, ImportError, LOCK_KEY };
