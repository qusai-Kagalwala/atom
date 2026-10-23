import { io } from 'socket.io-client';

// Socket.IO path must match the server: /Atom/socket.io
export const SOCKET_PATH = `${import.meta.env.BASE_URL}socket.io`;

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io({ path: SOCKET_PATH, autoConnect: false });
  }
  return socket;
}
