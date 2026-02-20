import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/sombra/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
