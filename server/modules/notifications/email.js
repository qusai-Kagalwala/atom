// Email copies of notifications (decided 28 Oct 2026). Every in-app notification to a person who has
// an email address is also queued as an email — only while the Super Admin switch is on. Queued
// in the same transaction as the notification (a rolled-back change emails no one); a background
// job sends them (3 tries, then "failed"), so a slow mail server never slows ATOM down.
// Bodies are never logged.
const defaultPool = require('../../db/pool');
const { config } = require('../../config/env');
const mailer = require('../../services/mailer');
const layout = require('../../services/emailLayout');
const emailDesign = require('../../services/emailDesign');

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

// Notification type → small label and colour above the title.
const KIND = {
  created: ['New', 'gold'],
  assign: ['Assigned', 'info'],
  start: ['In progress', 'info'],
  wait_user: ['Your reply needed', 'warning'],
  wait_equipment: ['Waiting for equipment', 'warning'],
  resume: ['In progress', 'info'],
  resolve: ['Resolved', 'success'],
  items_decided: ['Approval update', 'info'],
  priority: ['Priority changed', 'warning'],
  overdue: ['Overdue', 'danger'],
  item_delivered: ['Delivered', 'success'],
  close: ['Closed', 'success'],
  reject: ['Rejected', 'danger'],
  comment: ['New comment', 'info'],
  to_recover: ['Equipment to collect', 'warning'],
  status_override: ['Status changed', 'warning'],
  pooled: ['Available to take', 'gold'],
  pool_empty: ['Pool ended', 'warning'],
  access: ['Access', 'info'],
};
const FINAL = ['RESOLVED', 'CLOSED', 'REJECTED'];
const refOf = (t) => (t?.number ? `${t.type === 'SERVICE_REQUEST' ? 'R' : 'T'}-${t.number}` : null);

// → { text, html } for one notification row. ticket may be null (onboarding / offboarding).
// company: the sending company's name (defaults to the ticket's).
function render(row, ticket, design = emailDesign.DEFAULTS, company = ticket?.service_unit_name || '') {
  const kind = String(row.type || '').split('.').pop();
  let [tag, tone] = KIND[kind] || ['Update', 'gold'];
  if (kind === 'resolve' && ticket?.type === 'SERVICE_REQUEST') tag = 'Delivered';
  const due = ticket?.due_by && !FINAL.includes(ticket.status) ? when(ticket.due_by) : null;
  return layout.render({
    company,
    tag,
    tone,
    title: row.title,
    paragraphs: row.body ? [row.body] : [],
    details: [
      [ticket?.type === 'SERVICE_REQUEST' ? 'Request' : 'Ticket', refOf(ticket)],
      ['Expected by', due],
    ],
    button: row.link ? { url: `${config.appUrl}${row.link}` } : null,
  }, design);
}

// Plain-text version (kept for tests and mail apps without HTML).
const compose = (row, ticket) => render(row, ticket).text;

// Inside the notification's transaction. rows = inserted notification rows.
async function queueForRows(db, rows, ticket) {
  if (!rows.length) return 0;
  const { rows: s } = await db.query('SELECT email_enabled FROM notify_settings WHERE id = 1');
  if (!s[0]?.email_enabled) return 0;
  const ids = [...new Set(rows.map((r) => String(r.user_id)))];
  const { rows: people } = await db.query(
    `SELECT id::text AS id, email FROM users WHERE id = ANY($1::bigint[]) AND is_active AND notify_email AND email IS NOT NULL AND email LIKE '%@%'`, // 031: email off = none
    [ids]
  );
  const emailOf = new Map(people.map((p) => [p.id, p.email.trim()]));
  if (!emailOf.size) return 0;
  // The sending company's name: the ticket's, else the notification's company (onboarding / offboarding).
  const unitIds = [...new Set(rows.map((r) => r.service_unit_id).filter((x) => x != null).map(String))];
  const { rows: units } = unitIds.length
    ? await db.query('SELECT id::text AS id, name FROM service_units WHERE id = ANY($1::bigint[])', [unitIds])
    : { rows: [] };
  const unitName = new Map(units.map((u) => [u.id, u.name]));
  const design = await emailDesign.current(db);
  let n = 0;
  for (const r of rows) {
    const to = emailOf.get(String(r.user_id));
    if (!to) continue;
    const mail = render(r, ticket, design, ticket?.service_unit_name || unitName.get(String(r.service_unit_id)) || '');
    await db.query(
      `INSERT INTO email_outbox (user_id, to_email, subject, body_text, body_html, request_id)
       VALUES ($1::bigint, $2::text, $3::text, $4::text, $5::text, $6::bigint)`,
      [r.user_id, to, `ATOM: ${r.title}`.slice(0, 200), mail.text, mail.html, r.request_id ?? null]
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
      RETURNING id, to_email, subject, body_text, body_html, attempts`,
    [limit]
  );
  let sent = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      await send({ to: m.to_email, subject: m.subject, text: m.body_text, html: m.body_html || undefined });
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

module.exports = { getSettings, setEnabled, queueForRows, sendQueued, recentEmails, compose, render, MAX_TRIES };
