#!/usr/bin/env node
// One-time copy of ticket photos and invoice files from ATTACHMENT_DIR into PostgreSQL (migration 033).
// Run on the server, after `node db/migrate.js`, with the same .env as ATOM:
//   cd server
//   node ../sync/import-files-to-db.js            → dry run: what would be copied, what is missing
//   node ../sync/import-files-to-db.js --commit   → copy them in (safe to re-run; only rows not yet copied)
// Files on disk are never changed or deleted. When everything shows 0 waiting, keep the folder as a backup.
const path = require('path');

const server = path.join(__dirname, '..', 'server');
const { runFilesImport } = require(path.join(server, 'modules', 'sync', 'filesImport'));
const { config } = require(path.join(server, 'config', 'env'));
const pool = require(path.join(server, 'db', 'pool'));

const commit = process.argv.includes('--commit');
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

runFilesImport({ commit })
  .then(async (r) => {
    console.log(`Files into the database — ${r.mode.toUpperCase()}`);
    console.log(`  Reading from: ${config.attachmentDir}`);
    let problems = 0;
    for (const k of r.kinds) {
      console.log(`  ${k.label.padEnd(14)}: ${k.waiting} waiting · ${k.ready} found (${mb(k.bytes)})${commit ? ` · ${k.copied} copied` : ''} · ${k.problems.length} problems`);
      for (const p of k.problems) console.log(`      id ${p.id}: ${p.reason}`);
      problems += k.problems.length;
    }
    if (!commit) console.log('\nDry run only. Run again with --commit to copy them in.');
    else console.log(problems ? '\nDone. Files with problems were left as they are.' : '\nDone.');
    await pool.end();
    process.exit(problems ? 2 : 0);
  })
  .catch(async (err) => {
    console.error(`Import failed: ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  });
