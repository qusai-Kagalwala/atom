// /Atom/api/users — Super Admin only (any other role gets 404).
//   GET    /?q=&role=&status=active|inactive|all&source=&page=&pageSize=  → { users, total, page, pageSize }
//   POST   /                                    create a manual user       → { user }
//   GET    /:id                                                            → { user }
//   PATCH  /:id            { name?, email?, mobile? }  (imported/manual only)  → { user }
//   POST   /:id/roles      { role }                                        → { user }
//   DELETE /:id/roles/:role                                                → { user }
//   POST   /:id/service-units { serviceUnitId }                            → { user }
//   DELETE /:id/service-units/:serviceUnitId                               → { user }
//   POST   /:id/status     { active, reason }                              → { user }
//   POST   /:id/password   { newPassword }      (employee-ID users only)   → { message }
// SECURITY: never log req.body (passwords).
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { requireAuth, requireRole } = require('../../middleware/requireAuth');
const svc = require('./users.service');

const ROLES = ['EMPLOYEE', 'ENGINEER', 'SUPER_ADMIN'];
const SOURCES = ['idarah', 'legacy', 'manual'];

// '' / whitespace → null, otherwise trimmed.
const blankToNull = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const firstError = (req) => validationResult(req).array({ onlyFirstError: true })[0];

function validated(handler) {
  return async (req, res, next) => {
    const err = firstError(req);
    if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
    try {
      return await handler(req, res);
    } catch (e) {
      return next(e);
    }
  };
}

const profileRules = [
  body('name').optional({ values: 'null' }).isString().isLength({ max: 200 }).withMessage('Name is too long.'),
  body('email')
    .optional({ values: 'null' })
    .customSanitizer(blankToNull)
    .if((v) => v !== null)
    .isEmail()
    .withMessage('Enter a valid email address.')
    .isLength({ max: 254 }),
  body('mobile')
    .optional({ values: 'null' })
    .customSanitizer(blankToNull)
    .if((v) => v !== null)
    .matches(/^[0-9+\-() ]{6,20}$/)
    .withMessage('Enter a valid mobile number.'),
];

function pickProfile(b) {
  const out = {};
  for (const k of ['name', 'email', 'mobile']) if (k in b) out[k] = blankToNull(b[k]);
  return out;
}

function createUsersRouter() {
  const router = express.Router();
  router.use(requireAuth, requireRole('SUPER_ADMIN'));

  router.get(
    '/',
    query('q').optional().isString().isLength({ max: 100 }),
    query('role').optional({ values: 'falsy' }).isIn(ROLES),
    query('status').optional({ values: 'falsy' }).isIn(['active', 'inactive', 'all']),
    query('source').optional({ values: 'falsy' }).isIn(SOURCES),
    query('page').optional().isInt({ min: 1, max: 100000 }),
    query('pageSize').optional().isInt({ min: 1, max: 100 }),
    validated(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 25;
      const status = req.query.status || 'active';
      const result = await svc.listUsers({
        q: String(req.query.q || '').trim() || null,
        role: req.query.role || null,
        active: status === 'all' ? null : status === 'active',
        source: req.query.source || null,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      res.json({ ...result, page, pageSize });
    })
  );

  router.post(
    '/',
    body('loginType').isIn(['ITS', 'EMPLOYEE_ID']).withMessage('Choose ITS or Employee ID.'),
    body('password').optional().isString(),
    ...profileRules,
    validated(async (req, res) => {
      const user = await svc.createUser(
        {
          loginType: req.body.loginType,
          itsNumber: req.body.itsNumber,
          employeeId: req.body.employeeId,
          password: req.body.password,
          ...pickProfile(req.body),
        },
        req.user
      );
      res.status(201).json({ user });
    })
  );

  router.get('/:id', validated(async (req, res) => res.json({ user: await svc.getUserDetail(req.params.id) })));

  router.patch(
    '/:id',
    ...profileRules,
    validated(async (req, res) => res.json({ user: await svc.updateProfile(req.params.id, pickProfile(req.body), req.user) }))
  );

  router.post(
    '/:id/roles',
    body('role').isIn(ROLES).withMessage('Choose a valid role.'),
    validated(async (req, res) => res.json({ user: await svc.grantRole(req.params.id, req.body.role, req.user) }))
  );

  router.delete(
    '/:id/roles/:role',
    validated(async (req, res) => res.json({ user: await svc.removeRole(req.params.id, req.params.role, req.user) }))
  );

  router.post(
    '/:id/service-units',
    body('serviceUnitId').isInt({ min: 1 }).withMessage('Choose a service unit.'),
    validated(async (req, res) =>
      res.json({ user: await svc.tagUnit(req.params.id, String(req.body.serviceUnitId), req.user) })
    )
  );

  router.delete(
    '/:id/service-units/:serviceUnitId',
    validated(async (req, res) => res.json({ user: await svc.untagUnit(req.params.id, req.params.serviceUnitId, req.user) }))
  );

  router.post(
    '/:id/status',
    body('active').isBoolean({ strict: true }).withMessage('Choose active or inactive.'),
    body('reason').isString().withMessage('Enter a reason.'),
    validated(async (req, res) =>
      res.json({ user: await svc.setStatus(req.params.id, req.body.active, req.body.reason, req.user) })
    )
  );

  router.post(
    '/:id/password',
    body('newPassword').isString().withMessage('Enter a new password.'),
    validated(async (req, res) => res.json(await svc.resetPassword(req.params.id, req.body.newPassword, req.user)))
  );

  return router;
}

module.exports = { createUsersRouter };
