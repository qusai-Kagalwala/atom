import http from './http';
import { saveToken } from '../auth/storage';
import { reconnectSocket } from './socket';

export const loginRequest = (identifier, password) =>
  http.post('/auth/login', { identifier, password }).then((r) => r.data);

export const switchRoleRequest = (role) => http.post('/auth/switch-role', { role }).then((r) => r.data);

export const updatePreferencesRequest = (prefs) =>
  http.patch('/auth/preferences', prefs).then((r) => r.data.user);

export const meRequest = () => http.get('/auth/me').then((r) => r.data.user);

// Employee-ID users only. Other devices are signed out; this one gets a fresh token and stays in.
export const changePasswordRequest = (currentPassword, newPassword) =>
  http.post('/auth/change-password', { currentPassword, newPassword }).then((r) => {
    if (r.data.token) {
      saveToken(r.data.token);
      reconnectSocket();
    }
    return { message: r.data.message };
  });

export const forgotPasswordRequest = (employeeId) =>
  http.post('/auth/forgot-password', { employeeId }).then((r) => r.data);

export const resetPasswordRequest = (token, newPassword) =>
  http.post('/auth/reset-password', { token, newPassword }).then((r) => r.data);
