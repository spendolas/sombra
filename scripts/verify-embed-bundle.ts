/**
 * verify-embed-bundle — the player must not bundle React/xyflow/compiler/nodes,
 * and must stay under a size budget. Run AFTER `npm run build:embed`.
 * Run: npx tsx scripts/verify-embed-bundle.ts
 */
import { readFileSync, statSync } from 'fs'
import { gzipSync } from 'zlib'
import { EMBED_VERSION } from '../src/embed/version'

const path = `dist/embed/sombra-player.${EMBED_VERSION}.umd.js`
let passed = 0, failed = 0
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) }
}

let src = ''
try { src = readFileSync(path, 'utf8') } catch { console.error(`  [FAIL] missing ${path} — run npm run build:embed first`); process.exit(1) }

// Forbidden markers — identifiers that only appear if the wrong module tree got pulled in.
const forbidden = ['react-dom', '@xyflow', 'ALL_NODES', 'initializeNodeLibrary', 'compileGraph', 'react/jsx-runtime']
for (const f of forbidden) check(`no "${f}" in bundle`, !src.includes(f))

const raw = statSync(path).size
const gz = gzipSync(src).length
console.log(`  size: ${(raw / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip`)
check('gzip under 250 KB budget', gz < 250 * 1024)

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
