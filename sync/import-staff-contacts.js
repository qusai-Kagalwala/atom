#!/usr/bin/env node
// One-time import of staff email + mobile from a CSV file (employee_id, email, mobile).
// Keep the CSV OUTSIDE the ATOM folder (it holds personal data) and delete it afterwards.
//   cd server
//   node ../sync/import-staff-contacts.js C:\path\staff-contacts.csv            → dry run, nothing saved
//   node ../sync/import-staff-contacts.js C:\path\staff-contacts.csv --commit   → save (all rows or nothing)
// Only fills blanks: an email or mobile already in ATOM is never overwritten. Safe to re-run.
// Emails and numbers are never printed.
const fs = require('fs');
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runContactsImport } = require(path.join(server, 'modules', 'sync', 'contactsImport'));
const pool = require(path.join(server, 'db', 'pool'));

const commit = process.argv.includes('--commit');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));

function print(r) {
  if (r.fatal) {
    console.log(`Nothing saved: ${r.fatal}`);
    return;
  }
  console.log(`Staff contacts import — ${r.mode.toUpperCase()}`);
  console.log(`  Rows in file            : ${r.total}`);
  console.log(`  Users to update         : ${r.toUpdate}  (emails ${r.emails}, mobiles ${r.mobiles})`);
  console.log(`  Already complete        : ${r.unchanged}`);
  console.log(`  Different value kept    : ${r.kept.length}${r.kept.length ? ` (${r.kept.map((k) => `${k.id} ${k.field}`).join(', ')})` : ''}`);
  console.log(`  Employee ID not in ATOM : ${r.notInAtom.length}${r.notInAtom.length ? ` (${r.notInAtom.join(', ')})` : ''}`);
  console.log(`  Errors                  : ${r.errors.length}`);
  for (const e of r.errors) console.log(`    row ${e.row}  ID ${e.id}: ${e.reason}`);
  if (r.errors.length) console.log('\nNothing saved — fix the errors in the file first.');
  else if (r.mode === 'dry-run') console.log('\nDry run only. Run again with --commit to save.');
  else if (r.saved) console.log(`\nSaved: ${r.toUpdate} users updated.`);
  else console.log('\nNothing to update.');
}

if (!file) {
  console.error('Give the CSV file: node ../sync/import-staff-contacts.js <file.csv> [--commit]');
  process.exit(1);
}

let csvText;
try {
  csvText = fs.readFileSync(path.resolve(file));
} catch (err) {
  console.error(`Could not read ${file}: ${err.code || err.message}`);
  process.exit(1);
}

runContactsImport({ csvText, commit })
  .then(async (report) => {
    print(report);
    await pool.end();
    process.exit(report.fatal || report.errors?.length ? 2 : 0);
  })
  .catch(async (err) => {
    console.error(`Import failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
