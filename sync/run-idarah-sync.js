#!/usr/bin/env node
// People syncs → ATOM. Run by Windows Task Scheduler every ~10 minutes:
//   Program:   C:\Program Files\nodejs\node.exe
//   Arguments: sync\run-idarah-sync.js
//   Start in:  <ATOM project folder>
// Runs, in this order (each with its own lock, guard and run log):
//   1. Idarah sync — dbo.Vw_Idarah_Tafveez_CurrentYR     (ITS people, posts, departments)
//   2. HR sync     — dbo.Vw_User_Department_Details_New  (employee-ID staff, department locations)
// By hand (from server/):
//   npm run sync:idarah                      both
//   npm run sync:idarah -- --only=idarah     Idarah only
//   npm run sync:idarah -- --only=hr         HR only
//   npm run sync:idarah -- --force           overrides the 50% guard (0 usable rows is always blocked)
// Exit codes (worst of the runs): 0 = success or already running · 2 = blocked · 1 = failed
// The logic lives in server/modules/sync (shared with Super Admin "Sync now").
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runIdarahSync } = require(path.join(server, 'modules', 'sync', 'idarahSync'));
const { runHrSync } = require(path.join(server, 'modules', 'sync', 'hrSync'));
const pool = require(path.join(server, 'db', 'pool'));

const force = process.argv.includes('--force');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
const stamp = () => new Date().toISOString();
const log = (line) => console.log(`[${stamp()}] ${line}`);
// failed (1) outranks blocked (2), which outranks success (0).
const SEVERITY = { 0: 0, 2: 1, 1: 2 };
const exitCode = (status) => (status === 'success' || status === 'busy' ? 0 : status === 'blocked' ? 2 : 1);

const JOBS = [
  ['idarah', runIdarahSync],
  ['hr', runHrSync],
];

async function main() {
  if (only && !JOBS.some(([name]) => name === only)) {
    console.error(`Unknown --only value "${only}". Use --only=idarah or --only=hr.`);
    return 1;
  }
  let worst = 0;
  for (const [name, run] of JOBS) {
    if (only && only !== name) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await run({ force, log });
    if (result.summary) console.log(JSON.stringify(result.summary, null, 2));
    const code = exitCode(result.status);
    if (SEVERITY[code] > SEVERITY[worst]) worst = code;
  }
  return worst;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(`[${stamp()}] People sync crashed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
