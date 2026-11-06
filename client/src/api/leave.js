import http from './http';

// Staff leave (6 Nov 2026). Staff: their own leave. The Admin (or someone given "Staff leave"): everyone's.
export const myLeave = () => http.get('/leave/mine').then((r) => r.data);
export const applyLeave = (body) => http.post('/leave', body).then((r) => r.data.leave);
export const cancelLeave = (id, note) => http.post(`/leave/${id}/cancel`, { note }).then((r) => r.data.leave);
export const listLeave = (view) => http.get('/leave', { params: { view } }).then((r) => r.data);
export const staffBoard = () => http.get('/leave/staff').then((r) => r.data);
export const decideLeave = (id, decision, note) => http.post(`/leave/${id}/decide`, { decision, note }).then((r) => r.data.leave);
