// ATOM server entry point. iisnode runs this file (see web.config); locally: npm run dev.
const http = require('http');
const { config, assertStartupConfig } = require('./config/env');
const { createApp } = require('./app');
const realtime = require('./realtime');
const jobs = require('./jobs');

assertStartupConfig(config);

const app = createApp();
const server = http.createServer(app);

// Path must match the client and web.config: /Atom/socket.io. Sockets need a valid login (Phase 13).
realtime.attach(server, { basePath: config.basePath });

server.listen(config.port, () => {
  console.log(`ATOM ${config.version} listening on ${config.port} (${config.nodeEnv}, auth=${config.authMode})`);
  jobs.start(); // overdue check + email sender, every minute
});

function shutdown(signal) {
  console.log(`${signal} received, closing ATOM server.`);
  jobs.stop();
  realtime.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
