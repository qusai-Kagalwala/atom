#!/usr/bin/env node
// Support Log item lists → ATOM (companies step B). Run by Windows Task Scheduler once a night:
//   Program:   C:\Program Files\nodejs\node.exe
//   Arguments: sync\run-items-sync.js
//   Start in:  <ATOM project folder>
// Reads SupportLog_New (SUPPORTLOG_DB in .env) dbo.Item_Master + dbo.Main_Item_Master, read only:
//   company 1 → AVIT problem list · 2 → Siyanaat problem list · 3 → Tanzeem catalogue (price, pack, stock)
// By hand (from server/):
//   npm run sync:items                                  all three companies
//   npm run sync:items -- --only=SIYANAAT,TANZEEM       some companies
//   npm run sync:items -- --preview                     show what would change, save nothing
//   npm run sync:items -- --overwrite                   also overwrite changes made in ATOM since the last sync
//   npm run sync:items -- --force                       overrides the 50% guard (0 usable rows is always blocked)
// Exit codes: 0 = success or already running · 2 = blocked · 1 = failed
// The logic lives in server/modules/sync/itemsSync.js (shared with Super Admin "Sync now").
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runItemsSync } = require(path.join(server, 'modules', 'sync', 'itemsSync'));
const { CODES } = require(path.join(server, 'modules', 'sync', 'itemsPlan'));
const pool = require(path.join(server, 'db', 'pool'));

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('only');
const companies = only ? only.split(',').map((c) => c.trim().toUpperCase()).filter((c) => CODES.includes(c)) : CODES;
const stamp = () => new Date().toISOString();
const log = (line) => console.log(`[${stamp()}] ${line}`);
const exitCode = (status) => (status === 'success' || status === 'busy' ? 0 : status === 'blocked' ? 2 : 1);

runItemsSync({
  companies,
  force: process.argv.includes('--force'),
  preview: process.argv.includes('--preview'),
  keepAtomEdits: !process.argv.includes('--overwrite'),
  log,
})
  .then(async (result) => {
    if (result.message) log(result.message);
    if (result.summary) console.log(JSON.stringify(result.summary, null, 2));
    await pool.end();
    process.exit(exitCode(result.status));
  })
  .catch(async (err) => {
    console.error(`[${stamp()}] Items sync crashed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
