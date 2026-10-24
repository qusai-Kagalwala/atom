// /Atom/api/service-units
//   GET /        → { serviceUnits }   Super Admin: all units. Everyone else: active units only.
//   GET /mine    → { serviceUnits }   Engineer (active role): the units they're tagged to.
// The front end never shows a unit picker at launch (everything is AVIT); this feeds later phases.
const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { serviceUnitIdsFor } = require('../../middleware/scope');
const repo = require('./serviceUnits.repo');

const toPublic = (u) => ({ id: String(u.id), code: u.code, name: u.name, isActive: u.is_active });

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

  router.get('/mine', requireRole('ENGINEER'), async (req, res, next) => {
    try {
      const ids = new Set(await serviceUnitIdsFor(req));
      const units = await repo.listServiceUnits();
      res.json({ serviceUnits: units.filter((u) => ids.has(String(u.id))).map(toPublic) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createServiceUnitsRouter };
