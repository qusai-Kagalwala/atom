import axios from 'axios';
import { clearSession, getToken } from '../auth/storage';

// BASE_URL is '/Atom/' (from vite.config.js base), so every call goes to /Atom/api/...
export const API_BASE = `${import.meta.env.BASE_URL}api`;
export const LOGIN_PATH = `${import.meta.env.BASE_URL}login`;

// These answer 401 for a wrong password — that is not a lost session.
const PUBLIC_AUTH = ['/auth/login', '/auth/forgot-password', '/auth/reset-password'];
const SESSION_CODES = ['session_expired', 'removed', 'role_changed'];

const http = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
  headers: { Accept: 'application/json' },
});

http.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

let redirecting = false;

http.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url || '';
    const isPublic = PUBLIC_AUTH.some((p) => url.startsWith(p));

    if (status === 401 && !isPublic && !redirecting) {
      redirecting = true;
      const code = SESSION_CODES.includes(error.response.data?.code)
        ? error.response.data.code
        : 'session_expired';
      clearSession();
      window.location.replace(`${LOGIN_PATH}?error=${code}`);
    }
    return Promise.reject(error);
  }
);

// Server message if there is one, otherwise a plain fallback.
export function errorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error?.response) return 'Could not reach ATOM. Check your connection and try again.';
  return error.response.data?.message || fallback;
}

export default http;
