// /Atom/api/sync/*  — Super Admin only (out of role = 404).
//   GET  /runs?job=idarah|hr|occupancy&limit=20  → { runs }   latest runs of one sync, newest first (default idarah)
//   POST /idarah  { force? }           → result of runIdarahSync ("Sync now")
//   POST /hr      { force? }           → result of runHrSync ("Sync now", Phase 3.1)
//   POST /occupancy { force? }         → result of runOccupancySync ("Sync now", Phase 8.2)
//   POST /items { companies?: ['AVIT','SIYANAAT','TANZEEM'], keepAtomEdits? (default true), force?, preview? }
//                                      → result of runItemsSync (Support Log item lists, 30 Oct 2026)
//   GET  /old-accounts                 → { checkedAt, accounts } | { checkedAt: null, accounts: [] }
//        imported Login_Master accounts that are active but not in the HR employee list
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const pool = require('../../db/pool');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { runIdarahSync } = require('./idarahSync');
const { runHrSync, oldAccountsNotInHr } = require('./hrSync');
const { runOccupancySync } = require('./occupancySync');
const { runItemsSync } = require('./itemsSync');
const { CODES } = require('./itemsPlan');

const STATUS_HTTP = { success: 200, busy: 409, blocked: 409, failed: 502 };
const JOBS = ['idarah', 'hr', 'occupancy', 'items'];

function createSyncRouter({ run = runIdarahSync, runHr = runHrSync, runOccupancy = runOccupancySync, runItems = runItemsSync } = {}) {
  const router = express.Router();
  router.use(requireAuth, requireRole('SUPER_ADMIN'));

  router.get('/runs', query('job').optional().isIn(JOBS), async (req, res, next) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ message: 'Unknown sync.', code: 'invalid' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.job, r.status, r.forced, r.started_at, r.finished_at,
                r.source_rows, r.valid_rows, r.skipped_rows, r.summary, r.message,
                u.name AS triggered_by_name
           FROM src.sync_runs r
           LEFT JOIN users u ON u.id = r.triggered_by
          WHERE r.job = $1::text
          ORDER BY r.started_at DESC
          LIMIT $2::int`,
        [req.query.job || 'idarah', limit]
      );
      return res.json({ runs: rows });
    } catch (err) {
      return next(err);
    }
  });

  const syncNow = (fn) => async (req, res, next) => {
    try {
      const result = await fn({ force: req.body?.force === true, triggeredBy: req.user.id, log: () => {} });
      res.status(STATUS_HTTP[result.status] ?? 500).json(result);
    } catch (err) {
      next(err);
    }
  };
  router.post('/idarah', body('force').optional().isBoolean(), syncNow(run));
  router.post('/hr', body('force').optional().isBoolean(), syncNow(runHr));
  router.post('/occupancy', body('force').optional().isBoolean(), syncNow(runOccupancy));
  router.post(
    '/items',
    body('force').optional().isBoolean(),
    body('preview').optional().isBoolean(),
    body('keepAtomEdits').optional().isBoolean(),
    body('companies').optional().isArray({ min: 1, max: 3 }),
    body('companies.*').optional().isIn(CODES),
    async (req, res, next) => {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ message: 'Bad sync options.', code: 'invalid' });
      try {
        const result = await runItems({
          companies: req.body?.companies || CODES,
          keepAtomEdits: req.body?.keepAtomEdits !== false,
          force: req.body?.force === true,
          preview: req.body?.preview === true,
          triggeredBy: req.user.id,
          log: () => {},
        });
        return res.status(STATUS_HTTP[result.status] ?? 500).json(result);
      } catch (err) {
        return next(err);
      }
    }
  );

  router.get('/old-accounts', async (req, res, next) => {
    try {
      const result = await oldAccountsNotInHr(pool);
      res.json(result || { checkedAt: null, accounts: [] });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSyncRouter };
