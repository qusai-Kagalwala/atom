import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { meRequest } from '../api/auth';
import { getSocket } from '../api/socket';
import { pushToast } from '../utils/toasts';

const MAX_CHECKS = 3;

// Keeps one Socket.IO connection open while signed in (mounted by AppShell).
//   notification:new  → toast + refresh the bell
//   requests:changed  → refresh ticket lists and sidebar counts
// If the server drops the connection or refuses the session, /auth/me decides: a 401 sends the
// user to the login page (axios interceptor); otherwise we reconnect with the current token.
export default function useLiveUpdates() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    let refreshTimer = null;
    let checks = 0;

    const refreshRequests = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => queryClient.invalidateQueries({ queryKey: ['requests'] }), 300);
    };
    const onNotification = (n) => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      pushToast({ title: n.title, body: n.body, link: n.link, notificationId: n.id });
    };
    const recheck = () => {
      if (checks >= MAX_CHECKS) return;
      checks += 1;
      meRequest()
        .then(() => socket.connect())
        .catch(() => {}); // 401 → interceptor redirects; network trouble → socket.io keeps retrying
    };
    // (Re)connected: catch up on anything missed while offline.
    const onConnect = () => {
      checks = 0;
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      refreshRequests();
    };
    const onDisconnect = (reason) => {
      if (reason === 'io server disconnect') recheck();
    };
    const onConnectError = (err) => {
      if (err?.data?.code) recheck(); // session refused (not a network error)
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('session:end', recheck);
    socket.on('notification:new', onNotification);
    socket.on('requests:changed', refreshRequests);
    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('session:end', recheck);
      socket.off('notification:new', onNotification);
      socket.off('requests:changed', refreshRequests);
      clearTimeout(refreshTimer);
      socket.disconnect();
    };
  }, [queryClient]);
}
