/**
 * Is the Dither node's "Dither" slider shown for exactly the shapes whose
 * shader reads it?
 *
 * The bug this pins: the param was `showWhen: { shape: 'circle' }`, but the
 * shader applies it to every SDF shape (circle, diamond, triangle) — only
 * Square has no SDF edge to dither. Diamond and Triangle were stuck at the
 * default 0.5 with no control.
 *
 * "Reads it" is derived from the COMPILED output, never from a hand list, so
 * the gate cannot drift from the code. Two independent mechanisms, both
 * backends each:
 *   (1) reference — the param's uniform is used in the shader body (GLSL
 *       `u_<id>_dither`, WGSL `uniforms.u_<id>_dither`), not merely declared.
 *       The compiler declares a uniform for every uniform-mode param whether
 *       or not the node reads it, so a declaration proves nothing.
 *   (2) value — a probe copy of the node with this one param compiled as an
 *       inlined literal: two different values must give different shaders.
 * Both mechanisms must agree on both backends, then visibility (the same
 * `matchesShowWhen` the node body uses) must equal that answer.
 *
 * Mechanism-engaged: the shape list comes from the node's own enum options,
 * and at least one shape must read the param and one must not — so a probe
 * that always (or never) reports "reads" fails instead of passing vacuously.
 *
 * Run: npm run verify:dither-visibility
 */
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { matchesShowWhen } from '../src/nodes/types'
import type { NodeData, EdgeData, NodeDefinition, NodeParameter } from '../src/nodes/types'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

const NODE = 'dither'
const PARAM = 'dither'
const ENUM = 'shape'

const def = nodeRegistry.get(NODE)!
const param = def.params!.find((p) => p.id === PARAM)!
const shapeParam = def.params!.find((p) => p.id === ENUM)!
const shapes = shapeParam.options!.map((o) => (typeof o === 'object' ? (o as { value: string }).value : String(o)))

// Probe: the same glsl()/ir() with this one param inlined as a literal, so its
// VALUE (not just a uniform name) reaches the generated text.
const PROBE = `${NODE}__value_probe`
const probeDef: NodeDefinition = {
  ...def,
  type: PROBE,
  params: def.params!.map((p): NodeParameter => (p.id === PARAM ? { ...p, updateMode: 'recompile' } : p)),
}
nodeRegistry.register(probeDef)

const N = (id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> => ({
  id, type: 'shaderNode', position: { x: 0, y: 0 },
  data: { type, params: { ...defaultParams(nodeRegistry.get(type)), ...params } },
})
const E = (s: string, sh: string, t: string, th: string) =>
  ({ id: `${s}.${sh}>${t}.${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th }) as Edge<EdgeData>

interface Compiled { glsl: string; wgsl: string }
function compile(type: string, params: Record<string, unknown>): Compiled {
  const nodes = [N('d', type, params), N('out', 'fragment_output')]
  const edges = [E('d', 'result', 'out', 'color')]
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `${type} ${JSON.stringify(params)}: GLSL compile failed: ${plan.errors.map((e) => e.message).join(' | ')}`)
  const ir = compileGraphIR(nodes, edges)
  assert(ir, `${type} ${JSON.stringify(params)}: IR compile returned null`)
  return {
    glsl: plan.passes.map((p) => p.fragmentShader).join('\n'),
    wgsl: ir!.passes.map((p) => p.shaderCode).join('\n'),
  }
}

const UNIFORM = `u_d_${PARAM}`
/** GLSL: a line naming the uniform that is not its `uniform float …;` declaration. */
const glslReads = (src: string) => src.split('\n').some((l) => new RegExp(`\\b${UNIFORM}\\b`).test(l) && !/^\s*uniform\s/.test(l))
/** WGSL: an access through the uniform block (the struct field `u_…: f32` is the declaration). */
const wgslReads = (src: string) => new RegExp(`\\buniforms\\.${UNIFORM}\\b`).test(src)

interface Row { shape: string; visible: boolean; reads: boolean }
const rows: Row[] = []

test(`the shape list is the node's own enum (${shapes.join(', ')})`, () => {
  assert(shapes.length >= 4, `expected at least square/circle/diamond/triangle, got ${shapes.join(', ')}`)
  for (const s of ['square', 'circle', 'diamond', 'triangle']) assert(shapes.includes(s), `shape enum lost '${s}'`)
})

for (const shape of shapes) {
  test(`${shape}: Dither slider visible ⇔ the shader reads it (both backends, both mechanisms)`, () => {
    const real = compile(NODE, { [ENUM]: shape })
    // The declaration is unconditional — which is exactly why it cannot be the evidence.
    assert(new RegExp(`uniform\\s+float\\s+${UNIFORM}\\b`).test(real.glsl), `${shape}: GLSL never declared ${UNIFORM}; the uniform name assumption is stale`)
    const refGlsl = glslReads(real.glsl)
    const refWgsl = wgslReads(real.wgsl)

    const a = compile(PROBE, { [ENUM]: shape, [PARAM]: 0.0 })
    const b = compile(PROBE, { [ENUM]: shape, [PARAM]: 0.73 })
    const valGlsl = a.glsl !== b.glsl
    const valWgsl = a.wgsl !== b.wgsl
    if (valGlsl) assert(b.glsl.includes('0.73'), `${shape}: GLSL changed with the value but the literal 0.73 is absent`)

    assert(refGlsl === refWgsl && refGlsl === valGlsl && valGlsl === valWgsl,
      `${shape}: evidence disagrees — GLSL ref ${refGlsl}, WGSL ref ${refWgsl}, GLSL value ${valGlsl}, WGSL value ${valWgsl}`)

    const reads = refGlsl
    const visible = !param.hidden && matchesShowWhen(param.showWhen, { [ENUM]: shape }, def.params!)
    rows.push({ shape, visible, reads })
    assert(visible === reads,
      `${shape}: the Dither slider is ${visible ? 'SHOWN' : 'HIDDEN'} but the shader ${reads ? 'READS' : 'IGNORES'} it ` +
      `(showWhen ${JSON.stringify(param.showWhen)})`)
  })
}

test('mechanism engaged: some shape reads the param and some shape ignores it', () => {
  assert(rows.length === shapes.length, `only ${rows.length}/${shapes.length} shapes reached a verdict`)
  assert(rows.some((r) => r.reads), 'no shape reads the param — the probe is blind, not the shader')
  assert(rows.some((r) => !r.reads), 'every shape reads the param — the probe cannot tell a dead param from a live one')
  console.log('  ' + rows.map((r) => `${r.shape}: reads=${r.reads} visible=${r.visible}`).join(' · '))
})

run('dither visibility')
