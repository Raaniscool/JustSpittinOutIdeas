import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = process.env.PORT || 8787;

// Dev server: the browser talks to Vite, Vite proxies /api and /events to the
// IdeaLab backend, which in turn talks to Ollama. The browser never needs to
// reach Ollama directly (no CORS / private-network headaches).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: {
    alias: {
      // one scoring implementation shared by server and browser
      '@shared': path.resolve(here, 'shared'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT || 5173),
    allowedHosts: true,
    fs: { allow: [here] },
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/events': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
