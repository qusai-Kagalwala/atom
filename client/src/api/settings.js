import http from './http';

// Super Admin settings (time frames per priority, email notifications).
export const getSettings = () => http.get('/settings').then((r) => r.data);
export const saveTimeFrames = (targets) => http.patch('/settings/time-frames', { targets }).then((r) => r.data.timeFrames);
export const setEmailEnabled = (enabled) => http.patch('/settings/email', { enabled }).then((r) => r.data.email);
