import { defineConfig } from 'vite'
import { resolve } from 'path'
import { EMBED_VERSION } from './src/embed/version'

// Self-contained UMD player for the copy-paste CDN snippet. Kept separate from
// the main app build (vite.config.ts) so it pulls in NO React/compiler/nodes.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  // Don't copy public/ here — this is a library build that only emits the player
  // UMD. The app build already copies public/ into dist/. Leaving the default
  // publicDir would re-copy all of public/ INTO dist/embed/ (nesting subfolders +
  // dumping root assets) — keep dist/embed/ to just the player.
  publicDir: false,
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
