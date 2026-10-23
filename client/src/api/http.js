import axios from 'axios';

// BASE_URL is '/Atom/' (from vite.config.js base), so every call goes to /Atom/api/...
export const API_BASE = `${import.meta.env.BASE_URL}api`;

const http = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { Accept: 'application/json' },
});

export default http;
