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
  // SQL Server — read-only: the Idarah view and Login_Master.
  mssql: {
    server: env.MSSQL_SERVER || '',
    port: Number(env.MSSQL_PORT) || 1433,
    database: env.MSSQL_DATABASE || 'Jameasaifiyah',
    user: env.MSSQL_USER || '',
    password: env.MSSQL_PASSWORD || '',
    encrypt: String(env.MSSQL_ENCRYPT).toLowerCase() === 'true',
    trustServerCertificate: String(env.MSSQL_TRUST_SERVER_CERT ?? 'true').toLowerCase() !== 'false',
  },
  // Support Log item lists (companies step B): same SQL Server and login as mssql, this database.
  supportlog: {
    database: env.SUPPORTLOG_DB || 'SupportLog_New',
  },
  ejamaat: {
    soapUrl: env.EJAMAAT_SOAP_URL || '',
    appKey: env.EJAMAAT_APP_KEY || '',
    timeoutMs: Number(env.EJAMAAT_TIMEOUT_MS) || 10_000,
  },
  // Public address of the client app, used in email links (no trailing slash).
  // Dev: http://localhost:5173/Atom  ·  Prod: https://marol.jameasaifiyah.edu/Atom
  appUrl: String(env.APP_URL || 'http://localhost:5173/Atom').replace(/\/+$/, ''),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    secure: String(env.SMTP_SECURE).toLowerCase() === 'true',
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
  passwordResetMinutes: 30,
  // AI assistant (Phase 12). Model, temperature, on/off and token limits are Super Admin settings
  // in the database; only the key and the timeout live here.
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    baseUrl: String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    timeoutMs: Number(env.OPENAI_TIMEOUT_MS) || 15_000,
  },
  // Days and months for token limits and usage start at midnight in this time zone.
  timeZone: env.APP_TIME_ZONE || 'Asia/Kolkata',
  // Room occupancy sheet (Phase 8.2): a Google Sheet shared "anyone with the link can view".
  occupancy: {
    sheetId: env.OCCUPANCY_SHEET_ID || '',
    tabs: String(env.OCCUPANCY_SHEET_TABS || 'ADMIN BLDG').split(',').map((t) => t.trim()).filter(Boolean),
    timeoutMs: Number(env.OCCUPANCY_TIMEOUT_MS) || 20_000,
  },
  // Photos and invoices. Must be OUTSIDE the web root in production (e.g. D:\ATOM-data\attachments).
  // Dev default: <project>/attachments (git-ignored).
  attachmentDir: path.resolve(env.ATTACHMENT_DIR || path.join(__dirname, '..', '..', 'attachments')),
  attachmentDirIsDefault: !env.ATTACHMENT_DIR,
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
  if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be set (at least 32 characters).');
  }
  if (cfg.isProduction && cfg.authMode === 'live') {
    const { soapUrl, appKey } = cfg.ejamaat || {};
    if (!soapUrl || !appKey) {
      problems.push('EJAMAAT_SOAP_URL and EJAMAAT_APP_KEY must be set in production.');
    } else if (!/^https:\/\//i.test(soapUrl)) {
      problems.push('EJAMAAT_SOAP_URL must use https.');
    }
  }

  if (cfg.isProduction && cfg.attachmentDirIsDefault) {
    problems.push('ATTACHMENT_DIR must be set in production (a folder outside the web root).');
  }

  if (problems.length) {
    throw new Error(`ATOM configuration error:\n- ${problems.join('\n- ')}`);
  }
}

module.exports = { config, assertStartupConfig, parsePort, normaliseBasePath };
