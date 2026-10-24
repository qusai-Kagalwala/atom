#!/usr/bin/env node
// Idarah view → ATOM sync. Run by Windows Task Scheduler every ~10 minutes:
//   Program:   C:\Program Files\nodejs\node.exe
//   Arguments: sync\run-idarah-sync.js
//   Start in:  <ATOM project folder>
// Or by hand (from server/):  npm run sync:idarah   |   npm run sync:idarah -- --force
//
// --force overrides the 50% guard only. A run with 0 usable rows is always blocked.
// Exit codes: 0 = success or already running · 2 = blocked · 1 = failed
// The logic lives in server/modules/sync (shared with Super Admin "Sync now").
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runIdarahSync } = require(path.join(server, 'modules', 'sync', 'idarahSync'));
const pool = require(path.join(server, 'db', 'pool'));

const force = process.argv.includes('--force');
const stamp = () => new Date().toISOString();

runIdarahSync({ force, log: (line) => console.log(`[${stamp()}] ${line}`) })
  .then(async (result) => {
    await pool.end();
    if (result.summary) console.log(JSON.stringify(result.summary, null, 2));
    process.exit(result.status === 'success' || result.status === 'busy' ? 0 : result.status === 'blocked' ? 2 : 1);
  })
  .catch(async (err) => {
    console.error(`[${stamp()}] Idarah sync crashed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
