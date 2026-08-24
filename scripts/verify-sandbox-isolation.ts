/**
 * verify-sandbox-isolation — sandbox stays out of the shipped app.
 *  (1) vite prod input is exactly { main, viewer }.
 *  (2) no file outside src/sandbox/** imports from src/sandbox/**, and main.tsx
 *      does not reach it — so no import can pull sandbox code into the app bundle.
 * Run: npx tsx scripts/verify-sandbox-isolation.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) passed++
  else { failed++; console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}

// (1) prod input allowlist — parse the input keys from vite.config.ts.
const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
const inputBlock = vite.match(/input:\s*\{([^}]*)\}/s)?.[1] ?? ''
const keys = [...inputBlock.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort()
check('prod input is exactly [main, viewer]', JSON.stringify(keys) === JSON.stringify(['main', 'viewer']), `got [${keys}]`)

// (2) import-boundary — walk src/**, skip src/sandbox/**, forbid sandbox imports.
function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}
const SANDBOX = join(ROOT, 'src/sandbox')
// Dev-only sandbox entry points at src/ root: the shell main and the codegen'd
// standalone mains. They import sandbox by design and never enter the prod
// bundle (guaranteed by the input==={main,viewer} assertion above).
const isSandboxEntry = (f: string) => /(?:^|\/)sandbox-main\.tsx$/.test(f) || /-sandbox-main\.tsx$/.test(f)
const importRe = /\bfrom\s+['"]([^'"]+)['"]/g
for (const file of walk(join(ROOT, 'src'))) {
  if (file.startsWith(SANDBOX)) continue // sandbox may import itself
  if (isSandboxEntry(file)) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(importRe)) {
    const spec = m[1]
    const hitsSandbox = spec.includes('/sandbox/') || spec === '@/sandbox' || spec.startsWith('@/sandbox/') || spec.endsWith('/sandbox')
    check(`${relative(ROOT, file)} does not import sandbox`, !hitsSandbox, spec)
  }
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
