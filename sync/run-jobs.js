#!/usr/bin/env node
// Background jobs → run once and exit. Run by Windows Task Scheduler every 5 minutes, so overdue alerts
// and notification emails keep going while nobody has ATOM open (iisnode stops an idle web server):
//   Program:   C:\Program Files\nodejs\node.exe
//   Arguments: sync\run-jobs.js
//   Start in:  <ATOM project folder>
// Does: overdue check · send queued emails · clean the email log (90 days).
// Safe next to the web server's own every-minute timer: each row is claimed once.
// Overdue notifications found here are pushed to phones from this script; the bell picks them up on its
// next refresh (live sockets belong to the web server).
// By hand (from server/): npm run jobs
// Exit codes: 0 = done · 1 = failed
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const jobs = require(path.join(server, 'jobs'));
const push = require(path.join(server, 'modules', 'push', 'push.service'));
const pool = require(path.join(server, 'db', 'pool'));

const stamp = () => new Date().toISOString();

async function main() {
  const pending = [];
  // No sockets in this process: send pushes and wait for them before exiting.
  const publish = (rows) => {
    if (rows?.length) pending.push(push.sendForRows(rows).catch(() => {}));
  };
  const result = await jobs.runOnce({ publish });
  await Promise.all(pending);
  return result;
}

if (require.main === module) {
  main()
    .then(async (r) => {
      console.log(`[${stamp()}] Jobs done: ${r.overdue} newly overdue · ${r.poolsAssigned} pool tickets assigned · ${r.emailsSent} emails sent · ${r.emailsFailed} failed · ${r.emailsCleaned} old emails cleaned · ${r.wifiExpired} Wi-Fi batches expired`);
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`[${stamp()}] Jobs failed: ${err.message}`);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { main };
