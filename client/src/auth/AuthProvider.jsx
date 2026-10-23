import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loginRequest, meRequest, switchRoleRequest } from '../api/auth';
import { LOGIN_PATH } from '../api/http';
import queryClient from '../api/queryClient';
import AuthContext from './authContext';
import {
  clearSession,
  getLastRole,
  getStoredUser,
  getToken,
  saveSession,
  saveUser,
  setLastRole,
} from './storage';

const HOME_PATH = import.meta.env.BASE_URL;

export default function AuthProvider({ children }) {
  const [storedUser, setStoredUser] = useState(() => (getToken() ? getStoredUser() : null));
  const isAuthenticated = Boolean(storedUser && getToken());

  // Re-check the session on window focus, so role grants/removals and deactivation show up quickly.
  // A 401 here is handled by the axios interceptor (redirect to /login?error=…).
  const me = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: meRequest,
    enabled: isAuthenticated,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });

  // Fresh server copy wins; the stored copy only bridges the first render after a reload.
  const user = isAuthenticated ? me.data ?? storedUser : null;

  useEffect(() => {
    if (me.data) saveUser(me.data);
  }, [me.data]);

  const login = useCallback(async (identifier, password) => {
    let { token, user: next } = await loginRequest(identifier, password);
    saveSession(token, next);

    // Land in the last role used on this device, if it's still granted.
    const last = getLastRole(next.id);
    if (last && last !== next.activeRole && next.roles.includes(last)) {
      ({ token, user: next } = await switchRoleRequest(last));
      saveSession(token, next);
    }
    setLastRole(next.id, next.activeRole);
    setStoredUser(next);
    return next;
  }, []);

  // Full reload after switching (the Awraaq pattern — avoids stale data and redirect loops).
  const switchRole = useCallback(async (role) => {
    const { token, user: next } = await switchRoleRequest(role);
    saveSession(token, next);
    setLastRole(next.id, next.activeRole);
    queryClient.clear();
    window.location.replace(HOME_PATH);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    queryClient.clear();
    window.location.replace(LOGIN_PATH);
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated, login, logout, switchRole }),
    [user, isAuthenticated, login, logout, switchRole]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
