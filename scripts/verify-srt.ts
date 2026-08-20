/**
 * Regression gate for the SRT single-source op-list (src/compiler/ir/srt.ts).
 * (docs/research/2026-08-20-srt-api-design-spec.md)
 *
 * emitSRT() is now the ONE place the compose order lives — both IR backends and
 * the legacy GLSL generator route through it. This gate asserts:
 *   A. single source — GLSL and WGSL emit the SAME op order (only syntax differs).
 *   B. translateSpace positions translate correctly: 'world' applies it BEFORE
 *      the anchor/scale/rotate block (constant canvas nudge); 'node' AFTER
 *      rotate (in the node's scaled+rotated frame). Perturbation: world ≠ node —
 *      if translateSpace were ignored the two would be identical and this fails.
 *   C. 'node' is byte-identical to the pre-refactor hand-written lowering, so
 *      the consolidation didn't change legacy behaviour (bare uniform names; the
 *      assembler rewrites them to uniforms.* for WGSL — coord-contract:gpu
 *      proves the post-rewrite render is unchanged).
 *   D. exposeTranslateSpace reaches node params for exactly the exposed nodes.
 *   E. legacy alias migration — stored 'screen'/'local' values (pre-rename
 *      saves) normalize to 'world'/'node' and emit byte-identically.
 *
 * Run: npx tsx scripts/verify-srt.ts
 */
import { emitSRT, normalizeTranslateSpace } from '../src/compiler/ir/srt'
import type { IRSpatialTransform } from '../src/compiler/ir/types'
import { ALL_NODES } from '../src/nodes/index'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const full = (translateSpace: IRSpatialTransform['translateSpace']): IRSpatialTransform => ({
  coordsVar: 'C', outputVar: 'V',
  scaleUniform: 'S', rotateUniform: 'R',
  translateXUniform: 'TX', translateYUniform: 'TY',
  translateSpace,
})

/** Tag each line by which op it is, so GLSL and WGSL can be compared structurally. */
function ops(lines: string[]): string[] {
  return lines.map((l) => {
    if (/TX/.test(l) && /C\b/.test(l)) return 'start+translate' // world: decl includes translate
    if (/=\s*C\b/.test(l) || /=\s*C /.test(l)) return 'start'
    if (/-= u_anchor/.test(l)) return 'subAnchor'
    if (/\/=/.test(l)) return 'scale'
    if (/_rad/.test(l) && /0\.01745329/.test(l)) return 'rotate:rad'
    if (/cos\(/.test(l)) return 'rotate:cs'
    if (/\.x \* V_c/.test(l)) return 'rotate:apply'
    if (/TX/.test(l)) return 'translate'
    if (/\+= u_anchor/.test(l)) return 'addAnchor'
    return 'other'
  })
}

console.log('\nA. single source — GLSL and WGSL emit the same op order')
for (const space of ['world', 'node'] as const) {
  const g = ops(emitSRT(full(space), 'glsl'))
  const w = ops(emitSRT(full(space), 'wgsl'))
  check(`${space}: op order identical across backends`, JSON.stringify(g) === JSON.stringify(w), `glsl=${g} wgsl=${w}`)
}

console.log('\nB. translateSpace positions translate (world before the block, node after rotate)')
{
  const world = emitSRT(full('world'), 'wgsl')
  const node = emitSRT(full('node'), 'wgsl')
  const idx = (lines: string[], re: RegExp) => lines.findIndex((l) => re.test(l))
  // world: translate is in the very first line (the declaration), before subAnchor
  check('world: translate in the opening decl (before subAnchor)', /TX/.test(world[0]) && /C\b/.test(world[0]))
  check('world: translate NOT inside the scale block', idx(world, /TX/) < idx(world, /\/=/))
  // node: translate after the rotate apply, before addAnchor
  const tNode = idx(node, /-=.*TX/)
  check('node: translate after rotate', tNode > idx(node, /\.x \* V_c/), `tNode=${tNode}`)
  check('node: translate before addAnchor', tNode < idx(node, /\+= u_anchor/))
  // mechanism-engaged: the two modes MUST differ (else translateSpace is a no-op)
  check('world ≠ node (translateSpace actually changes the emit)', JSON.stringify(world) !== JSON.stringify(node))
}

console.log("\nC. 'node' byte-identical to the pre-refactor hand-written lowering")
{
  const expected = [
    'var V: vec2f = C - u_anchor;',
    'V /= vec2f(S);',
    'let V_rad: f32 = R * 0.01745329;',
    'let V_c: f32 = cos(V_rad); let V_s: f32 = sin(V_rad);',
    'V = vec2f(V.x * V_c - V.y * V_s, V.x * V_s + V.y * V_c);',
    'V -= vec2f(TX, -(TY)) / (u_dpr * u_ref_size);',
    'V += u_anchor;',
  ]
  const got = emitSRT(full('node'), 'wgsl')
  check('node WGSL matches the canonical (pre-refactor) lines', JSON.stringify(got) === JSON.stringify(expected),
    `\n    got: ${JSON.stringify(got)}\n    exp: ${JSON.stringify(expected)}`)
}

console.log('\nD. exposeTranslateSpace reaches node params')
// The flag lives on the node's `spatial:` field, but params come from a SEPARATE
// getSpatialParams({...}) call literal — the two drift trivially (they did: the
// param was set on spatial: yet never passed to the call, so it never rendered).
// This asserts the wiring end-to-end. Mechanism-engaged: drop the flag from any of
// the 5 calls and this fails (verified — that was the shipped bug).
{
  const exposed = new Set(['noise', 'fbm', 'stripes', 'dots', 'checkerboard'])
  for (const n of ALL_NODES) {
    const p = n.params?.find((x) => x.id === 'srt_translateSpace')
    if (exposed.has(n.type)) {
      check(`${n.type}: Offset Space param present`, !!p,
        'exposeTranslateSpace is on spatial: but not passed to the getSpatialParams() call')
      if (p) {
        check(`${n.type}: World/node values with default world`,
          p.default === 'world' && JSON.stringify(p.options?.map((o) => o.value)) === '["world","node"]',
          `default=${String(p.default)} options=${JSON.stringify(p.options)}`)
      }
    } else if (p) {
      check(`${n.type}: does not leak Offset Space param`, false, 'unexpected srt_translateSpace')
    }
  }
}

console.log("\nE. legacy alias migration — 'screen'→'world', 'local'→'node'")
{
  check("normalize('screen') === 'world'", normalizeTranslateSpace('screen') === 'world')
  check("normalize('local') === 'node'", normalizeTranslateSpace('local') === 'node')
  check("normalize(undefined) === 'world' (default)", normalizeTranslateSpace(undefined) === 'world')
  check("normalize('garbage') === 'world' (safe fallback)", normalizeTranslateSpace('garbage') === 'world')
  for (const lang of ['glsl', 'wgsl'] as const) {
    check(`${lang}: legacy 'screen' emits byte-identically to 'world'`,
      JSON.stringify(emitSRT(full('screen'), lang)) === JSON.stringify(emitSRT(full('world'), lang)))
    check(`${lang}: legacy 'local' emits byte-identically to 'node'`,
      JSON.stringify(emitSRT(full('local'), lang)) === JSON.stringify(emitSRT(full('node'), lang)))
  }
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '  SUMMARY: all SRT checks passed' : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
