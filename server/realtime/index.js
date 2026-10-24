// Socket.IO for ATOM (Phase 13). One place that owns the io instance; services call the helpers
// below and they are no-ops when no server is attached (Jest, the sync script, migrations).
//
// Handshake: the client sends its login token as `auth.token`. checkSession() runs the same
// checks as requireAuth (active, roles, session version). Failure → connect_error with
// err.data.code = session_expired | removed | role_changed | password_changed.
//
// Rooms per socket:
//   user:<id>              every socket of that user (notifications about their own tickets)
//   user:<id>:<role>       sockets signed in with that active role (role notifications)
//   role:<role>            everyone currently in that role (e.g. role:SUPER_ADMIN)
//
// Sessions are re-checked every RECHECK_MS, so a user deactivated by the Task Scheduler sync
// (a separate process that can't reach these sockets) is dropped within a few minutes.
const { Server } = require('socket.io');
const { checkSession, DENY } = require('../middleware/requireAuth');

const RECHECK_MS = 5 * 60_000;

let io = null;
let timer = null;

const userRoom = (id) => `user:${id}`;
const userRoleRoom = (id, role) => `user:${id}:${role}`;
const roleRoom = (role) => `role:${role}`;

function sessionError(code) {
  const err = new Error(DENY[code] || DENY.session_expired);
  err.data = { code };
  return err;
}

// io.use() middleware. Exported for tests.
async function authenticate(socket, next) {
  try {
    const token = typeof socket.handshake?.auth?.token === 'string' ? socket.handshake.auth.token : '';
    const result = await checkSession(token);
    if (result.code) return next(sessionError(result.code));
    socket.data.user = result.user;
    socket.data.token = token;
    return next();
  } catch (err) {
    console.error('Socket auth failed:', err.message);
    return next(new Error('Could not check your session.'));
  }
}

function onConnection(socket) {
  const { id, activeRole } = socket.data.user;
  socket.join([userRoom(id), userRoleRoom(id, activeRole), roleRoom(activeRole)]);
}

// Drops sockets whose session is no longer valid (deactivated, role removed, password changed).
async function recheckSessions() {
  if (!io) return;
  const sockets = await io.fetchSockets();
  for (const socket of sockets) {
    try {
      const result = await checkSession(socket.data.token);
      if (result.code) {
        socket.emit('session:end', { code: result.code });
        socket.disconnect(true);
      }
    } catch (err) {
      console.error('Socket session re-check failed:', err.message);
      return; // DB trouble: try again next round rather than dropping everyone
    }
  }
}

function attach(httpServer, { basePath, recheckMs = RECHECK_MS } = {}) {
  io = new Server(httpServer, {
    path: `${basePath}/socket.io`,
    serveClient: false,
    // Same origin in production (IIS), Vite proxy in dev — no CORS needed.
  });
  io.use(authenticate);
  io.on('connection', onConnection);
  timer = setInterval(() => recheckSessions().catch(() => {}), recheckMs);
  timer.unref();
  return io;
}

function close() {
  if (timer) clearInterval(timer);
  timer = null;
  if (io) io.close();
  io = null;
}

// ---------- used by services ----------
function emitToUser(userId, event, payload) {
  if (io && userId != null) io.to(userRoom(userId)).emit(event, payload);
}

function emitToUserRole(userId, role, event, payload) {
  if (io && userId != null) io.to(userRoleRoom(userId, role)).emit(event, payload);
}

function emitToRole(role, event, payload) {
  if (io) io.to(roleRoom(role)).emit(event, payload);
}

// After deactivation, role removal or a password change. `except` = a socket id to keep
// (the device that changed its own password; it reconnects with its new token).
function disconnectUser(userId, { except } = {}) {
  if (!io || userId == null) return;
  let target = io.in(userRoom(userId));
  if (except) target = target.except(except);
  target.disconnectSockets(true);
}

// Tests: swap in a fake io.
function _setIo(fake) {
  io = fake;
}

module.exports = {
  attach,
  close,
  authenticate,
  onConnection,
  recheckSessions,
  emitToUser,
  emitToUserRole,
  emitToRole,
  disconnectUser,
  _setIo,
  rooms: { userRoom, userRoleRoom, roleRoom },
};
