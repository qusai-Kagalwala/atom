import http from './http';

// Appearance saved on the person's account. null = nothing saved yet.
export const themeRequest = () => http.get('/auth/theme').then((r) => r.data.theme);

export const saveThemeRequest = ({ theme, mode }) => http.put('/auth/theme', { theme, mode }).then((r) => r.data.theme);
