#!/usr/bin/env node
// One-time import of employee-ID users from dbo.Login_Master.
//   npm run import:employees               → dry run: report only, nothing saved
//   npm run import:employees -- --commit   → save (all rows or nothing)
// Safe to re-run: IDs already in ATOM are skipped.
// Passwords are never printed.
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runEmployeeImport } = require(path.join(server, 'modules', 'sync', 'employeeImport'));
const pool = require(path.join(server, 'db', 'pool'));

const commit = process.argv.includes('--commit');

function print(r) {
  console.log(`Employee-ID import — ${r.mode.toUpperCase()}`);
  console.log(`  Rows in Login_Master   : ${r.total}`);
  console.log(`  8-digit (ITS) skipped  : ${r.itsSkipped}`);
  console.log(`  Already in ATOM        : ${r.alreadyInAtom}`);
  console.log(`  To import              : ${r.toImport}`);
  console.log(`  Errors                 : ${r.errors.length}`);
  for (const e of r.errors) console.log(`    row ${e.row}  ID ${e.id}: ${e.reason}`);

  if (r.errors.length) console.log('\nNothing saved — fix the errors in Login_Master first.');
  else if (r.mode === 'dry-run') console.log('\nDry run only. Run again with --commit to save.');
  else if (r.saved) console.log(`\nSaved: ${r.imported} users imported as Employee.`);
  else console.log('\nNothing to import.');
}

runEmployeeImport({ commit })
  .then(async (report) => {
    print(report);
    await pool.end();
    process.exit(report.errors.length ? 2 : 0);
  })
  .catch(async (err) => {
    console.error(`Import failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
