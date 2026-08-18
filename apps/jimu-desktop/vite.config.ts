import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  publicDir: fileURLToPath(new URL('../jimu-ui-preview/public', import.meta.url)),
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@jimu-preview': fileURLToPath(new URL('../jimu-ui-preview/src', import.meta.url)),
    },
  },
  plugins: [react()],
})
