// /Atom/api/notifications — the signed-in user's own notifications, for the ACTIVE role only
// (rows with role NULL show in every role). Someone else's id, or another role's, = 404.
//   GET  /?unread=1&page=&pageSize=   → { notifications, total, unread, page, pageSize }
//   GET  /unread-count                 → { unread }
//   POST /:id/read                     → { unread }
//   POST /read-all                     → { unread: 0 }
const express = require('express');
const { query, validationResult } = require('express-validator');
const { requireAuth } = require('../../middleware/requireAuth');
const svc = require('./notifications.service');

const handle = (fn) => async (req, res, next) => {
  const err = validationResult(req).array({ onlyFirstError: true })[0];
  if (err) return res.status(400).json({ message: err.msg, code: 'invalid' });
  try {
    return await fn(req, res);
  } catch (e) {
    return next(e);
  }
};

function createNotificationsRouter() {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/',
    query('unread').optional().isIn(['0', '1', 'true', 'false']).withMessage('Bad filter.'),
    query('page').optional().isInt({ min: 1, max: 100000 }).withMessage('Bad page.'),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).withMessage('Bad page size.'),
    handle(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 20;
      const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
      const result = await svc.list(req.user, { unreadOnly, limit: pageSize, offset: (page - 1) * pageSize });
      res.json({ ...result, page, pageSize });
    })
  );

  router.get('/unread-count', handle(async (req, res) => res.json(await svc.unreadCount(req.user))));

  router.post('/read-all', handle(async (req, res) => res.json(await svc.markAllRead(req.user))));

  router.post(
    '/:id/read',
    handle(async (req, res) => {
      const result = await svc.markRead(req.user, req.params.id);
      if (!result) return res.status(404).json({ message: 'Not found.' });
      return res.json(result);
    })
  );

  return router;
}

module.exports = { createNotificationsRouter };
