// One-time import of employee-ID users from dbo.Login_Master (ATOM_Decisions.md §5).
//   - Only short (non-8-digit) User_Ids. 8-digit IDs are ITS people → skipped, never copied.
//   - Password copied as-is (plain text, client decision). Never printed, logged or reported.
//   - IDs already in ATOM are left alone (ATOM is the master) — so re-running is safe.
//   - Errors are per row; if any row has an error, NOTHING is saved.
//   - Every new user gets the Employee role and a status-log entry (source 'import').
//   - No names: users show as "Employee 1002" until a Super Admin adds one.
const defaultPool = require('../../db/pool');
const { readLoginMaster } = require('./sqlServer');

const ITS_RE = /^\d{8}$/;
const EMPLOYEE_RE = /^\d{1,7}$/;

// Pure. rows: [{ User_Id, Password }], existingIds: Set of employee_id already in ATOM.
function planImport(rows, existingIds) {
  const toImport = [];
  const errors = [];
  const alreadyInAtom = [];
  let itsSkipped = 0;
  const seen = new Map(); // id → first row number

  rows.forEach((row, index) => {
    const rowNo = index + 1;
    const id = row.User_Id == null ? '' : String(row.User_Id).trim();
    const password = row.Password == null ? '' : String(row.Password); // kept exactly as stored

    if (ITS_RE.test(id)) {
      itsSkipped += 1;
      return;
    }
    if (!EMPLOYEE_RE.test(id)) {
      errors.push({ row: rowNo, id: id || '(blank)', reason: 'User_Id is not a number of 1–7 digits.' });
      return;
    }
    if (seen.has(id)) {
      errors.push({ row: rowNo, id, reason: `Duplicate User_Id (also on row ${seen.get(id)}).` });
      return;
    }
    seen.set(id, rowNo);
    if (password.trim() === '') {
      errors.push({ row: rowNo, id, reason: 'Empty password.' });
      return;
    }
    if (existingIds.has(id)) {
      alreadyInAtom.push(id);
      return;
    }
    toImport.push({ id, password });
  });

  return {
    total: rows.length,
    itsSkipped,
    alreadyInAtom,
    toImport,
    errors,
  };
}

async function runEmployeeImport({ commit = false, readSource = readLoginMaster, pool = defaultPool } = {}) {
  const rows = await readSource();
  const { rows: existing } = await pool.query(
    `SELECT employee_id FROM users WHERE login_type = 'EMPLOYEE_ID'`
  );
  const plan = planImport(rows, new Set(existing.map((r) => r.employee_id)));

  const report = {
    mode: commit ? 'commit' : 'dry-run',
    total: plan.total,
    itsSkipped: plan.itsSkipped,
    alreadyInAtom: plan.alreadyInAtom.length,
    toImport: plan.toImport.length,
    errors: plan.errors, // never contains passwords
    imported: 0,
    saved: false,
  };

  if (!commit || plan.errors.length || !plan.toImport.length) return report;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of plan.toImport) {
      const { rows: inserted } = await client.query(
        `INSERT INTO users (login_type, employee_id, legacy_password, source)
         VALUES ('EMPLOYEE_ID', $1::text, $2::text, 'legacy')
         RETURNING id`,
        [u.id, u.password]
      );
      const id = inserted[0].id;
      await client.query(`INSERT INTO user_roles (user_id, role) VALUES ($1::bigint, 'EMPLOYEE')`, [id]);
      await client.query(
        `INSERT INTO user_status_log (user_id, is_active, source, reason)
         VALUES ($1::bigint, TRUE, 'import', 'Imported from Login_Master')`,
        [id]
      );
    }
    await client.query('COMMIT');
    report.imported = plan.toImport.length;
    report.saved = true;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // pg error messages can echo parameter values — report without them.
    throw new Error(`Import failed and nothing was saved (${err.code || 'database error'}).`);
  } finally {
    client.release();
  }
}

module.exports = { planImport, runEmployeeImport };
