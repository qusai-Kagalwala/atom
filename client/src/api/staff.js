import http from './http';

// The active company's staff and occupations — company Admin only.
export const listStaff = () => http.get('/staff').then((r) => r.data.staff);
export const searchPeople = (q) => http.get('/staff/people', { params: { q } }).then((r) => r.data.people);
export const addStaff = (userId, occupationId) => http.post('/staff', { userId, occupationId }).then((r) => r.data.member);
export const changeOccupation = (userId, occupationId) => http.patch(`/staff/${userId}`, { occupationId }).then((r) => r.data.member);
export const removeStaff = (userId) => http.delete(`/staff/${userId}`).then((r) => r.data);
export const listOccupations = (includeInactive = false) =>
  http.get('/staff/occupations', { params: includeInactive ? { includeInactive: 1 } : {} }).then((r) => r.data.occupations);
export const createOccupation = (body) => http.post('/staff/occupations', body).then((r) => r.data.occupation);
export const updateOccupation = (id, body) => http.patch(`/staff/occupations/${id}`, body).then((r) => r.data.occupation);
