// /Atom/api/service-units — the companies (AVIT, Siyanaat, Tanzeem).
//   GET /   → { serviceUnits }   Super Admin: all. Everyone else: active ones.
// The company picker uses GET /auth/companies (with the person's roles in each).
const express = require('express');
const { requireAuth } = require('../../middleware/requireAuth');
const repo = require('./serviceUnits.repo');

const toPublic = (u) => ({ id: String(u.id), code: u.code, name: u.name, tagline: u.tagline || null, isActive: u.is_active });

function createServiceUnitsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', async (req, res, next) => {
    try {
      const units = await repo.listServiceUnits({ activeOnly: req.user.activeRole !== 'SUPER_ADMIN' });
      res.json({ serviceUnits: units.map(toPublic) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createServiceUnitsRouter };
