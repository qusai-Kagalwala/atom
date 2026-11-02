import http from './http';

// Super Admin settings (time frames per priority, email notifications).
export const getSettings = () => http.get('/settings').then((r) => r.data);
export const saveTimeFrames = (targets) => http.patch('/settings/time-frames', { targets }).then((r) => r.data.timeFrames);
// Open / close companies (closed: hidden from everyone but the Super Admin; at least one stays open).
export const listCompanySettings = () => http.get('/settings/companies').then((r) => r.data.companies);
export const setCompanyOpen = (code, isOpen) => http.patch(`/settings/companies/${code}`, { isOpen }).then((r) => r.data.companies);
export const setEmailEnabled = (enabled) => http.patch('/settings/email', { enabled }).then((r) => r.data.email);
