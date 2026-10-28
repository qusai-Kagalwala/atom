// Inventory export → edit → re-import (Super Admin, decided 28 Oct 2026).
//   Export: .xlsx of the filtered list, every cell text (serials / tags stay exact), editable columns
//   white, read-only grey; a hidden "About" sheet records when and by whom it was exported.
//   Import: matched by Asset tag; preview first (same steps, rolled back). For the editable columns,
//   what the file says is what is saved (an emptied cell clears the field). Assets changed in ATOM
//   after the export are skipped unless "overwrite" is ticked. New tags become new in-store assets
//   (can be switched off). Status, assignment and retiring are never changed by the file.
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const defaultPool = require('../../db/pool');
const { HttpError } = require('../../utils/httpError');
const inv = require('./inventory.service');

const MAX_ROWS = 20000;
const SHEET = 'Inventory';
const ABOUT = 'About';
const bad = (message, code) => new HttpError(400, message, code);
const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

class Rollback extends Error {}

// [key, header, width, editable]
const COLUMNS = [
  ['tag', 'Asset tag', 22, false],
  ['name', 'Name', 28, true],
  ['category', 'Category', 22, true],
  ['manufacturer', 'Manufacturer', 18, true],
  ['model', 'Model', 22, true],
  ['modelNo', 'Model no.', 16, true],
  ['serial', 'Serial', 22, true],
  ['macAddress', 'MAC', 18, true],
  ['ipAddress', 'IP', 16, true],
  ['purchasedOn', 'Purchase date (YYYY-MM-DD)', 16, true],
  ['orderNumber', 'Order no.', 14, true],
  ['supplier', 'Supplier', 20, true],
  ['notes', 'Notes', 30, true],
  ['room', 'Room', 10, true],
  ['cubicle', 'Cubicle', 9, true],
  ['placeName', 'Place name', 26, true],
  ['status', 'Status (read only)', 14, false],
  ['assignedTo', 'Assigned to (read only)', 24, false],
  ['personId', 'ITS / Employee ID (read only)', 16, false],
  ['sitting', 'Sitting at this place (read only)', 28, false],
  ['serialCheck', 'Serial needs checking (read only)', 12, false],
  ['source', 'Source (read only)', 10, false],
  ['updatedAt', 'Last updated (read only)', 20, false],
];
const EDITABLE = COLUMNS.filter((c) => c[3]).map((c) => c[0]);
const STATUS_LABEL = { IN_STORE: 'In store', IN_USE: 'In use', IN_REPAIR: 'In repair', RETIRED: 'Retired' };
const FIELD_COL = { name: 'name', manufacturer: 'manufacturer', model: 'model', modelNo: 'model_no', serial: 'serial', macAddress: 'mac_address',
  ipAddress: 'ip_address', purchasedOn: 'purchased_on', orderNumber: 'order_number', supplier: 'supplier', notes: 'notes' };
const LABEL = Object.fromEntries(COLUMNS.map(([k, h]) => [k, h.replace(/ \(.*\)$/, '')]));

// ---------- export ----------
async function exportInventory(user, filters = {}, { pool = defaultPool } = {}) {
  const { filter, params } = inv.assetFilter(filters);
  const { rows } = await pool.query(
    `SELECT x.*, (SELECT string_agg(COALESCE(u.name, 'Employee ' || u.employee_id), ', ' ORDER BY u.name)
                    FROM place_occupants o JOIN users u ON u.id = o.user_id
                   WHERE o.is_active AND u.is_active AND o.room_no = x.place->>'room_no'
                     AND (COALESCE(x.place->>'cubicle', '') = '' OR o.cubicle = x.place->>'cubicle')) AS sitting
       FROM (${inv.ASSET_SELECT} ${filter}) x
      ORDER BY upper(x.asset_tag) LIMIT ${MAX_ROWS + 1}`,
    params
  );
  if (rows.length > MAX_ROWS) throw bad(`More than ${MAX_ROWS} assets — narrow the filters.`, 'too_many');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'ATOM';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(([key, header, width]) => ({ key, header, width, style: { numFmt: '@' } }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  COLUMNS.forEach(([, , , editable], i) => {
    head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: editable ? 'FFE2F0EC' : 'FFE0D6C8' } };
  });
  for (const a of rows) {
    const h = a.holder;
    const r = ws.addRow({
      tag: a.asset_tag, name: a.name, category: a.category_name, manufacturer: a.manufacturer, model: a.model, modelNo: a.model_no,
      serial: a.serial, macAddress: a.mac_address, ipAddress: a.ip_address, purchasedOn: a.purchased_on_text, orderNumber: a.order_number,
      supplier: a.supplier, notes: a.notes, room: a.place?.room_no, cubicle: a.place?.cubicle, placeName: a.place?.name,
      status: STATUS_LABEL[a.status] || a.status,
      assignedTo: h ? h.name : a.holder_unknown ? 'Not known yet' : '',
      personId: h ? h.itsNumber || h.employeeId : '',
      sitting: a.sitting, serialCheck: a.serial_needs_check ? 'Yes' : '', source: a.source === 'snipeit' ? 'Snipe-IT' : 'ATOM',
      updatedAt: new Date(a.updated_at).toISOString().replace('T', ' ').slice(0, 16),
    });
    r.eachCell({ includeEmpty: true }, (cell, n) => {
      cell.value = cell.value == null ? '' : String(cell.value);
      cell.numFmt = '@';
      if (!COLUMNS[n - 1][3]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0EBE0' } };
    });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

  const exportedAt = new Date().toISOString();
  const about = wb.addWorksheet(ABOUT, { state: 'hidden' });
  about.addRows([
    ['ATOM inventory export', ''],
    ['Exported at (UTC)', exportedAt],
    ['Exported by', user.name || String(user.id)],
    ['Rows', String(rows.length)],
    ['Filters', JSON.stringify(filters)],
    ['How to use', 'Edit the white columns, keep the Asset tag, then import this file in ATOM → Inventory → Import. Grey columns are ignored.'],
  ]);

  await pool.query('INSERT INTO inventory_exports (exported_by, filters, rows) VALUES ($1::bigint, $2::jsonb, $3::int)', [user.id, JSON.stringify(filters), rows.length]);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), rows: rows.length, fileName: `ATOM-inventory-${exportedAt.slice(0, 10)}.xlsx` };
}

// ---------- read the file ----------
const cellText = (cell) => {
  const v = cell?.value;
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return clean(v.text ?? v.result ?? (Array.isArray(v.richText) ? v.richText.map((t) => t.text).join('') : ''));
  return String(v).trim();
};

async function readFile(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw bad('This is not an Excel (.xlsx) file.', 'bad_file');
  }
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw bad('This file has no "Inventory" sheet. Export from ATOM first, edit that file, then import it.', 'bad_file');
  const header = ws.getRow(1);
  const index = {};
  header.eachCell((cell, n) => {
    const col = COLUMNS.find(([, h]) => h.toLowerCase() === cellText(cell).toLowerCase());
    if (col) index[col[0]] = n;
  });
  const missing = ['tag', ...EDITABLE].filter((k) => !index[k]).map((k) => COLUMNS.find((c) => c[0] === k)[1]);
  if (missing.length) throw bad(`Missing column(s): ${missing.join(', ')}. Don't rename or delete columns.`, 'bad_columns');

  const about = wb.getWorksheet(ABOUT);
  let exportedAt = null;
  if (about) {
    const v = cellText(about.getRow(2).getCell(2));
    if (v && !Number.isNaN(Date.parse(v))) exportedAt = new Date(v);
  }
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = { rowNumber: n };
    for (const [k, i] of Object.entries(index)) r[k] = cellText(row.getCell(i));
    if (Object.values(r).some((v, i) => i > 0 && v !== '')) rows.push(r);
  });
  if (rows.length > MAX_ROWS) throw bad(`More than ${MAX_ROWS} rows.`, 'too_many');
  return { rows, exportedAt };
}

// ---------- import ----------
async function importInventory(buffer, { commit = false, overwrite = false, allowNew = true, skipErrors = false, fileName = null, userId, pool = defaultPool } = {}) {
  const { rows, exportedAt } = await readFile(buffer);
  if (!rows.length) throw bad('The file has no asset rows.', 'empty_file');

  const report = {
    committed: false, exportedAt, rows: rows.length, updated: 0, created: 0, unchanged: 0, newPlaces: 0,
    changes: [], clears: 0, changedSinceExport: [], newTags: [], newSkipped: [], errors: [],
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727305)'); // same lock as the Snipe-IT import
    const { rows: cats } = await client.query(
      `SELECT lower(name) AS k, id FROM asset_categories WHERE is_active
       UNION SELECT al.alias, COALESCE(c.merged_into_id, c.id) FROM asset_category_aliases al JOIN asset_categories c ON c.id = al.category_id`
    );
    const catId = new Map(cats.map((c) => [c.k, String(c.id)]));
    const { rows: unit } = await client.query(`SELECT id FROM service_units WHERE code = 'AVIT'`);
    const seen = new Set();

    for (const r of rows) {
      const tag = clean(r.tag);
      const err = (message) => report.errors.push({ row: r.rowNumber, tag: tag || null, message });
      if (!tag) { err('Asset tag is empty.'); continue; }
      if (tag.length > 60) { err('Asset tag is longer than 60 characters.'); continue; }
      if (seen.has(tag.toUpperCase())) { err('This asset tag appears twice in the file.'); continue; }
      seen.add(tag.toUpperCase());
      const categoryId = catId.get(clean(r.category).toLowerCase());
      if (!categoryId) { err(r.category ? `Unknown category "${r.category}".` : 'Category is empty.'); continue; }
      let fields;
      try {
        fields = inv.readFields({
          name: r.name, manufacturer: r.manufacturer, model: r.model, modelNo: r.modelNo, serial: r.serial, macAddress: r.macAddress,
          ipAddress: r.ipAddress, purchasedOn: r.purchasedOn, orderNumber: r.orderNumber, supplier: r.supplier, notes: r.notes,
        });
      } catch (e) {
        err(e.message);
        continue;
      }
      const room = clean(r.room);
      const cubicle = clean(r.cubicle).toUpperCase();
      const placeName = clean(r.placeName);
      if (room.length > 20 || cubicle.length > 4 || placeName.length > 120) { err('Room, cubicle or place name is too long.'); continue; }
      if (cubicle && !room) { err('A cubicle needs a room.'); continue; }

      // eslint-disable-next-line no-await-in-loop
      const placeId = await resolvePlace(client, { room, cubicle, placeName }, report);
      // eslint-disable-next-line no-await-in-loop
      const { rows: found } = await client.query(
        `SELECT a.*, a.purchased_on::text AS purchased_on_text FROM assets a WHERE upper(a.asset_tag) = upper($1::text) FOR UPDATE`,
        [tag]
      );
      const a = found[0];
      if (!a) {
        if (!allowNew) { report.newSkipped.push(tag); continue; }
        const cols = ['asset_tag', 'category_id', 'place_id', 'service_unit_id', 'source', ...Object.keys(fields)];
        const vals = [tag, categoryId, placeId, unit[0].id, 'atom', ...Object.values(fields)];
        // eslint-disable-next-line no-await-in-loop
        const { rows: ins } = await client.query(
          `INSERT INTO assets (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          vals
        );
        // eslint-disable-next-line no-await-in-loop
        await inv.addEvent(client, ins[0].id, 'created', userId, { note: 'Added from inventory file' });
        report.created += 1;
        report.newTags.push(tag);
        continue;
      }

      const next = { ...fields, category_id: categoryId, place_id: placeId };
      const changed = Object.keys(next).filter((col) => {
        const cur = col === 'purchased_on' ? a.purchased_on_text : a[col];
        if (col === 'serial_needs_check') return false; // only cleared by a newly typed serial, below
        return String(cur ?? '') !== String(next[col] ?? '');
      });
      if (changed.includes('serial') && next.serial) changed.push('serial_needs_check');
      if (!changed.length) { report.unchanged += 1; continue; }
      if (exportedAt && new Date(a.updated_at) > exportedAt && !overwrite) {
        report.changedSinceExport.push({ tag: a.asset_tag, updatedAt: a.updated_at });
        continue;
      }
      const sets = changed.map((col, i) => `${col} = $${i + 2}`);
      // eslint-disable-next-line no-await-in-loop
      await client.query(`UPDATE assets SET ${sets.join(', ')} WHERE id = $1::bigint`, [a.id, ...changed.map((c) => (c === 'serial_needs_check' ? false : next[c]))]);
      // eslint-disable-next-line no-await-in-loop
      await inv.markEdited(client, a);
      // eslint-disable-next-line no-await-in-loop
      await inv.addEvent(client, a.id, 'edited', userId, { note: 'Updated from inventory file', data: { fields: changed.filter((c) => c !== 'serial_needs_check') } });
      report.updated += 1;
      const shown = changed.filter((c) => c !== 'serial_needs_check');
      const clears = shown.filter((c) => !['category_id', 'place_id'].includes(c) && next[c] == null && a[c] != null);
      report.clears += clears.length;
      if (report.changes.length < 300) {
        report.changes.push({
          tag: a.asset_tag,
          fields: shown.map((c) => {
            const key = Object.keys(FIELD_COL).find((k) => FIELD_COL[k] === c);
            if (c === 'category_id') return { field: 'Category', to: r.category };
            if (c === 'place_id') return { field: 'Place', to: [room && `Room ${room}`, cubicle && `Cubicle ${cubicle}`, !room && placeName].filter(Boolean).join(' · ') || '(none)' };
            return { field: LABEL[key] || c, from: c === 'purchased_on' ? a.purchased_on_text : a[c], to: next[c] };
          }),
        });
      }
    }

    if (report.errors.length && !skipErrors && commit) {
      throw new HttpError(400, `${report.errors.length} row(s) have errors. Fix them, or tick "skip rows with errors".`, 'row_errors');
    }
    if (!commit) throw new Rollback();
    await client.query(
      `INSERT INTO asset_imports (kind, file_name, file_sha256, rows, summary, imported_by) VALUES ('atom_file', $1::text, $2::text, $3::int, $4::jsonb, $5::bigint)`,
      [fileName, crypto.createHash('sha256').update(buffer).digest('hex'), rows.length,
        JSON.stringify({ updated: report.updated, created: report.created, unchanged: report.unchanged, errors: report.errors.length,
          changedSinceExport: report.changedSinceExport.length, exportedAt }), userId]
    );
    await client.query('COMMIT');
    report.committed = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!(err instanceof Rollback)) throw err;
  } finally {
    client.release();
  }
  return report;
}

// Room + cubicle → that place (or a new one); room only → the whole-room place; place name only →
// the place with that name. All empty → no place.
async function resolvePlace(db, { room, cubicle, placeName }, report) {
  if (!room && !placeName) return null;
  let found;
  if (room) {
    ({ rows: found } = await db.query(
      `SELECT id FROM places WHERE is_active AND room_no = $1::text AND COALESCE(upper(cubicle), '') = $2::text ORDER BY id LIMIT 1`,
      [room, cubicle]
    ));
  } else {
    ({ rows: found } = await db.query('SELECT id FROM places WHERE is_active AND lower(name) = lower($1::text) ORDER BY id LIMIT 1', [placeName]));
  }
  if (found[0]) return found[0].id;
  const name = placeName || (cubicle ? `${room}-${cubicle}` : `Room ${room}`);
  const { rows } = await db.query(
    `INSERT INTO places (name, room_no, cubicle) VALUES ($1::text, $2::text, $3::text) RETURNING id`,
    [name, room || null, cubicle || null]
  );
  report.newPlaces += 1;
  return rows[0].id;
}

module.exports = { exportInventory, importInventory, readFile, COLUMNS, MAX_ROWS };
