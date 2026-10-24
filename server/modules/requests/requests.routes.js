// /Atom/api/requests — tickets (Phase 6). Every route needs login; scope is checked per ticket
// (out of scope = 404). :number accepts "T-1001" or "1001".
//   GET    /categories                                         → { categories }
//   GET    /mine?status=open|closed|all&page=&pageSize=        → { requests, total, page, pageSize }
//   POST   /               multipart: title, description, categoryId, priority, location,
//                          requesterId (Super Admin only), photos[] (≤ 5)      → 201 { request }
//   GET    /:number                                            → { request }
//   POST   /:number/actions/:action  { note?, engineerId? }    → { request }
//          action = assign | start | wait_user | wait_equipment | resume | resolve | close | reject
//   PATCH  /:number        { priority?, categoryId? }  (Super Admin)           → { request }
//   POST   /:number/comments  multipart: note, internal, photos[]              → { request }
//   GET    /:number/engineers  (Super Admin: who can be assigned)              → { engineers }
//   GET    /:number/attachments/:attachmentId                  → the image (scope-checked)
// Phase 7 (lists; out-of-role = 404):
//   GET    /counts                         sidebar badges for the active role
//   GET    /engineers                      Super Admin: engineers tagged to AVIT
//   GET    /queue/work?group=active|to_start|in_progress|waiting|resolved   Engineer / Super Admin: assigned to me
//   GET    /queue/assign?view=unassigned|to_close                          Super Admin
//   GET    /all?q=&status=&priority=&categoryId=&engineerId=(id|none)&sort=  Super Admin
const express = require('express');
const { query, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/requireAuth');
const { photosField } = require('./attachments');
const lifecycle = require('./lifecycle');
const svc = require('./requests.service');

const handle = (fn) => async (req, res, next) => {
  const err = validationResult(req).array({ onlyFirstError: true })[0];
  if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createRequestsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/categories', handle(async (req, res) => res.json({ categories: await svc.listCategories() })));

  router.get(
    '/mine',
    query('status').optional({ values: 'falsy' }).isIn(['open', 'closed', 'all']).withMessage('Choose open, closed or all.'),
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('Bad page size.'),
    handle(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const status = req.query.status || 'open';
      const result = await svc.listMine(req.user, {
        open: status === 'all' ? null : status === 'open',
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json({ ...result, page, pageSize });
    })
  );

  // ---------- Phase 7: queues ----------
  const paging = [
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('Bad page size.'),
  ];
  const pageOf = (req, size = 25) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || size;
    return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
  };

  router.get('/counts', handle(async (req, res) => res.json({ counts: await svc.queueCounts(req.user) })));

  router.get('/engineers', handle(async (req, res) => res.json({ engineers: await svc.listEngineers(req.user) })));

  router.get(
    '/queue/work',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const result = await svc.listWorkQueue(req.user, { group: req.query.group || 'active', ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.get(
    '/queue/assign',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const result = await svc.listAssignQueue(req.user, { view: req.query.view || 'unassigned', ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.get(
    '/all',
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req);
      const { q, status, priority, categoryId, engineerId, sort } = req.query;
      const result = await svc.listAll(req.user, { q, status, priority, categoryId, engineerId, sort, ...p });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );

  router.post(
    '/',
    photosField,
    handle(async (req, res) => {
      const request = await svc.createTicket(req.user, req.body || {}, req.files || []);
      res.status(201).json({ request });
    })
  );

  router.get('/:number', handle(async (req, res) => res.json({ request: await svc.getTicket(req.user, req.params.number) })));

  router.post(
    '/:number/actions/:action',
    handle(async (req, res) => {
      if (!lifecycle.ACTION_KEYS.includes(req.params.action)) {
        return res.status(400).json({ message: 'Unknown action.', code: 'bad_action' });
      }
      const request = await svc.act(req.user, req.params.number, req.params.action, req.body || {});
      return res.json({ request });
    })
  );

  router.patch(
    '/:number',
    handle(async (req, res) => {
      const { priority, categoryId } = req.body || {};
      res.json({ request: await svc.triage(req.user, req.params.number, { priority, categoryId }) });
    })
  );

  router.post(
    '/:number/comments',
    photosField,
    handle(async (req, res) => {
      res.json({ request: await svc.comment(req.user, req.params.number, req.body || {}, req.files || []) });
    })
  );

  router.get(
    '/:number/engineers',
    handle(async (req, res) => res.json({ engineers: await svc.eligibleEngineers(req.user, req.params.number) }))
  );

  router.get(
    '/:number/attachments/:attachmentId',
    handle(async (req, res) => {
      const file = await svc.getAttachmentFile(req.user, req.params.number, req.params.attachmentId);
      res.set({
        'Content-Type': file.mimeType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      res.sendFile(file.path, (err) => {
        if (err && !res.headersSent) res.status(404).json({ message: 'Not found.' });
      });
    })
  );

  return router;
}

module.exports = { createRequestsRouter };
