// Background jobs (decided 28 Oct 2026; Task Scheduler backup added in Phase 16, 2 Nov 2026):
//   - overdue check (tells the company's Admins + the staff member once per request)
//   - email sender (queued notification emails; 3 tries)
//   - email log clean-up (sent / failed emails older than 90 days)
//   - Jamea Internet Access batches past their expiry: usernames / passwords deleted (Nov 2026)
//   - old notifications deleted for people who chose 1 week / 15 days / 1 month (034, 7 Nov 2026)
// Two ways they run, both safe together (every row is claimed once — UPDATE … RETURNING / SKIP LOCKED):
//   1. inside the web server, every minute (start() below) — only while iisnode keeps the process alive;
//   2. sync/run-jobs.js from Windows Task Scheduler every 5 minutes — keeps going when the site is idle.
// The people / occupancy / items syncs stay in their own Task Scheduler scripts.
const pool = require('./db/pool');
const timeFrames = require('./modules/requests/timeFrames');
const email = require('./modules/notifications/email');
const wifi = require('./modules/wifi/wifi.service');
const requests = require('./modules/requests/requests.service');

const EVERY_MS = 60_000;
let timer = null;
let running = false;

// One round. publish: how new notifications go out (default: live sockets + push from the web server).
// → { overdue, emailsSent, emailsFailed, emailsCleaned }
async function runOnce({ publish } = {}) {
  // Pools nobody took within 12 hours → the member with the fewest ongoing tickets (before emails go out).
  const poolsAssigned = await requests.expirePools();
  const overdue = await timeFrames.checkOverdue(publish ? { publish } : {});
  const { sent, failed } = await email.sendQueued();
  const { rowCount } = await pool.query(`DELETE FROM email_outbox WHERE status <> 'queued' AND created_at < now() - interval '90 days'`);
  const wifiExpired = await wifi.expireDue(); // Jamea Internet Access batches past their expiry: passes deleted
  const notificationsCleared = await clearOldNotifications();
  return { overdue, poolsAssigned, emailsSent: sent, emailsFailed: failed, emailsCleaned: rowCount, wifiExpired, notificationsCleared };
}

// Each person's choice (034): notifications older than notify_keep_days are deleted. Never = NULL = kept.
async function clearOldNotifications() {
  const { rowCount } = await pool.query(
    `DELETE FROM notifications n USING users u
      WHERE n.user_id = u.id AND u.notify_keep_days IS NOT NULL
        AND n.created_at < now() - make_interval(days => u.notify_keep_days)`
  );
  return rowCount;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runOnce();
  } catch (err) {
    console.error('[ATOM] Background job failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, EVERY_MS);
  timer.unref();
  setTimeout(tick, 5_000).unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick, runOnce, clearOldNotifications };
