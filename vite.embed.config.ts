import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync } from 'fs'
import type { Plugin } from 'vite'
import { EMBED_VERSION } from './src/embed/version'

// MUTABLE ALIASES (opt-in convenience, no SRI possible): after the player is written, copy it to
//   sombra-player.latest.umd.js   = the newest release
//   sombra-player.<major>.umd.js  = the newest release of the current major (e.g. .0.)
// They are plain copies (GitHub Pages is static), refreshed on every deploy. The released,
// versioned files stay immutable and are unaffected. `npm run verify:embed-integrity` enforces
// that each alias equals the newest registered release of its line. For an OLDER major the
// alias is frozen in public/embed/ when that major is superseded (the gate says so).
// Names live here, not in src/embed/version.ts: that file is bundled into the player, and
// released player bytes must not change.
function embedAliases(): Plugin {
  return {
    name: 'embed-aliases',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist/embed')
      const src = resolve(dir, `sombra-player.${EMBED_VERSION}.umd.js`)
      const major = EMBED_VERSION.split('.')[0]
      copyFileSync(src, resolve(dir, 'sombra-player.latest.umd.js'))
      copyFileSync(src, resolve(dir, `sombra-player.${major}.umd.js`))
    },
  }
}

// Self-contained UMD player for the copy-paste CDN snippet. Kept separate from
// the main app build (vite.config.ts) so it pulls in NO React/compiler/nodes.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [embedAliases()],
  // Don't copy public/ here — this is a library build that only emits the player
  // UMD. The app build already copies public/ into dist/. Leaving the default
  // publicDir would re-copy all of public/ INTO dist/embed/ (nesting subfolders +
  // dumping root assets) — keep dist/embed/ to just the player.
  publicDir: false,
  build: {
    outDir: 'dist/embed',
    // false on purpose: the main build copies public/embed/ (frozen older player
    // versions that existing snippets still reference) into dist/embed/ first; emptying
    // would delete them. The main build already cleans dist/ itself.
    emptyOutDir: false,
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
