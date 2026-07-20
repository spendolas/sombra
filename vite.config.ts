import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/sombra/',
  server: {
    // Allow access over the Tailscale tailnet (leading dot = this tailnet + all
    // its device hostnames, e.g. grater.tail59ddf4.ts.net).
    allowedHosts: ['.tail59ddf4.ts.net'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
        dsPreview: resolve(__dirname, 'ds-preview.html'),
        embedTester: resolve(__dirname, 'embed-tester.html'),
      },
    },
  },
})
