// Loads the root .env (atom/.env) and exposes typed config.
// Secrets live only in .env — never hard-code them here.
const path = require('path');
const dotenv = require('dotenv');
const pkg = require('../package.json');

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const env = process.env;

function normaliseBasePath(value) {
  const trimmed = String(value || '/Atom').trim().replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// iisnode passes a named pipe in PORT (e.g. \\.\pipe\...). Keep it as a string; only
// convert when it is purely numeric.
function parsePort(value) {
  if (value === undefined || value === '') return 3000;
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}

const config = {
  version: pkg.version,
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: parsePort(env.PORT),
  basePath: normaliseBasePath(env.BASE_PATH),
  authMode: (env.AUTH_MODE || 'live').toLowerCase(),
  sessionSecret: env.SESSION_SECRET || '',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '8h',
  pg: {
    host: env.PG_HOST || 'localhost',
    port: Number(env.PG_PORT) || 5432,
    database: env.PG_DATABASE || 'atom',
    user: env.PG_USER || 'atom',
    password: env.PG_PASSWORD || '',
  },
};

// Called once by server.js before listening. Throws so iisnode logs the reason and stops.
function assertStartupConfig(cfg) {
  const problems = [];

  if (!['live', 'mock'].includes(cfg.authMode)) {
    problems.push(`AUTH_MODE must be "live" or "mock" (got "${cfg.authMode}").`);
  }
  if (cfg.isProduction && cfg.authMode === 'mock') {
    problems.push('AUTH_MODE=mock is not allowed when NODE_ENV=production.');
  }
  if (cfg.basePath !== '/Atom') {
    problems.push(`BASE_PATH must be exactly "/Atom" (got "${cfg.basePath}").`);
  }
  if (cfg.isProduction && cfg.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set (at least 32 characters) in production.');
  }

  if (problems.length) {
    throw new Error(`ATOM configuration error:\n- ${problems.join('\n- ')}`);
  }
}

module.exports = { config, assertStartupConfig, parsePort, normaliseBasePath };
