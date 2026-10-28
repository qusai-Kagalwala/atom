import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loginRequest, meRequest, switchCompanyRequest, switchRoleRequest } from '../api/auth';
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
  setLastCompany,
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

  // After login the company picker always opens (LoginPage sends them there).
  const login = useCallback(async (identifier, password) => {
    const { token, user: next } = await loginRequest(identifier, password);
    saveSession(token, next);
    setStoredUser(next);
    return next;
  }, []);

  // Company picker: company = { id, roles } from /auth/companies, or null for the Super Admin console.
  // Lands in the last role used in that company on this device, if still allowed there.
  // Full reload after switching (the Awraaq pattern — avoids stale data and redirect loops).
  const switchCompany = useCallback(async (company, to = HOME_PATH) => {
    const current = getStoredUser();
    const last = current ? getLastRole(current.id, company?.id) : null;
    const role = last && company?.roles?.includes(last) ? last : null;
    const { token, user: next } = await switchCompanyRequest(company?.id || null, company ? role : 'SUPER_ADMIN');
    saveSession(token, next);
    setLastCompany(next.id, next.companyId);
    setLastRole(next.id, next.activeRole, next.companyId);
    queryClient.clear();
    window.location.replace(to);
  }, []);

  const switchRole = useCallback(async (role) => {
    const { token, user: next } = await switchRoleRequest(role);
    saveSession(token, next);
    setLastRole(next.id, next.activeRole, next.companyId);
    queryClient.clear();
    window.location.replace(HOME_PATH);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    queryClient.clear();
    window.location.replace(LOGIN_PATH);
  }, []);

  const value = useMemo(
    () => ({ user, isAuthenticated, login, logout, switchRole, switchCompany }),
    [user, isAuthenticated, login, logout, switchRole, switchCompany]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
