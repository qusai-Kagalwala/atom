// Background jobs (decided 28 Oct 2026; Task Scheduler backup added in Phase 16, 2 Nov 2026):
//   - overdue check (tells the company's Admins + the staff member once per request)
//   - email sender (queued notification emails; 3 tries)
//   - email log clean-up (sent / failed emails older than 90 days)
//   - Jamea Internet Access batches past their expiry: usernames / passwords deleted (Nov 2026)
// Two ways they run, both safe together (every row is claimed once — UPDATE … RETURNING / SKIP LOCKED):
//   1. inside the web server, every minute (start() below) — only while iisnode keeps the process alive;
//   2. sync/run-jobs.js from Windows Task Scheduler every 5 minutes — keeps going when the site is idle.
// The people / occupancy / items syncs stay in their own Task Scheduler scripts.
const pool = require('./db/pool');
const timeFrames = require('./modules/requests/timeFrames');
const email = require('./modules/notifications/email');
const wifi = require('./modules/wifi/wifi.service');

const EVERY_MS = 60_000;
let timer = null;
let running = false;

// One round. publish: how new notifications go out (default: live sockets + push from the web server).
// → { overdue, emailsSent, emailsFailed, emailsCleaned }
async function runOnce({ publish } = {}) {
  const overdue = await timeFrames.checkOverdue(publish ? { publish } : {});
  const { sent, failed } = await email.sendQueued();
  const { rowCount } = await pool.query(`DELETE FROM email_outbox WHERE status <> 'queued' AND created_at < now() - interval '90 days'`);
  const wifiExpired = await wifi.expireDue(); // Jamea Internet Access batches past their expiry: passes deleted
  return { overdue, emailsSent: sent, emailsFailed: failed, emailsCleaned: rowCount, wifiExpired };
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

module.exports = { start, stop, tick, runOnce };
