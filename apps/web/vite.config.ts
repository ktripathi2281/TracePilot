import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite` serves the UI on :5173 and proxies /api to `tracepilot serve` (default :4318).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:4318' } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
});
