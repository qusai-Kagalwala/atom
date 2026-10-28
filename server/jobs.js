// Background jobs inside the web server, every minute (decided 28 Oct 2026):
//   - overdue check (tells Super Admins + the engineer once per request)
//   - email sender (queued notification emails; 3 tries)
//   - email log clean-up (sent / failed emails older than 90 days)
// Each step is safe with several iisnode processes: rows are claimed atomically.
// The people / occupancy syncs stay in Windows Task Scheduler (separate scripts).
const pool = require('./db/pool');
const timeFrames = require('./modules/requests/timeFrames');
const email = require('./modules/notifications/email');

const EVERY_MS = 60_000;
let timer = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await timeFrames.checkOverdue();
    await email.sendQueued();
    await pool.query(`DELETE FROM email_outbox WHERE status <> 'queued' AND created_at < now() - interval '90 days'`);
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

module.exports = { start, stop, tick };
