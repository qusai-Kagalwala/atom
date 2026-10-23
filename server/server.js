// ATOM server entry point. iisnode runs this file (see web.config); locally: npm run dev.
const http = require('http');
const { Server } = require('socket.io');
const { config, assertStartupConfig } = require('./config/env');
const { createApp } = require('./app');

assertStartupConfig(config);

const app = createApp();
const server = http.createServer(app);

// Path must match the client and web.config: /Atom/socket.io
// Same origin in production, so no CORS. Socket auth arrives in Phase 13.
const io = new Server(server, {
  path: `${config.basePath}/socket.io`,
  serveClient: false,
});

io.on('connection', (socket) => {
  socket.emit('server:hello', { time: new Date().toISOString() });
});

app.set('io', io);

server.listen(config.port, () => {
  console.log(`ATOM ${config.version} listening on ${config.port} (${config.nodeEnv}, auth=${config.authMode})`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing ATOM server.`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
