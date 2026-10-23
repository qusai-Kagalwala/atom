import http from './http';

export const loginRequest = (identifier, password) =>
  http.post('/auth/login', { identifier, password }).then((r) => r.data);

export const switchRoleRequest = (role) => http.post('/auth/switch-role', { role }).then((r) => r.data);

export const meRequest = () => http.get('/auth/me').then((r) => r.data.user);
