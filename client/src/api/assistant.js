import http from './http';

const base = '/assistant';

// Chat (everyone)
export const getAssistantConfig = () => http.get(`${base}/config`).then((r) => r.data);
export const startChat = (language) => http.post(`${base}/sessions`, { language }).then((r) => r.data.session);
export const askChat = (id, text) => http.post(`${base}/sessions/${id}/ask`, { text }, { timeout: 30000 }).then((r) => r.data);
export const showFaq = (id, faqId, via) => http.post(`${base}/sessions/${id}/show`, { faqId, via }).then((r) => r.data.faq);
export const chatFeedback = (id, solved) => http.post(`${base}/sessions/${id}/feedback`, { solved }).then((r) => r.data);
export const chatDraft = (id) => http.get(`${base}/sessions/${id}/draft`).then((r) => r.data.draft);

// Super Admin
export const listFaqs = (includeInactive) =>
  http.get(`${base}/faqs`, { params: includeInactive ? { includeInactive: 1 } : {} }).then((r) => r.data.faqs);
export const getFaq = (id) => http.get(`${base}/faqs/${id}`).then((r) => r.data.faq);
export const createFaq = (body) => http.post(`${base}/faqs`, body).then((r) => r.data.faq);
export const updateFaq = (id, body) => http.patch(`${base}/faqs/${id}`, body).then((r) => r.data.faq);
export function importFaqs(file, { commit = false, keepAtomEdits = true } = {}) {
  const form = new FormData();
  form.append('commit', String(commit));
  form.append('keepAtomEdits', String(keepAtomEdits));
  form.append('file', file);
  return http.post(`${base}/faqs/import`, form, { timeout: 120000 }).then((r) => r.data);
}
export const getAiSettings = () => http.get(`${base}/settings`).then((r) => r.data.settings);
export const updateAiSettings = (body) => http.patch(`${base}/settings`, body).then((r) => r.data.settings);
export const getAiUsage = (days = 30) => http.get(`${base}/usage`, { params: { days } }).then((r) => r.data);
export const dismissQuestion = (key) => http.post(`${base}/unmatched/dismiss`, { key }).then((r) => r.data);
export const listLearned = (includeOff) =>
  http.get(`${base}/learned`, { params: includeOff ? { includeOff: 1 } : {} }).then((r) => r.data.learned);
export const setLearned = (id, isActive) => http.patch(`${base}/learned/${id}`, { isActive }).then((r) => r.data.learned);
