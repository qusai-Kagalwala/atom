// Delegate access (decided 6 Nov 2026): the company's Admin (or the Super Admin inside the company) gives
// single Admin features to people on the company's staff. Grants live in user_features; removing one sets
// revoked_at (kept as history). The person is told by a notification. Staff & occupations and Delegate
// access itself can never be given (nobody can hand out more access).
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');
const { FEATURES, FEATURE_KEYS } = require('../../middleware/features');
const notifRepo = require('../notifications/notifications.repo');
const notifications = require('../notifications/notifications.service');

const bad = (message, code = 'invalid') => new HttpError(400, message, code);
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));

// Features this company can give (Jamea Internet Access: AVIT only).
const featuresFor = (company) =>
  FEATURE_KEYS.filter((k) => !FEATURES[k].companies || FEATURES[k].companies.includes(company?.code)).map((k) => ({
    key: k,
    label: FEATURES[k].label,
    hint: FEATURES[k].hint,
    nav: FEATURES[k].nav,
  }));

async function inTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Staff of the company (not its Admins: they have everything already), with their live grants.
async function people(db, companyId, userId = null) {
  const { rows } = await db.query(
    `SELECT u.id::text AS id, COALESCE(u.name, 'Employee ' || u.employee_id) AS name, u.its_number, u.employee_id, u.is_active,
            o.name AS occupation,
            COALESCE((SELECT json_agg(json_build_object('feature', f.feature, 'at', f.granted_at, 'by', g.name) ORDER BY f.feature)
                        FROM user_features f LEFT JOIN users g ON g.id = f.granted_by
                       WHERE f.user_id = u.id AND f.service_unit_id = uc.service_unit_id AND f.revoked_at IS NULL), '[]') AS grants
       FROM user_company uc
       JOIN users u ON u.id = uc.user_id
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE uc.service_unit_id = $1::bigint
        AND ($2::bigint IS NULL OR u.id = $2::bigint)
        AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'ENGINEER')
        AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ('ADMIN', 'SUPER_ADMIN'))
      ORDER BY u.is_active DESC, lower(u.name)`,
    [companyId, userId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    itsNumber: r.its_number || null,
    employeeId: r.employee_id || null,
    isActive: r.is_active,
    occupation: r.occupation || null,
    features: r.grants.map((g) => g.feature),
    grants: r.grants,
  }));
}

async function overview(user, db = pool) {
  return { features: featuresFor(user.company), people: await people(db, user.companyId) };
}

// Set exactly these features for one person. → { person }
async function setFeatures(user, userId, list) {
  if (!isId(userId)) throw notFound();
  if (!Array.isArray(list) || list.length > FEATURE_KEYS.length) throw bad('Choose features from the list.');
  const allowed = new Set(featuresFor(user.company).map((f) => f.key));
  const wanted = [...new Set(list.map(String))];
  const unknown = wanted.find((k) => !allowed.has(k));
  if (unknown) throw bad('That feature can\'t be given here.', 'bad_feature');

  const { added, removed, person } = await inTx(async (db) => {
    const [p] = await people(db, user.companyId, userId);
    if (!p) throw notFound(); // not on this company's staff (or an Admin)
    if (!p.isActive && wanted.length) throw new HttpError(409, 'This person is inactive.', 'inactive');
    // Lock this person's grants so two Admins saving at once can't double up.
    await db.query('SELECT id FROM user_features WHERE user_id = $1::bigint AND service_unit_id = $2::bigint FOR UPDATE', [userId, user.companyId]);
    const now = new Set(p.features);
    const add = wanted.filter((k) => !now.has(k));
    const remove = p.features.filter((k) => !wanted.includes(k));
    if (remove.length) {
      await db.query(
        `UPDATE user_features SET revoked_at = now(), revoked_by = $3::bigint
          WHERE user_id = $1::bigint AND service_unit_id = $2::bigint AND revoked_at IS NULL AND feature = ANY($4::text[])`,
        [userId, user.companyId, user.id, remove]
      );
    }
    for (const k of add) {
      // eslint-disable-next-line no-await-in-loop
      await db.query(
        'INSERT INTO user_features (user_id, service_unit_id, feature, granted_by) VALUES ($1::bigint, $2::bigint, $3::text, $4::bigint)',
        [userId, user.companyId, k, user.id]
      );
    }
    const rows = [];
    const label = (keys) => keys.map((k) => FEATURES[k].label).join(', ');
    if (add.length) {
      const r = await notifRepo.insertForUser(db, {
        userId, type: 'access', title: `You can now use: ${label(add)}`.slice(0, 200),
        body: `Given by ${user.name || 'your Admin'} in ${user.company?.name || 'ATOM'}. It is in your menu.`, link: '/', actorId: user.id, companyId: user.companyId,
      });
      if (r) rows.push(r);
    }
    if (remove.length) {
      const r = await notifRepo.insertForUser(db, {
        userId, type: 'access', title: `Access removed: ${label(remove)}`.slice(0, 200),
        body: `In ${user.company?.name || 'ATOM'}.`, link: '/', actorId: user.id, companyId: user.companyId,
      });
      if (r) rows.push(r);
    }
    const [fresh] = await people(db, user.companyId, userId);
    return { added: add, removed: remove, person: fresh, rows };
  }).then((out) => {
    notifications.publish(out.rows, null);
    return out;
  });
  return { person, added, removed };
}

module.exports = { overview, setFeatures, featuresFor };
