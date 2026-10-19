import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The backend serves `dist/` as static files in production, so the deployed
// system is a single process on a single port. During development the Vite dev
// server proxies /api through to the backend instead.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8800',
        changeOrigin: true,
      },
    },
  },
})
