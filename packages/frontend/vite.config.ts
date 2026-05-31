import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://localhost:8080',
        changeOrigin: true,
        timeout: 3600000, // 1 hour — pipeline SSE streams can run very long
      },
    },
  },
  build: {
    // Main chunk was 1.6 MB before splitting because Recharts + Chakra +
    // jspdf + xlsx + html2canvas all rolled into index.js. Manual chunks
    // keep heavy export/visualization deps in their own files so the
    // initial route doesn't pay for them.
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-chakra': ['@chakra-ui/react', '@emotion/react', '@emotion/styled', 'framer-motion'],
          'vendor-charts': ['recharts'],
          'vendor-export-pdf': ['jspdf', 'html2canvas', 'jszip'],
          'vendor-export-xlsx': ['xlsx'],
          'vendor-query': ['@tanstack/react-query', 'zustand'],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
