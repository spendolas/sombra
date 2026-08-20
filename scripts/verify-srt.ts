/**
 * Regression gate for the SRT single-source op-list (src/compiler/ir/srt.ts).
 * (docs/research/2026-08-20-srt-api-design-spec.md)
 *
 * emitSRT() is now the ONE place the compose order lives — both IR backends and
 * the legacy GLSL generator route through it. This gate asserts:
 *   A. single source — GLSL and WGSL emit the SAME op order (only syntax differs).
 *   B. translateSpace positions translate correctly: 'screen' applies it BEFORE
 *      the anchor/scale/rotate block (constant screen nudge); 'local' AFTER
 *      rotate (in the scaled+rotated frame). Perturbation: screen ≠ local — if
 *      translateSpace were ignored the two would be identical and this fails.
 *   C. 'local' is byte-identical to the pre-refactor hand-written lowering, so
 *      the consolidation didn't change legacy behaviour (bare uniform names; the
 *      assembler rewrites them to uniforms.* for WGSL — coord-contract:gpu
 *      proves the post-rewrite render is unchanged).
 *
 * Run: npx tsx scripts/verify-srt.ts
 */
import { emitSRT } from '../src/compiler/ir/srt'
import type { IRSpatialTransform } from '../src/compiler/ir/types'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const full = (translateSpace: 'screen' | 'local'): IRSpatialTransform => ({
  coordsVar: 'C', outputVar: 'V',
  scaleUniform: 'S', rotateUniform: 'R',
  translateXUniform: 'TX', translateYUniform: 'TY',
  translateSpace,
})

/** Tag each line by which op it is, so GLSL and WGSL can be compared structurally. */
function ops(lines: string[]): string[] {
  return lines.map((l) => {
    if (/TX/.test(l) && /C\b/.test(l)) return 'start+translate' // screen: decl includes translate
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
for (const space of ['screen', 'local'] as const) {
  const g = ops(emitSRT(full(space), 'glsl'))
  const w = ops(emitSRT(full(space), 'wgsl'))
  check(`${space}: op order identical across backends`, JSON.stringify(g) === JSON.stringify(w), `glsl=${g} wgsl=${w}`)
}

console.log('\nB. translateSpace positions translate (screen before the block, local after rotate)')
{
  const screen = emitSRT(full('screen'), 'wgsl')
  const local = emitSRT(full('local'), 'wgsl')
  const idx = (lines: string[], re: RegExp) => lines.findIndex((l) => re.test(l))
  // screen: translate is in the very first line (the declaration), before subAnchor
  check('screen: translate in the opening decl (before subAnchor)', /TX/.test(screen[0]) && /C\b/.test(screen[0]))
  check('screen: translate NOT inside the scale block', idx(screen, /TX/) < idx(screen, /\/=/))
  // local: translate after the rotate apply, before addAnchor
  const tLocal = idx(local, /-=.*TX/)
  check('local: translate after rotate', tLocal > idx(local, /\.x \* V_c/), `tLocal=${tLocal}`)
  check('local: translate before addAnchor', tLocal < idx(local, /\+= u_anchor/))
  // mechanism-engaged: the two modes MUST differ (else translateSpace is a no-op)
  check('screen ≠ local (translateSpace actually changes the emit)', JSON.stringify(screen) !== JSON.stringify(local))
}

console.log("\nC. 'local' byte-identical to the pre-refactor hand-written lowering")
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
  const got = emitSRT(full('local'), 'wgsl')
  check('local WGSL matches the canonical (pre-refactor) lines', JSON.stringify(got) === JSON.stringify(expected),
    `\n    got: ${JSON.stringify(got)}\n    exp: ${JSON.stringify(expected)}`)
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '  SUMMARY: all SRT checks passed' : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
