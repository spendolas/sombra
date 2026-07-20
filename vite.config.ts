import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// Dev-only: serve the built embed player (dist/embed/*) at /sombra/embed/* so the
// Embed Tester can load the REAL UMD bundle from this origin (prod serves it from
// GitHub Pages). Requires `npm run build:embed` first; 404s cleanly otherwise.
function serveEmbedDist(): Plugin {
  return {
    name: 'serve-embed-dist',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/sombra/embed/')) return next()
        try {
          const rel = url.split('?')[0].replace('/sombra/', '') // embed/sombra-player.x.umd.js
          const buf = readFileSync(resolve(__dirname, 'dist', rel))
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.end(buf)
        } catch {
          next() // not built yet → 404, tester shows a hint
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveEmbedDist()],
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
