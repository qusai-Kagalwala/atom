// Web Push (Phase 14, decided 2 Nov 2026): every in-app notification is also pushed to the person's
// devices that turned it on (Profile → "Notifications on this device"), while the Super Admin's global
// switch is on and the VAPID keys are in .env. Best effort: sent after the change is saved, in the
// background; a slow or failing push never affects ATOM. Gone subscriptions (404 / 410) are revoked.
// The payload carries only what the notification already shows (title, short body, where to open it).
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError } = require('../../utils/httpError');

const bad = (message, code) => new HttpError(400, message, code);
const MAX_FAILURES = 5;
const TTL_SECONDS = 24 * 3600;

let deps = { pool: defaultPool, webpush: require('web-push') };
function setDeps(next) {
  deps = { ...deps, ...next };
}

const configured = () => Boolean(config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject);

async function enabled(db = deps.pool) {
  if (!configured()) return false;
  const { rows } = await db.query('SELECT push_enabled FROM notify_settings WHERE id = 1');
  return Boolean(rows[0]?.push_enabled);
}

// ---------- settings (Super Admin) ----------
async function getSettings() {
  const { rows } = await deps.pool.query('SELECT push_enabled FROM notify_settings WHERE id = 1');
  const { rows: c } = await deps.pool.query('SELECT count(*)::int AS devices, count(DISTINCT user_id)::int AS people FROM push_subscriptions WHERE revoked_at IS NULL');
  return { pushEnabled: Boolean(rows[0]?.push_enabled), keysConfigured: configured(), devices: c[0].devices, people: c[0].people };
}
async function setEnabled(user, on) {
  if (typeof on !== 'boolean') throw bad('Bad value.', 'invalid');
  await deps.pool.query('UPDATE notify_settings SET push_enabled = $1::boolean, updated_by = $2::bigint, updated_at = now() WHERE id = 1', [on, user.id]);
  return getSettings();
}

// ---------- the signed-in person's devices ----------
async function publicInfo(user) {
  const { rows } = await deps.pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1::bigint AND revoked_at IS NULL', [user.id]);
  return { publicKey: configured() ? config.vapid.publicKey : null, enabled: await enabled(), myDevices: rows[0].n };
}

function readSubscription(body) {
  const s = body?.subscription || {};
  const endpoint = String(s.endpoint || '');
  const p256dh = String(s.keys?.p256dh || '');
  const auth = String(s.keys?.auth || '');
  if (!/^https:\/\/\S{5,995}$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) {
    throw bad('This device could not be registered for notifications.', 'bad_subscription');
  }
  return { endpoint, p256dh, auth };
}

// The same device signing in as someone else moves to that person.
async function subscribe(user, body = {}, userAgent = '') {
  const s = readSubscription(body);
  const db = await deps.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('UPDATE push_subscriptions SET revoked_at = now() WHERE endpoint = $1::text AND revoked_at IS NULL AND user_id <> $2::bigint', [s.endpoint, user.id]);
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text)
       ON CONFLICT (endpoint) WHERE revoked_at IS NULL DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failures = 0`,
      [user.id, s.endpoint, s.p256dh, s.auth, String(userAgent || '').slice(0, 300) || null]
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
  return publicInfo(user);
}

async function unsubscribe(user, body = {}) {
  const endpoint = String(body.endpoint || '');
  await deps.pool.query('UPDATE push_subscriptions SET revoked_at = now() WHERE user_id = $1::bigint AND endpoint = $2::text AND revoked_at IS NULL', [user.id, endpoint]);
  return publicInfo(user);
}

// ---------- sending ----------
const base = () => config.basePath.replace(/\/$/, '');
// Opening the push goes through the Notifications page, which switches company / role when needed.
function payloadFor(row) {
  const params = new URLSearchParams({ open: String(row.id) });
  return JSON.stringify({
    title: String(row.title || 'ATOM').slice(0, 120),
    body: String(row.body || '').slice(0, 200),
    tag: `atom-${row.id}`,
    url: `${base()}/notifications?${params}`,
  });
}

// rows: notification rows just saved (any users). Never throws.
async function sendForRows(rows) {
  try {
    if (!rows?.length || !(await enabled())) return 0;
    deps.webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
    const ids = [...new Set(rows.map((r) => String(r.user_id)))];
    const { rows: subs } = await deps.pool.query(
      `SELECT s.id, s.user_id::text AS user_id, s.endpoint, s.p256dh, s.auth
         FROM push_subscriptions s JOIN users u ON u.id = s.user_id AND u.is_active
        WHERE s.user_id = ANY($1::bigint[]) AND s.revoked_at IS NULL`,
      [ids]
    );
    let sent = 0;
    for (const row of rows) {
      for (const s of subs.filter((x) => x.user_id === String(row.user_id))) {
        try {
          await deps.webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadFor(row), { TTL: TTL_SECONDS, urgency: 'normal' });
          await deps.pool.query('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = $1::bigint', [s.id]);
          sent += 1;
        } catch (err) {
          const gone = err?.statusCode === 404 || err?.statusCode === 410;
          await deps.pool.query(
            `UPDATE push_subscriptions SET failures = failures + 1,
                    revoked_at = CASE WHEN $2::boolean OR failures + 1 >= $3::int THEN now() ELSE revoked_at END
              WHERE id = $1::bigint`,
            [s.id, gone, MAX_FAILURES]
          );
        }
      }
    }
    return sent;
  } catch (err) {
    console.error('[ATOM] Push failed:', err.message);
    return 0;
  }
}

module.exports = { getSettings, setEnabled, publicInfo, subscribe, unsubscribe, sendForRows, payloadFor, setDeps, configured };
