// Single PostgreSQL pool for the ATOM database. Connections open lazily on first query.
const { Pool } = require('pg');
const { config } = require('../config/env');

const pool = new Pool({
  ...config.pg,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = pool;
