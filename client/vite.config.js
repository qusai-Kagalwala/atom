import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ATOM is served at https://marol.jameasaifiyah.edu/Atom — keep this exact spelling everywhere.
const BASE_PATH = '/Atom/';
const API_TARGET = process.env.ATOM_API_URL || 'http://localhost:3000';

// One version number for the whole app: server/package.json.
const serverPkg = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: BASE_PATH,
  plugins: [react()],
  define: {
    'import.meta.env.VITE_ATOM_VERSION': JSON.stringify(serverPkg.version),
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: ['.', '../shared'] },
    proxy: {
      '/Atom/api': { target: API_TARGET },
      '/Atom/socket.io': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
