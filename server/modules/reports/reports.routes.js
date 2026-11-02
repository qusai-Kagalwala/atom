// /Atom/api/analytics and /Atom/api/reports — Phase 15 (decided 2 Nov 2026).
//   Company Admin (or the Super Admin inside the company); the active company only. Else 404.
//     GET /analytics?from=YYYY-MM-DD&to=YYYY-MM-DD        → numbers for the Analytics page
//     GET /reports                                         → { reports: [{ key, title }] }
//     GET /reports/:type?from&to&…filters                  → application/pdf (inline: the app previews it
//         first, then saves the same file). Types: tickets (status=open|closed, categoryId, engineerId),
//         performance, workload, assets (assetStatus, assetCategoryId), person (personId), invoices,
//         monthly (month=YYYY-MM).
//   Super Admin (any company or none):
//     GET /analytics/overview?from&to                      → headline numbers for every company
const express = require('express');
const { requireAuth, requireRole, requireAdmin } = require('../../middleware/requireAuth');
const analytics = require('./analytics.service');
const reports = require('./reports.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createAnalyticsRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/overview', requireRole('SUPER_ADMIN'), handle(async (req, res) => res.json(await analytics.overview(req.query))));
  router.get('/', ...requireAdmin, handle(async (req, res) => res.json(await analytics.companyAnalytics(req.user, req.query))));
  return router;
}

function createReportsRouter() {
  const router = express.Router();
  router.use(requireAuth, ...requireAdmin);
  router.get('/', (req, res) => res.json({ reports: Object.entries(reports.REPORTS).map(([key, r]) => ({ key, title: r.title })) }));
  router.get(
    '/:type',
    handle(async (req, res) => {
      const { buffer, filename } = await reports.render(req.user, req.params.type, req.query);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(buffer);
    })
  );
  return router;
}

module.exports = { createAnalyticsRouter, createReportsRouter };
