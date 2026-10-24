import http from './http';

export const loginRequest = (identifier, password) =>
  http.post('/auth/login', { identifier, password }).then((r) => r.data);

export const switchRoleRequest = (role) => http.post('/auth/switch-role', { role }).then((r) => r.data);

export const updatePreferencesRequest = (prefs) =>
  http.patch('/auth/preferences', prefs).then((r) => r.data.user);

export const meRequest = () => http.get('/auth/me').then((r) => r.data.user);

// Employee-ID users only.
export const changePasswordRequest = (currentPassword, newPassword) =>
  http.post('/auth/change-password', { currentPassword, newPassword }).then((r) => r.data);

export const forgotPasswordRequest = (employeeId) =>
  http.post('/auth/forgot-password', { employeeId }).then((r) => r.data);

export const resetPasswordRequest = (token, newPassword) =>
  http.post('/auth/reset-password', { token, newPassword }).then((r) => r.data);
