/**
 * Coordinate-hygiene lint for node authoring — flags the "mixed-up UV" danger
 * zones that produced the reeded_glass grain/frost coordinate bugs
 * (docs/research/2026-08-19-entanglement-audit.md, ...-grain-overlay-scope.md).
 *
 * Static heuristics over node source (a smell detector, NOT a proof — the real
 * catcher is the GPU coordinate-contract differential, see the scope note below):
 *
 *   H1 raw device coords — a node emits `gl_FragCoord` / `in.position` as shader
 *      text instead of the Y-origin-safe IR constructs `fragCoord()` /
 *      `framebufferY()`. gl_FragCoord.y is bottom-origin on WebGL2 but
 *      in.position.y is top-origin on WebGPU, so raw use risks a backend Y-flip
 *      in sampling (the classic mixed-up-UV bug). WARN.
 *
 *   H2 mixed coordinate bases — a node references BOTH a frozen-ref token
 *      (u_ref_size / auto_uv) and a screen token (u_viewport / gl_FragCoord /
 *      in.position). Legitimate for a few nodes (reeded_glass runs a dual basis
 *      on purpose) but it is exactly where seed-vs-sample space mismatches hide.
 *      INFO — review that the two bases are used deliberately, not crossed.
 *
 * Known dual-basis nodes are allowlisted from WARN→INFO so the signal stays on
 * NEW nodes. Run: npx tsx scripts/verify-coord-hygiene.ts [--strict]
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NODES_DIR = path.join(HERE, '..', 'src', 'nodes')
// Nodes that deliberately run a screen + frozen-ref dual basis (reviewed).
const DUAL_BASIS_OK = new Set(['reeded-glass.ts'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

type Finding = { file: string; check: string; severity: 'WARN' | 'INFO'; detail: string }
const findings: Finding[] = []

// Non-node infrastructure files under src/nodes (no NodeDefinition to lint).
const SKIP = new Set(['index.ts', 'registry.ts', 'types.ts', 'type-coercion.ts'])

for (const file of walk(NODES_DIR)) {
  const base = path.basename(file)
  if (SKIP.has(base)) continue
  const src = fs.readFileSync(file, 'utf8')
  // Only lint files that actually define a node.
  if (!/NodeDefinition|glsl\s*[:(]|ir\s*[:(]/.test(src)) continue

  // strip line comments so a mention in prose doesn't trip the lint
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

  // H1 — raw device coords vs the Y-origin-safe constructs
  const rawFragCoord = (code.match(/gl_FragCoord/g) || []).length
  const rawInPosition = (code.match(/in\.position/g) || []).length
  const usesConstructs = /\bfragCoord\s*\(|\bframebufferY\s*\(/.test(code)
  if (rawFragCoord + rawInPosition > 0) {
    findings.push({
      file: base, check: 'H1', severity: 'WARN',
      detail: `emits raw device coords (gl_FragCoord×${rawFragCoord}, in.position×${rawInPosition})` +
        (usesConstructs ? ' — also uses fragCoord()/framebufferY(), so verify the raw uses are Y-origin-safe' : ' and does NOT use the fragCoord()/framebufferY() IR constructs — Y-origin may differ WebGL↔WebGPU'),
    })
  }

  // H2 — mixed frozen-ref + screen bases
  const frozenRef = /u_ref_size|auto_uv/.test(code)
  const screen = /u_viewport|gl_FragCoord|in\.position/.test(code)
  if (frozenRef && screen) {
    findings.push({
      file: base, check: 'H2',
      severity: DUAL_BASIS_OK.has(base) ? 'INFO' : 'WARN',
      detail: `mixes frozen-ref (u_ref_size/auto_uv) and screen (u_viewport/fragCoord) bases` +
        (DUAL_BASIS_OK.has(base) ? ' — allowlisted dual-basis node' : ' — confirm seed vs sample coords are not crossed (this is where the grain bug lived)'),
    })
  }
}

// report
const byFile = new Map<string, Finding[]>()
for (const f of findings) { (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f) }
console.log('\nCoordinate-hygiene lint (heuristic — review, not proof)\n')
if (findings.length === 0) console.log('  ✓ no coordinate-hygiene flags')
for (const [file, fs2] of [...byFile].sort()) {
  console.log(`  ${file}`)
  for (const f of fs2) console.log(`    [${f.severity}] ${f.check}: ${f.detail}`)
}
const warns = findings.filter((f) => f.severity === 'WARN' && !DUAL_BASIS_OK.has(f.file)).length
console.log('\n' + '='.repeat(60))
console.log(`  ${findings.length} flag(s), ${warns} WARN on non-allowlisted nodes`)
console.log('  (Tier 2 — GPU coordinate-contract differential — is the real catcher; see docs/research/2026-08-19-coord-contract-scope.md)')
console.log('='.repeat(60))
process.exit(process.argv.includes('--strict') && warns > 0 ? 1 : 0)
