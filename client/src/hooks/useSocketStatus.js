import { useEffect, useState } from 'react';
import { getSocket } from '../api/socket';

const read = (socket) =>
  socket.connected
    ? { state: 'ok', transport: socket.io.engine?.transport?.name ?? null }
    : { state: 'loading', transport: null };

// Reports Socket.IO state and transport ('websocket' or 'polling') of the app's live connection
// (opened by AppShell — this hook only watches it). Re-reads every second, because the
// polling → websocket upgrade can finish before this page starts listening.
// On IIS, staying on 'polling' means the WebSocket Protocol feature is missing.
export default function useSocketStatus() {
  const [status, setStatus] = useState(() => read(getSocket()));

  useEffect(() => {
    const socket = getSocket();
    const update = () =>
      setStatus((prev) => {
        if (prev.state === 'fail' && !socket.connected) return prev;
        const next = read(socket);
        return next.state === prev.state && next.transport === prev.transport ? prev : next;
      });
    const onFail = () => setStatus({ state: 'fail', transport: null });

    socket.on('connect', update);
    socket.on('connect_error', onFail);
    socket.on('disconnect', onFail);
    const timer = setInterval(update, 1000);

    return () => {
      clearInterval(timer);
      socket.off('connect', update);
      socket.off('connect_error', onFail);
      socket.off('disconnect', onFail);
    };
  }, []);

  return status;
}
