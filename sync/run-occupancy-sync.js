#!/usr/bin/env node
// Room occupancy sheet → ATOM (who sits in which room / cubicle). Run by Windows Task Scheduler
// once a day (or hourly):
//   Program:   C:\Program Files\nodejs\node.exe
//   Arguments: sync\run-occupancy-sync.js
//   Start in:  <ATOM project folder>
// Reads the Google Sheet in OCCUPANCY_SHEET_ID / OCCUPANCY_SHEET_TABS (.env).
// By hand (from server/):
//   npm run sync:occupancy                              read the Google Sheet
//   npm run sync:occupancy -- --file=C:\path\sheet.csv  read a downloaded CSV instead (no internet needed)
//   npm run sync:occupancy -- --force                   overrides the 50% guard (0 usable rows is always blocked)
// Exit codes: 0 = success or already running · 2 = blocked · 1 = failed
// The logic lives in server/modules/sync/occupancySync.js (shared with Super Admin "Sync now").
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runOccupancySync } = require(path.join(server, 'modules', 'sync', 'occupancySync'));
const pool = require(path.join(server, 'db', 'pool'));

const force = process.argv.includes('--force');
const fileArg = process.argv.find((a) => a.startsWith('--file='));
const file = fileArg ? path.resolve(fileArg.slice('--file='.length)) : null;
const stamp = () => new Date().toISOString();
const log = (line) => console.log(`[${stamp()}] ${line}`);
const exitCode = (status) => (status === 'success' || status === 'busy' ? 0 : status === 'blocked' ? 2 : 1);

runOccupancySync({ force, file, log })
  .then(async (result) => {
    if (result.summary) console.log(JSON.stringify(result.summary, null, 2));
    await pool.end();
    process.exit(exitCode(result.status));
  })
  .catch(async (err) => {
    console.error(`[${stamp()}] Occupancy sync crashed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
