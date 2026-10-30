import http from './http';

// The active company's problem list: Category > Item > Problem (step B).
export const getProblemTree = (includeInactive = false) =>
  http.get('/problems', { params: includeInactive ? { includeInactive: 1 } : {} }).then((r) => r.data);
export const setAutoAssign = (autoAssign) => http.patch('/problems/settings', { autoAssign }).then((r) => r.data);
export const createProblemRow = (level, body) => http.post(`/problems/${level}`, body).then((r) => r.data);
export const updateProblemRow = (level, id, body) => http.patch(`/problems/${level}/${id}`, body).then((r) => r.data);
