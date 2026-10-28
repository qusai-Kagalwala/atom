// Email copies of notifications (decided 28 Oct 2026). Every in-app notification to a person who has
// an email address is also queued as an email — only while the Super Admin switch is on. Queued
// in the same transaction as the notification (a rolled-back change emails no one); a background
// job sends them (3 tries, then "failed"), so a slow mail server never slows ATOM down.
// Bodies are never logged.
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const mailer = require('../../services/mailer');

const MAX_TRIES = 3;
const BATCH = 20;

async function getSettings(db = defaultPool) {
  await db.query('INSERT INTO notify_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  const { rows } = await db.query('SELECT email_enabled, updated_at FROM notify_settings WHERE id = 1');
  return { emailEnabled: rows[0].email_enabled, smtpConfigured: Boolean(config.smtp.host && config.smtp.from), updatedAt: rows[0].updated_at };
}

async function setEnabled(user, enabled, db = defaultPool) {
  await getSettings(db);
  await db.query('UPDATE notify_settings SET email_enabled = $1::boolean, updated_by = $2::bigint, updated_at = now() WHERE id = 1', [enabled, user.id]);
  return getSettings(db);
}

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: config.timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});
const when = (d) => IST.format(new Date(d));

function compose(row, ticket) {
  const lines = [row.title];
  if (row.body) lines.push('', row.body);
  if (ticket?.due_by && !['RESOLVED', 'CLOSED', 'REJECTED'].includes(ticket.status)) {
    lines.push('', `Expected by: ${when(ticket.due_by)}`);
  }
  if (row.link) lines.push('', `Open in ATOM: ${config.appUrl}${row.link}`);
  lines.push('', '—', 'AVIT · ATOM (automatic message — please do not reply)');
  return lines.join('\n');
}

// Inside the notification's transaction. rows = inserted notification rows.
async function queueForRows(db, rows, ticket) {
  if (!rows.length) return 0;
  const { rows: s } = await db.query('SELECT email_enabled FROM notify_settings WHERE id = 1');
  if (!s[0]?.email_enabled) return 0;
  const ids = [...new Set(rows.map((r) => String(r.user_id)))];
  const { rows: people } = await db.query(
    `SELECT id::text AS id, email FROM users WHERE id = ANY($1::bigint[]) AND is_active AND email IS NOT NULL AND email LIKE '%@%'`,
    [ids]
  );
  const emailOf = new Map(people.map((p) => [p.id, p.email.trim()]));
  let n = 0;
  for (const r of rows) {
    const to = emailOf.get(String(r.user_id));
    if (!to) continue;
    await db.query(
      `INSERT INTO email_outbox (user_id, to_email, subject, body_text, request_id) VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::bigint)`,
      [r.user_id, to, `ATOM: ${r.title}`.slice(0, 200), compose(r, ticket), r.request_id ?? null]
    );
    n += 1;
  }
  return n;
}

// Background job: send what is due. Rows are claimed with SKIP LOCKED, so two server processes
// never send the same email.
async function sendQueued({ pool = defaultPool, send = mailer.sendMail, limit = BATCH } = {}) {
  if (!config.smtp.host) return { sent: 0, failed: 0 };
  const { rows } = await pool.query(
    `UPDATE email_outbox SET attempts = attempts + 1, next_try_at = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM email_outbox WHERE status = 'queued' AND next_try_at <= now()
                    ORDER BY id LIMIT $1::int FOR UPDATE SKIP LOCKED)
      RETURNING id, to_email, subject, body_text, attempts`,
    [limit]
  );
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      await send({ to: m.to_email, subject: m.subject, text: m.body_text });
      await pool.query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1::bigint`, [m.id]);
      sent += 1;
    } catch (err) {
      const final = m.attempts >= MAX_TRIES;
      await pool.query(
        `UPDATE email_outbox SET status = $2::text, last_error = $3::text,
                next_try_at = now() + make_interval(mins => 5 * $4::int) WHERE id = $1::bigint`,
        [m.id, final ? 'failed' : 'queued', String(err.message || err).slice(0, 300), m.attempts]
      );
      if (final) failed += 1;
    }
  }
  return { sent, failed };
}

async function recentEmails({ limit = 30 } = {}, db = defaultPool) {
  const { rows } = await db.query(
    `SELECT id::text AS id, to_email, subject, status, attempts, last_error, created_at, sent_at
       FROM email_outbox ORDER BY id DESC LIMIT $1::int`,
    [limit]
  );
  const { rows: c } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'sent' AND sent_at >= now() - interval '1 day')::int AS sent_today,
            count(*) FILTER (WHERE status = 'failed' AND created_at >= now() - interval '7 days')::int AS failed_week
       FROM email_outbox`
  );
  return {
    counts: { queued: c[0].queued, sentToday: c[0].sent_today, failedThisWeek: c[0].failed_week },
    emails: rows.map((r) => ({ id: r.id, to: r.to_email, subject: r.subject, status: r.status, attempts: r.attempts, error: r.last_error, at: r.created_at, sentAt: r.sent_at })),
  };
}

module.exports = { getSettings, setEnabled, queueForRows, sendQueued, recentEmails, compose, MAX_TRIES };
