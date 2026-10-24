// /Atom/api/invoices — Engineers and Super Admins only (anyone else: 404). Scope per invoice (404).
//   GET   /?q=&linked=linked|unlinked&page=&pageSize=      → { invoices, total, page, pageSize }
//   POST  /    multipart: file, supplier?, reference?, invoiceDate? (YYYY-MM-DD), note?,
//              requestNumbers? ("T-1001,T-1002" or JSON array), linkExisting? ("true")
//              → 201 { invoice, added, already }            new invoice
//              → 409 { code: 'duplicate', duplicate }        same file already uploaded
//              → 200 { invoice, linkedExisting, added, already }   linkExisting=true
//   GET   /:number                      → { invoice }   (number: "INV-1001" or "1001")
//   GET   /:number/file                 → the file (scope-checked)
//   PATCH /:number  { supplier?, reference?, invoiceDate?, note? }  Super Admin or uploader
//   POST  /:number/links  { requestNumbers }                         → { invoice, added, already }
//   POST  /:number/links/:requestNumber/unlink  { reason }  Super Admin → { invoice }
const express = require('express');
const { query, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const { invoiceFileField } = require('./invoiceFiles');
const svc = require('./invoices.service');

const handle = (fn) => async (req, res, next) => {
  const err = validationResult(req).array({ onlyFirstError: true })[0];
  if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createInvoicesRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('ENGINEER', 'SUPER_ADMIN'));

  router.get(
    '/',
    query('linked').optional({ values: 'falsy' }).isIn(['linked', 'unlinked']).withMessage('Bad filter.'),
    query('q').optional().isString().isLength({ max: 100 }).withMessage('Search is too long.'),
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).withMessage('Bad page size.'),
    handle(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const result = await svc.list(req.user, {
        q: req.query.q,
        linked: req.query.linked || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json({ ...result, page, pageSize });
    })
  );

  router.post(
    '/',
    invoiceFileField,
    handle(async (req, res) => {
      const result = await svc.upload(req.user, req.body || {}, req.file);
      if (result.duplicate) {
        return res.status(409).json({
          message: `This invoice already exists (${result.duplicate.number}). Link it instead?`,
          code: 'duplicate',
          duplicate: result.duplicate,
        });
      }
      return res.status(result.created ? 201 : 200).json(result);
    })
  );

  router.get('/:number', handle(async (req, res) => res.json({ invoice: await svc.detail(req.user, req.params.number) })));

  router.get(
    '/:number/file',
    handle(async (req, res) => {
      const file = await svc.getFile(req.user, req.params.number);
      res.set({
        'Content-Type': file.mimeType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': `inline; filename="${file.downloadName}"`,
        'X-Content-Type-Options': 'nosniff',
        // A PDF opened straight from this URL can't run scripts against ATOM.
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      });
      res.sendFile(file.path, (err) => {
        if (err && !res.headersSent) res.status(404).json({ message: 'Not found.' });
      });
    })
  );

  router.patch('/:number', handle(async (req, res) => res.json({ invoice: await svc.updateLabels(req.user, req.params.number, req.body || {}) })));

  router.post('/:number/links', handle(async (req, res) => res.json(await svc.link(req.user, req.params.number, req.body?.requestNumbers))));

  router.post(
    '/:number/links/:requestNumber/unlink',
    handle(async (req, res) => res.json(await svc.unlink(req.user, req.params.number, req.params.requestNumber, req.body?.reason)))
  );

  return router;
}

module.exports = { createInvoicesRouter };
