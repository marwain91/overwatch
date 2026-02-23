import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || 3010}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || 3010}`,
        ws: true,
      },
      '/health': {
        target: `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || 3010}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
