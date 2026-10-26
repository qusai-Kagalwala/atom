// /Atom/api/inventory — Phase 8.
//   Everyone (signed in):
//     GET  /mine                                   → { assets }   assets assigned to me
//   Engineer + Super Admin (read):
//     GET  /assets?q=&categoryId=&placeId=&room=&status=(IN_STORE|IN_USE|IN_REPAIR|RETIRED|all)
//                 &attention=(serial|holder|any)&page=&pageSize=   → { assets, total, page, pageSize }
//     GET  /assets/:tag                            → { asset }   (detail + history)
//     GET  /categories                             → { categories }
//     GET  /places?q=&page=&pageSize=&includeInactive=1   → { places, total }
//   Super Admin:
//     POST  /assets                     { tag, categoryId, placeId?, …fields }  → 201 { asset }
//     PATCH /assets/:tag                { …fields, categoryId? }               → { asset }
//     POST  /assets/:tag/move           { placeId, note? }                     → { asset }
//     POST  /assets/:tag/assign         { userId, note? }                      → { asset }
//     POST  /assets/:tag/return         { placeId?, note? }                    → { asset }
//     POST  /assets/:tag/status         { status, note (required to retire) }  → { asset }
//     POST  /categories {name} · PATCH /categories/:id {name} · POST /categories/:id/merge {intoId}
//     POST  /places {…} · PATCH /places/:id {…, isActive?}
//     POST  /import   multipart: file (.csv), commit?, keepAtomEdits?, skipErrors?   → report
//     GET   /imports                                                              → { imports }
// Out of role = 404.
const express = require('express');
const multer = require('multer');
const { query, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { HttpError } = require('../../utils/httpError');
const { MAX_BYTES } = require('../../utils/csv');
const svc = require('./inventory.service');
const { runSnipeitImport } = require('./snipeitImport');

const handle = (fn) => async (req, res, next) => {
  const err = validationResult(req).array({ onlyFirstError: true })[0];
  if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    // Browsers on Windows send CSV as application/vnd.ms-excel; the extension decides.
    if (!/\.csv$/i.test(file.originalname || '')) return cb(new HttpError(400, 'Choose the CSV file exported from Snipe-IT.', 'bad_file_type'));
    return cb(null, true);
  },
});

function csvField(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(400, 'The CSV must be 20 MB or smaller.', 'file_too_large'));
    return next(new HttpError(400, 'Could not read the upload.', 'bad_upload'));
  });
}

const yes = (v) => v === true || v === 'true' || v === '1';
const paging = [
  query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
  query('pageSize').optional().isInt({ min: 1, max: 200 }).withMessage('Bad page size.'),
];
const pageOf = (req, size) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || size;
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
};

function createInventoryRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/mine', handle(async (req, res) => res.json({ assets: await svc.myAssets(req.user) })));

  const read = requireRole('ENGINEER', 'SUPER_ADMIN');
  const admin = requireRole('SUPER_ADMIN');

  router.get(
    '/assets',
    read,
    query('status').optional({ values: 'falsy' }).isIn([...svc.STATUSES, 'all']).withMessage('Bad status.'),
    query('attention').optional({ values: 'falsy' }).isIn(['serial', 'holder', 'any']).withMessage('Bad filter.'),
    query('categoryId').optional({ values: 'falsy' }).matches(/^\d{1,18}$/).withMessage('Bad category.'),
    query('placeId').optional({ values: 'falsy' }).matches(/^\d{1,18}$/).withMessage('Bad place.'),
    query('room').optional({ values: 'falsy' }).isLength({ max: 20 }).withMessage('Bad room.'),
    query('q').optional().isString().isLength({ max: 100 }).withMessage('Search is too long.'),
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req, 50);
      const result = await svc.listAssets({
        q: req.query.q, categoryId: req.query.categoryId || null, placeId: req.query.placeId || null,
        room: req.query.room || null, status: req.query.status || null, attention: req.query.attention || null,
        limit: p.limit, offset: p.offset,
      });
      res.json({ ...result, page: p.page, pageSize: p.pageSize });
    })
  );
  router.get('/assets/:tag', read, handle(async (req, res) => res.json({ asset: await svc.getAsset(req.user, req.params.tag) })));
  router.get('/categories', read, handle(async (req, res) => res.json({ categories: await svc.listCategories() })));
  router.get(
    '/places',
    read,
    query('q').optional().isString().isLength({ max: 100 }).withMessage('Search is too long.'),
    ...paging,
    handle(async (req, res) => {
      const p = pageOf(req, 50);
      res.json({ ...(await svc.listPlaces({ q: req.query.q, includeInactive: yes(req.query.includeInactive), limit: p.limit, offset: p.offset })), page: p.page, pageSize: p.pageSize });
    })
  );

  router.post('/assets', admin, handle(async (req, res) => res.status(201).json({ asset: await svc.createAsset(req.user, req.body || {}) })));
  router.patch('/assets/:tag', admin, handle(async (req, res) => res.json({ asset: await svc.updateAsset(req.user, req.params.tag, req.body || {}) })));
  router.post('/assets/:tag/move', admin, handle(async (req, res) => res.json({ asset: await svc.moveAsset(req.user, req.params.tag, req.body || {}) })));
  router.post('/assets/:tag/assign', admin, handle(async (req, res) => res.json({ asset: await svc.assignAsset(req.user, req.params.tag, req.body || {}) })));
  router.post('/assets/:tag/return', admin, handle(async (req, res) => res.json({ asset: await svc.returnAsset(req.user, req.params.tag, req.body || {}) })));
  router.post('/assets/:tag/status', admin, handle(async (req, res) => res.json({ asset: await svc.setStatus(req.user, req.params.tag, req.body || {}) })));

  router.post('/categories', admin, handle(async (req, res) => res.status(201).json({ category: await svc.createCategory(req.body || {}) })));
  router.patch('/categories/:id', admin, handle(async (req, res) => res.json({ category: await svc.renameCategory(req.params.id, req.body || {}) })));
  router.post('/categories/:id/merge', admin, handle(async (req, res) => res.json(await svc.mergeCategory(req.user, req.params.id, req.body?.intoId))));

  router.post('/places', admin, handle(async (req, res) => res.status(201).json({ place: await svc.createPlace(req.body || {}) })));
  router.patch('/places/:id', admin, handle(async (req, res) => res.json({ place: await svc.updatePlace(req.params.id, req.body || {}) })));

  router.post(
    '/import',
    admin,
    csvField,
    handle(async (req, res) => {
      if (!req.file) throw new HttpError(400, 'Choose the CSV file exported from Snipe-IT.', 'no_file');
      const report = await runSnipeitImport(req.file.buffer, {
        commit: yes(req.body?.commit),
        keepAtomEdits: yes(req.body?.keepAtomEdits),
        skipErrors: yes(req.body?.skipErrors),
        fileName: String(req.file.originalname || '').slice(0, 200),
        userId: req.user.id,
      });
      res.json(report);
    })
  );
  router.get('/imports', admin, handle(async (req, res) => res.json({ imports: await svc.listImports() })));

  return router;
}

module.exports = { createInventoryRouter };
