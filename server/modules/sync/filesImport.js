// One-time copy of ticket photos and invoice files from ATTACHMENT_DIR into PostgreSQL (033, 7 Nov 2026).
//   - Only rows whose data is still NULL. Safe to re-run; a file is never changed or deleted on disk.
//   - Dry run by default: counts what would be copied and lists what is missing.
//   - commit: each file is saved on its own (a missing or unreadable file never stops the rest).
//   - A file whose size differs from the row's recorded size is reported, not copied.
const fs = require('fs/promises');
const defaultPool = require('../../db/pool');
const photos = require('../requests/attachments');
const invoiceFiles = require('../invoices/invoiceFiles');

const KINDS = [
  {
    key: 'photos',
    label: 'Ticket photos',
    select: 'SELECT id::text AS id, request_id::text AS owner, stored_name, size_bytes FROM request_attachments WHERE data IS NULL ORDER BY id',
    update: 'UPDATE request_attachments SET data = $2::bytea WHERE id = $1::bigint AND data IS NULL',
    pathOf: (r) => photos.filePath(r.owner, r.stored_name),
  },
  {
    key: 'invoices',
    label: 'Invoice files',
    select: 'SELECT id::text AS id, id::text AS owner, stored_name, size_bytes FROM invoices WHERE data IS NULL ORDER BY id',
    update: 'UPDATE invoices SET data = $2::bytea WHERE id = $1::bigint AND data IS NULL',
    pathOf: (r) => invoiceFiles.filePath(r.owner, r.stored_name),
  },
];

async function runFilesImport({ commit = false, pool = defaultPool } = {}) {
  const report = { mode: commit ? 'commit' : 'dry-run', kinds: [] };
  for (const k of KINDS) {
    const { rows } = await pool.query(k.select);
    const r = { key: k.key, label: k.label, waiting: rows.length, copied: 0, ready: 0, bytes: 0, problems: [] };
    for (const row of rows) {
      let data;
      try {
        // eslint-disable-next-line no-await-in-loop
        data = await fs.readFile(k.pathOf(row));
      } catch (err) {
        r.problems.push({ id: row.id, reason: err.code === 'ENOENT' ? 'file not found' : `cannot read (${err.code || err.message})` });
        continue;
      }
      if (row.size_bytes != null && data.length !== Number(row.size_bytes)) {
        r.problems.push({ id: row.id, reason: `size differs (${data.length} on disk, ${row.size_bytes} recorded)` });
        continue;
      }
      r.ready += 1;
      r.bytes += data.length;
      if (commit) {
        // eslint-disable-next-line no-await-in-loop
        const u = await pool.query(k.update, [row.id, data]);
        r.copied += u.rowCount;
      }
    }
    report.kinds.push(r);
  }
  return report;
}

module.exports = { runFilesImport };
