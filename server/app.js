// Express app (no listening here, so tests can use it with supertest).
const express = require('express');
const helmet = require('helmet');
const { config } = require('./config/env');
const healthRoutes = require('./modules/health/health.routes');
const { createAuthRouter } = require('./modules/auth/auth.routes');
const { createSyncRouter } = require('./modules/sync/sync.routes');
const { createServiceUnitsRouter } = require('./modules/serviceUnits/serviceUnits.routes');
const { HttpError } = require('./utils/httpError');

function createApp() {
  const app = express();

  // iisnode adds X-Forwarded-For (enableXFF="true"); trust one hop so req.ip is the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use('/health', healthRoutes);
  api.use('/auth', createAuthRouter());
  api.use('/sync', createSyncRouter());
  api.use('/service-units', createServiceUnitsRouter());
  api.use((req, res) => res.status(404).json({ message: 'Not found.' }));

  app.use(`${config.basePath}/api`, api);

  // Anything else reaching Node is not ours (IIS serves the client build).
  app.use((req, res) => res.status(404).json({ message: 'Not found.' }));

  // Error handler. Never log request bodies; for 4xx don't log at all
  // (body-parser messages can contain fragments of the body, e.g. a password).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 ? err.status : 500;
    if (status >= 500) {
      console.error(`${req.method} ${req.originalUrl} failed:`, err.stack || err.message);
      return res.status(status).json({ message: 'Something went wrong. Please try again.' });
    }
    // Our own HttpError (scope guards, services) carries a user-safe message. Don't trust
    // err.expose: body-parser sets it too, and its messages can echo the request body.
    if (err instanceof HttpError) return res.status(status).json({ message: err.message, code: err.code });
    const message = err.type === 'entity.parse.failed' ? 'Invalid JSON in request body.' : 'Bad request.';
    return res.status(status).json({ message });
  });

  return app;
}

module.exports = { createApp };
