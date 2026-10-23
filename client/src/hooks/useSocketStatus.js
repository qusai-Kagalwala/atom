import { useEffect, useState } from 'react';
import { getSocket } from '../api/socket';

// Reports Socket.IO state and transport ('websocket' or 'polling').
// On IIS, staying on 'polling' means the WebSocket Protocol feature is missing.
export default function useSocketStatus() {
  const [status, setStatus] = useState({ state: 'loading', transport: null });

  useEffect(() => {
    const socket = getSocket();

    const onConnect = () =>
      setStatus({ state: 'ok', transport: socket.io.engine?.transport?.name ?? null });
    const onUpgrade = (transport) => setStatus({ state: 'ok', transport: transport.name });
    const onOpen = () => socket.io.engine.on('upgrade', onUpgrade);
    const onFail = () => setStatus({ state: 'fail', transport: null });

    socket.io.on('open', onOpen);
    socket.on('connect', onConnect);
    socket.on('connect_error', onFail);
    socket.on('disconnect', onFail);

    socket.connect();

    return () => {
      socket.io.off('open', onOpen);
      socket.off('connect', onConnect);
      socket.off('connect_error', onFail);
      socket.off('disconnect', onFail);
      socket.disconnect();
    };
  }, []);

  return status;
}
