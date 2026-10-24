import http from './http';

export const listNotifications = (params) => http.get('/notifications', { params }).then((r) => r.data);
export const unreadNotifications = () => http.get('/notifications/unread-count').then((r) => r.data.unread);
export const markNotificationRead = (id) => http.post(`/notifications/${id}/read`).then((r) => r.data.unread);
export const markAllNotificationsRead = () => http.post('/notifications/read-all').then((r) => r.data.unread);
