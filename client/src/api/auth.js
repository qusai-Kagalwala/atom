import http from './http';
import { saveToken } from '../auth/storage';
import { reconnectSocket } from './socket';

// keep: "Keep me signed in on this device" (default sign-out after 8 hours).
export const loginRequest = (identifier, password, keep = false) =>
  http.post('/auth/login', { identifier, password, keep }).then((r) => r.data);

export const signOutEverywhereRequest = () => http.post('/auth/sign-out-everywhere').then((r) => r.data);
// How I get notified: { inApp, email } — at least one on.
export const setNotifyRequest = (prefs) => http.patch('/auth/notify', prefs).then((r) => r.data.notify);

export const switchRoleRequest = (role) => http.post('/auth/switch-role', { role }).then((r) => r.data);

// Before sign-in: the companies the Super Admin has open (login page subtitle).
export const openCompaniesRequest = () => http.get('/auth/open-companies').then((r) => r.data.companies);
// Company picker (decided 28 Oct 2026): every open company with this person's roles there (the Super
// Admin also gets closed ones, isOpen false).
export const companiesRequest = () => http.get('/auth/companies').then((r) => r.data.companies);
// companyId null = no company (Super Admin console). role optional: the highest one there by default.
export const switchCompanyRequest = (companyId, role) =>
  http.post('/auth/switch', { companyId: companyId || null, role: role || null }).then((r) => r.data);

export const updatePreferencesRequest = (prefs) =>
  http.patch('/auth/preferences', prefs).then((r) => r.data.user);

// Your own email / mobile (7 Nov 2026). '' clears. → the fresh session user.
export const updateContactRequest = (contact) => http.patch('/auth/contact', contact).then((r) => r.data.user);

export const meRequest = () => http.get('/auth/me').then((r) => r.data.user);
// The whole answer: { user, keepSignedIn } (Profile → Signed in).
export const sessionRequest = () => http.get('/auth/me').then((r) => r.data);

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
