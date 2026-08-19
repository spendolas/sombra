/**
 * Regression gate for F7 — WGSL sombra_mod overload emission.
 * (docs/research/2026-08-19-entanglement-audit.md)
 *
 * WGSL has no mod() and cannot overload a user fn by signature, so the helper is
 * name-per-type (sombra_mod / _v2 / _v3 / _v4). The fix names the call by result
 * type at lowering and emits exactly the helpers whose call names appear — vs the
 * old brittle regex that guessed from `sombra_mod(vec2f(`-shaped text and
 * silently omitted the helper for a vector mod written any other way (Tint then
 * rejected the module with no error thrown — the b56c19c silent-fail class).
 *
 * Run: npx tsx scripts/verify-wgsl-mod.ts
 */
import { lowerExprToWGSL } from '../src/compiler/ir/wgsl-backend'
import { assembleWGSL } from '../src/compiler/ir/wgsl-assembler'
import { call, construct, literal, declare } from '../src/compiler/ir/types'
import type { IRNodeOutput, IRType } from '../src/compiler/ir/types'

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const vec = (t: IRType) => construct(t, [literal('float', 1)])

console.log('\nA. backend names the mod call by result type (deterministic)')
{
  const nameOf = (t: IRType) => lowerExprToWGSL(call('mod', [vec(t), vec(t)], t))
  check('float → sombra_mod(', /\bsombra_mod\(/.test(nameOf('float')) && !/sombra_mod_v/.test(nameOf('float')))
  check('vec2 → sombra_mod_v2(', /\bsombra_mod_v2\(/.test(nameOf('vec2')), nameOf('vec2'))
  check('vec3 → sombra_mod_v3(', /\bsombra_mod_v3\(/.test(nameOf('vec3')), nameOf('vec3'))
  check('vec4 → sombra_mod_v4(', /\bsombra_mod_v4\(/.test(nameOf('vec4')), nameOf('vec4'))
  // perturbation: the type literally drives the name
  check('type drives the name (v2 ≠ v3 emitted names)', /_v2\(/.test(nameOf('vec2')) && /_v3\(/.test(nameOf('vec3')))
}

console.log('\nB. vector mod(vec, scalarLiteral) promotes the scalar to the vector ctor')
{
  const out = lowerExprToWGSL(call('mod', [construct('vec2', [literal('float', 3)]), literal('float', 8)], 'vec2'))
  check('scalar arg wrapped in vec2f(...) so both args match', /sombra_mod_v2\(\s*vec2f\([^)]*\)\s*,\s*vec2f\(/.test(out), out)
}

console.log('\nC. assembler emits exactly the helpers whose call names appear (no orphan, no extra)')
function assemble(stmts: ReturnType<typeof declare>[]): string {
  const out: IRNodeOutput = { statements: stmts, uniforms: [], standardUniforms: new Set() }
  return assembleWGSL([out], new Set(), []).shaderCode
}
const noOrphan = (src: string) => {
  for (const suffix of ['', '_v2', '_v3', '_v4']) {
    const called = new RegExp(`\\bsombra_mod${suffix}\\(`).test(src)
    const defined = new RegExp(`\\bfn sombra_mod${suffix}\\b`).test(src)
    if (called && !defined) return `orphan: sombra_mod${suffix}( called with no fn definition`
  }
  return ''
}
{
  const v2 = assemble([declare('t', 'vec2', call('mod', [vec('vec2'), vec('vec2')], 'vec2'))])
  check('vec2 mod → fn sombra_mod_v2 emitted', /\bfn sombra_mod_v2\b/.test(v2))
  check('vec2 mod → no orphan helper', noOrphan(v2) === '', noOrphan(v2))

  const scalar = assemble([declare('t', 'float', call('mod', [literal('float', 5), literal('float', 2)], 'float'))])
  check('scalar mod → fn sombra_mod emitted', /\bfn sombra_mod\b/.test(scalar))
  check('scalar mod → v2 helper NOT emitted (no extra/dead overloads)', !/\bfn sombra_mod_v2\b/.test(scalar))
  check('scalar mod → no orphan helper', noOrphan(scalar) === '', noOrphan(scalar))
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '  SUMMARY: all WGSL-mod checks passed' : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
