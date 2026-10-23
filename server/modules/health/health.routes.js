// Health checks used by the Phase 1 system-check page and for IIS deployment checks.
// No auth: they expose no data beyond the app version.
const express = require('express');
const pool = require('../../db/pool');
const { config } = require('../../config/env');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    app: 'ATOM',
    version: config.version,
    env: config.nodeEnv,
    time: new Date().toISOString(),
  });
});

router.get('/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ database: 'ok' });
  } catch (err) {
    console.error('Health check: PostgreSQL unreachable:', err.message);
    res.status(503).json({ database: 'unreachable' });
  }
});

module.exports = router;
