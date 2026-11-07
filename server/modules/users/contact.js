// Email and mobile set by hand (7 Nov 2026, migration 032). The HR list and the Idarah view miss many
// of these, so people add their own in Profile and the Super Admin can set anyone's. Saved straight away.
//   - A value set by hand is marked (email_set_by / mobile_set_by = 'self' | 'admin'); the Idarah sync
//     never overwrites a marked field. Clearing a value removes the mark (the sync may fill it again).
//   - Every change goes to the user's history: field names only, never the values.
//   - The Super Admin changing someone's details tells that person (in app).
const { HttpError } = require('../../utils/httpError');
const { cleanMobile } = require('../sync/contactsImport');
const notifRepo = require('../notifications/notifications.repo');

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const FIELDS = ['email', 'mobile'];

const bad = (message, code) => new HttpError(400, message, code);

// { email?, mobile? } from the request → cleaned values (null = clear). Fields not sent are left out.
function cleanContact(input = {}) {
  const out = {};
  if ('email' in input && input.email !== undefined) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) throw bad('Enter a valid email address.', 'bad_email');
    out.email = email || null;
  }
  if ('mobile' in input && input.mobile !== undefined) {
    const m = cleanMobile(input.mobile);
    if (m.error) throw bad('Enter a 10-digit mobile number (or 12 digits starting with 91).', 'bad_mobile');
    out.mobile = m.value;
  }
  return out;
}

// Saves the changed fields inside the caller's transaction. who: 'self' | 'admin'. → names of changed fields.
// opts.log = false: the caller writes the history line itself (with other fields).
async function saveContact(db, current, fields, who, actorId, { log = true } = {}) {
  if (who !== 'self' && who !== 'admin') throw new Error('saveContact: who must be self or admin');
  const changed = FIELDS.filter((k) => k in fields && (fields[k] ?? null) !== (current[k] ?? null));
  if (!changed.length) return [];
  const sets = [];
  const params = [current.id];
  for (const k of changed) {
    params.push(fields[k]);
    sets.push(`${k} = $${params.length}::text`, `${k}_set_by = CASE WHEN $${params.length}::text IS NULL THEN NULL ELSE '${who}' END`);
  }
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1::bigint`, params);
  if (!log) return changed;
  await db.query(
    `INSERT INTO user_change_log (user_id, action, detail, changed_by) VALUES ($1::bigint, 'profile_updated', $2::jsonb, $3::bigint)`,
    [current.id, JSON.stringify({ fields: changed, ...(who === 'self' ? { source: 'themselves' } : {}) }), actorId]
  );
  return changed;
}

const LABEL = { email: 'email', mobile: 'mobile number' };

// In-app note to the person when the Super Admin changed their details. → the notification row or null.
function tellPerson(db, userId, changed, actorId) {
  const what = changed.map((k) => LABEL[k]).join(' and ');
  return notifRepo.insertForUser(db, {
    userId,
    type: 'profile',
    title: `Your ${what} ${changed.length > 1 ? 'were' : 'was'} updated`,
    body: 'The Super Admin updated your contact details. You can check them in your Profile.',
    link: '/profile',
    actorId,
  });
}

// Your own email / mobile (Profile). → the cleaned values saved.
async function setOwnContact(pool, userId, input) {
  const fields = cleanContact(input);
  if (!Object.keys(fields).length) throw bad('Nothing to save.', 'nothing');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, email, mobile FROM users WHERE id = $1::bigint AND is_active FOR UPDATE', [userId]);
    if (!rows[0]) throw new HttpError(404, 'Not found.');
    await saveContact(client, rows[0], fields, 'self', userId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { cleanContact, saveContact, tellPerson, setOwnContact, FIELDS };
