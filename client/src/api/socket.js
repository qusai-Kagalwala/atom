import { io } from 'socket.io-client';
import { getToken } from '../auth/storage';

// Socket.IO path must match the server: /Atom/socket.io
export const SOCKET_PATH = `${import.meta.env.BASE_URL}socket.io`;

let socket = null;

// One connection for the whole app. The login token is read on every (re)connect, so a
// refreshed token (role switch, password change) is picked up automatically.
export function getSocket() {
  if (!socket) {
    socket = io({
      path: SOCKET_PATH,
      autoConnect: false,
      auth: (cb) => cb({ token: getToken() || '' }),
    });
  }
  return socket;
}

// This tab's socket id, sent as X-Socket-Id so the server can keep it when the password changes.
export function socketId() {
  return socket?.connected ? socket.id : null;
}

// Reconnect with the current token (after the token changed).
export function reconnectSocket() {
  if (!socket || !(socket.connected || socket.active)) return;
  socket.disconnect();
  socket.connect();
}
