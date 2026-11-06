// /Atom/api/leave — Staff leave (decided 6 Nov 2026). Everything is inside the active company.
//   Staff of the company (Staff & occupations), any role:
//     GET  /mine                                    → { types, today, onLeave, leaves }
//     POST /       { type, startDate, endDate?, note? } → { leave }   status PENDING; Admins notified
//     POST /:id/cancel { note? }                    → { leave }   own pending, or approved and not started
//   The company's Admin, or someone given "Staff leave" (Delegate access); others 404:
//     GET  /?view=pending|current|all               → { today, types, leaves }
//     GET  /staff                                   → { today, staff }   Available / On leave, next leave, open work
//     POST /:id/decide { decision: approve|reject, note } → { leave }  reject needs a note; the person is told
//     POST /:id/cancel { note }                     → { leave }   any pending / approved leave not yet ended
const express = require('express');
const { requireAuth, requireCompany } = require('../../middleware/requireAuth');
const { elevateIf } = require('../../middleware/features');
const svc = require('./leave.service');

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createLeaveRouter() {
  const router = express.Router();
  router.use(requireAuth, requireCompany);
  router.get('/mine', handle(async (req, res) => res.json(await svc.mine(req.user))));
  router.post('/', handle(async (req, res) => res.status(201).json({ leave: await svc.apply(req.user, req.body || {}) })));
  router.get('/', elevateIf('leave'), handle(async (req, res) => res.json(await svc.list(req.user, { view: req.query.view || 'pending' }))));
  router.get('/staff', elevateIf('leave'), handle(async (req, res) => res.json(await svc.board(req.user))));
  router.post('/:id/decide', elevateIf('leave'), handle(async (req, res) => res.json({ leave: await svc.decide(req.user, req.params.id, req.body || {}) })));
  router.post('/:id/cancel', elevateIf('leave'), handle(async (req, res) => res.json({ leave: await svc.cancel(req.user, req.params.id, req.body || {}) })));
  return router;
}

module.exports = { createLeaveRouter };
