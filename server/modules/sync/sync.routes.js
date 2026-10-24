// /Atom/api/sync/*  — Super Admin only (out of role = 404).
//   GET  /runs?limit=20        → { runs }   latest Idarah sync runs, newest first
//   POST /idarah  { force? }   → result of runIdarahSync ("Sync now")
const express = require('express');
const { body } = require('express-validator');
const pool = require('../../db/pool');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { runIdarahSync, JOB } = require('./idarahSync');

const STATUS_HTTP = { success: 200, busy: 409, blocked: 409, failed: 502 };

function createSyncRouter({ run = runIdarahSync } = {}) {
  const router = express.Router();
  router.use(requireAuth, requireRole('SUPER_ADMIN'));

  router.get('/runs', async (req, res, next) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.status, r.forced, r.started_at, r.finished_at,
                r.source_rows, r.valid_rows, r.skipped_rows, r.summary, r.message,
                u.name AS triggered_by_name
           FROM src.sync_runs r
           LEFT JOIN users u ON u.id = r.triggered_by
          WHERE r.job = $1::text
          ORDER BY r.started_at DESC
          LIMIT $2::int`,
        [JOB, limit]
      );
      res.json({ runs: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/idarah', body('force').optional().isBoolean(), async (req, res, next) => {
    try {
      const result = await run({ force: req.body?.force === true, triggeredBy: req.user.id, log: () => {} });
      res.status(STATUS_HTTP[result.status] ?? 500).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSyncRouter };
