import { defineConfig } from 'vite'
import { resolve } from 'path'
import { EMBED_VERSION } from './src/embed/version'

// Self-contained UMD player for the copy-paste CDN snippet. Kept separate from
// the main app build (vite.config.ts) so it pulls in NO React/compiler/nodes.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/embed',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/embed/index.ts'),
      name: 'Sombra',
      formats: ['umd'],
      fileName: () => `sombra-player.${EMBED_VERSION}.umd.js`,
    },
    rollupOptions: {
      output: { inlineDynamicImports: true }, // both renderer backends in one file
    },
  },
})
