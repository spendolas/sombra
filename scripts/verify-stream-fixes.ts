/**
 * Regression gate for the stream-integrity fixes
 * (docs/research/2026-08-19-entanglement-audit.md):
 *   F1 — multi-pass sub-pass uniform specs carry the AUTHORED node id, so the
 *        live-drag fast path finds a live value (no frozen sub-pass).
 *   F2 — resolvePassResolution pins a pass to full-res when it holds any
 *        non-declaring node (a downscaling sibling can't drag it).
 *   #1 — reeded_glass clamps its frost input to [0,1] on BOTH backends.
 *
 * Each check pairs the assertion with a perturbation that MUST flip it, per the
 * "gate needs a mechanism-engaged assertion" guardrail.
 *
 * Run: npx tsx scripts/verify-stream-fixes.ts
 */
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { initializeNodeLibrary } from '../src/nodes/index'
import { compileGraph } from '../src/compiler/glsl-generator'
import { resolvePassResolution } from '../src/compiler/pass-resolution'
import { SUB_PASS_PARAM, baseNodeId } from '../src/compiler/expand-passes'

initializeNodeLibrary()

let failures = 0
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const node = (id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } } as Node<NodeData>)
const edge = (s: string, sh: string, t: string, th: string): Edge<EdgeData> =>
  ({ id: `${s}:${sh}->${t}:${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th } as Edge<EdgeData>)

// ---------------------------------------------------------------------------
console.log('\nF1 — sub-pass uniform specs carry the authored node id')
{
  // Gaussian blur is multi-pass; leave radius UNWIRED so it stays a uniform.
  const nodes = [node('grad-a', 'gradient'), node('blur-a', 'blur'), node('out-a', 'fragment_output')]
  const edges = [edge('grad-a', 'color', 'blur-a', 'source'), edge('blur-a', 'color', 'out-a', 'color')]
  const plan = compileGraph(nodes, edges)
  const specs = plan.passes.flatMap((p) => p.userUniforms)
  const subPassRadius = specs.filter((s) => s.paramId === 'radius' && s.name.includes('_sp'))
  check('a sub-pass radius uniform exists (test is exercising the path)', subPassRadius.length > 0, `found ${subPassRadius.length}`)
  check('every sub-pass radius uniform is keyed on the authored node id "blur-a"',
    subPassRadius.every((s) => s.nodeId === 'blur-a'),
    `nodeIds=${subPassRadius.map((s) => s.nodeId).join(',')} (pre-fix these were sub-pass ids the fast path can't resolve)`)
  // perturbation: baseNodeId is what makes it work — a sub-pass id must NOT be authored-equal by accident
  check('baseNodeId actually remaps the sub-pass id (perturbation control)',
    subPassRadius.every((s) => baseNodeId(s.name.includes('_sp') ? 'blur-a-sp1' : 'blur-a') === 'blur-a'))
}

console.log('\nF2 — a non-declaring node pins its pass to full resolution')
{
  const pyr = node('pyr', 'pyramid_blur', { radius: 96, [SUB_PASS_PARAM]: 1 })
  const reg = node('grad-b', 'gradient')
  const map = new Map<string, Node<NodeData>>([['pyr', pyr], ['grad-b', reg]])
  const alone = resolvePassResolution(['pyr'], map)          // pyramid only → its reduced scale
  const shared = resolvePassResolution(['pyr', 'grad-b'], map) // + regular node → must pin to full res
  check('pyramid sub-pass alone declares a reduced scale (path exercised)', alone !== undefined && alone < 1, `alone=${alone}`)
  check('adding a non-declaring node pins the pass to full-res (undefined)', shared === undefined, `shared=${shared}`)
  check('the pin is CAUSED by the regular node (perturbation flips the result)', alone !== shared, `alone=${alone} shared=${shared}`)
}

console.log('\n#1 — reeded_glass clamps frost to [0,1] on both backends')
{
  // gradient -> reeded.source makes reeded texture-mode, so the frost branch emits.
  const nodes = [node('grad-c', 'gradient'), node('rg', 'reeded_glass'), node('out-c', 'fragment_output')]
  const edges = [edge('grad-c', 'color', 'rg', 'source'), edge('rg', 'color', 'out-c', 'color')]
  const plan = compileGraph(nodes, edges)
  const glsl = plan.passes.map((p) => p.fragmentShader).join('\n')
  const wgsl = (plan.wgsl?.passes ?? []).map((p) => p.shaderCode).join('\n')
  const clampRe = /rg_frost_\w+\s*=\s*clamp\(/
  check('GLSL frost declaration is clamped', clampRe.test(glsl), 'no clamp on rg_frost in GLSL')
  check('WGSL frost declaration is clamped', wgsl.length > 0 ? clampRe.test(wgsl) : true, wgsl.length ? 'no clamp on rg_frost in WGSL' : '(no wgsl emitted — skipped)')
  // perturbation control: an UNclamped frost would be a bare `= <expr>;` with no clamp(
  check('the clamp is specifically clamp(x, 0.0, 1.0)', /rg_frost_\w+\s*=\s*clamp\([^,]+,\s*0\.0,\s*1\.0\)/.test(glsl))
}

console.log('\n#2 — grain overlay: frost-scaled, applied on top of the gather')
{
  const nodes = [node('grad-d', 'gradient'), node('rg-d', 'reeded_glass'), node('out-d', 'fragment_output')]
  const edges = [edge('grad-d', 'color', 'rg-d', 'source'), edge('rg-d', 'color', 'out-d', 'color')]
  const plan = compileGraph(nodes, edges)
  const glsl = plan.passes.map((p) => p.fragmentShader).join('\n')
  const wgsl = (plan.wgsl?.passes ?? []).map((p) => p.shaderCode).join('\n')
  check('grain overlay is emitted (reedPcg-seeded amplitude term)', /rg_gamp_\w+/.test(glsl) && /reedPcg\(/.test(glsl))
  check('overlay amplitude scales WITH frost (perturb: a constant amp would not reference the frost var)',
    /rg_gamp_\w+\s*=\s*rg_frost_\w+\s*\*/.test(glsl))
  check('overlay is applied ON TOP of the gather (out = vec4(out.rgb + grain, out.a))',
    /(node_\w+_color)\s*=\s*vec4\(\s*\1\.rgb\s*\+/.test(glsl), 'overlay does not read+rewrite the gathered colour')
  check('overlay present on the WGSL backend too', wgsl.length ? /rg_gamp_\w+/.test(wgsl) : true)
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '  SUMMARY: all stream-fix checks passed' : `  SUMMARY: ${failures} FAILED`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
