// One-time import of staff email + mobile from a CSV file (Phase 3.2, decided 26 Oct 2026).
// The data comes from the HR sheet; it is loaded into the database only — never kept in code.
//   CSV columns: employee_id, email, mobile   (header row required; other columns ignored)
//   - Matches employee-ID users by employee_id.
//   - Fills email / mobile ONLY where ATOM has none. A different value already in ATOM is kept
//     and reported, never overwritten.
//   - Errors are per row; if any row has an error, NOTHING is saved. Dry run by default.
//   - Each filled user gets a "Details edited" history entry (fields only, never the values).
const defaultPool = require('../../db/pool');
const { parseCsv } = require('../../utils/csv');

const EMPLOYEE_RE = /^\d{1,7}$/;
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

// "+91 98200-00001" → "919820000001"; 10 digits or 12 starting with 91.
function cleanMobile(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return { value: null };
  if (/^\d{10}$/.test(digits) || /^91\d{10}$/.test(digits)) return { value: digits };
  return { error: 'Mobile must be 10 digits (or 12 starting with 91).' };
}

// Pure. records from parseCsv; existing: Map(employee_id → { id, email, mobile }).
function planContacts({ headers, records, rowNumbers }, existing) {
  const missing = ['employee_id', 'email', 'mobile'].filter((h) => !headers.includes(h));
  if (missing.length) {
    return { fatal: `The CSV must have the columns employee_id, email, mobile (missing: ${missing.join(', ')}).` };
  }
  const updates = [];
  const errors = [];
  const notInAtom = [];
  const kept = []; // ATOM already had a different value
  let unchanged = 0;
  const seen = new Map();

  records.forEach((r, i) => {
    const rowNo = rowNumbers[i];
    const id = String(r.employee_id ?? '').trim();
    const email = String(r.email ?? '').trim().toLowerCase() || null;
    const mobile = cleanMobile(r.mobile);
    if (!EMPLOYEE_RE.test(id)) return errors.push({ row: rowNo, id: id || '(blank)', reason: 'employee_id must be 1–7 digits.' });
    if (seen.has(id)) return errors.push({ row: rowNo, id, reason: `Duplicate employee_id (also on row ${seen.get(id)}).` });
    seen.set(id, rowNo);
    if (email && !EMAIL_RE.test(email)) return errors.push({ row: rowNo, id, reason: 'Email is not valid.' });
    if (mobile.error) return errors.push({ row: rowNo, id, reason: mobile.error });

    const u = existing.get(id);
    if (!u) return notInAtom.push(id);

    const set = {};
    if (email) {
      if (!u.email) set.email = email;
      else if (u.email.toLowerCase() !== email) kept.push({ id, field: 'email' });
    }
    if (mobile.value) {
      if (!u.mobile) set.mobile = mobile.value;
      else if (u.mobile.replace(/\D/g, '') !== mobile.value) kept.push({ id, field: 'mobile' });
    }
    if (Object.keys(set).length) updates.push({ userId: u.id, id, ...set });
    else unchanged += 1;
    return undefined;
  });

  return { total: records.length, updates, errors, notInAtom, kept, unchanged };
}

async function runContactsImport({ csvText, commit = false, pool = defaultPool } = {}) {
  const parsed = parseCsv(csvText);
  const { rows } = await pool.query(
    `SELECT id, employee_id, email, mobile FROM users WHERE login_type = 'EMPLOYEE_ID'`
  );
  const plan = planContacts(parsed, new Map(rows.map((u) => [u.employee_id, u])));
  if (plan.fatal) return { mode: commit ? 'commit' : 'dry-run', fatal: plan.fatal, saved: false };

  const report = {
    mode: commit ? 'commit' : 'dry-run',
    total: plan.total,
    toUpdate: plan.updates.length,
    emails: plan.updates.filter((u) => u.email).length,
    mobiles: plan.updates.filter((u) => u.mobile).length,
    unchanged: plan.unchanged,
    notInAtom: plan.notInAtom,
    kept: plan.kept,
    errors: plan.errors, // ids and reasons only — never the email or number
    saved: false,
  };
  if (!commit || plan.errors.length || !plan.updates.length) return report;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of plan.updates) {
      await client.query(
        `UPDATE users SET email = COALESCE(email, $2::text), mobile = COALESCE(mobile, $3::text) WHERE id = $1::bigint`,
        [u.userId, u.email ?? null, u.mobile ?? null]
      );
      const fields = ['email', 'mobile'].filter((f) => u[f]);
      await client.query(
        `INSERT INTO user_change_log (user_id, action, detail, changed_by)
         VALUES ($1::bigint, 'profile_updated', $2::jsonb, NULL)`,
        [u.userId, JSON.stringify({ fields, source: 'contacts import' })]
      );
    }
    await client.query('COMMIT');
    report.saved = true;
    return report;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`Import failed and nothing was saved (${err.code || 'database error'}).`);
  } finally {
    client.release();
  }
}

module.exports = { planContacts, runContactsImport, cleanMobile };
