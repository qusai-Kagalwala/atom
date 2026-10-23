// Numbered SQL migration runner.
// Usage: npm run migrate   (from server/)
// Applies server/db/migrations/NNN_name.sql in order, each in its own transaction,
// and records it in public.schema_migrations. An advisory lock stops two runs at once.
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_LOCK_KEY = 727301; // arbitrary, unique to ATOM migrations
const FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((name) => FILE_PATTERN.test(name))
    .sort();
}

async function runMigrations(client, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT filename FROM public.schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const pending = listMigrationFiles(dir).filter((name) => !applied.has(name));

    if (!pending.length) {
      log('Migrations: nothing to apply.');
      return [];
    }

    for (const name of pending) {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1::text)', [name]);
        await client.query('COMMIT');
        log(`Migrations: applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${name} failed: ${err.message}`;
        throw err;
      }
    }
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
  }
}

async function main() {
  const pool = require('./pool');
  const client = await pool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runMigrations, listMigrationFiles };
