/**
 * Do textureInput ports declared through `dynamicInputs` become real texture
 * boundaries?
 *
 * partitionPasses' quick-check and findTextureBoundaries both iterate the static
 * `def.inputs`, while the depth loop between them resolves `dynamicInputs`. A
 * dynamically-declared texture port therefore raises pass depth but never
 * receives a sampler: the port silently falls back to its default and the
 * upstream branch is dropped from the render.
 *
 * No shipped node has dynamic texture ports (arithmetic's dynamic ports are
 * plain floats), so the producer is a synthetic node registered here.
 *
 * Run: npx tsx scripts/verify-dynamic-texture-ports.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { declare, variable, textureSample, fragCoord, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const LAYER = (i: number) => `layer_${i}`
const layerPort = (i: number) => ({
  id: LAYER(i), label: `Layer ${i}`, type: 'color' as const,
  textureInput: true, default: [0, 0, 0, 0] as [number, number, number, number],
})

/**
 * Sums every wired layer. It samples EVERY sampler present in
 * `ctx.textureSamplers`, not just the ports its own loop knows about — an
 * emitted-but-unread binding invalidates the WebGPU command encoder (audit
 * P0.2), and this node is the reference an author will copy.
 */
const testNode: NodeDefinition = {
  type: 'test_dyn_tex',
  label: 'Test Dynamic Textures',
  category: 'effect',
  // Static fallback is REQUIRED alongside dynamicInputs (NODE_AUTHORING_GUIDE.md).
  // One port, so the second one below is genuinely dynamic-only.
  inputs: [layerPort(0)],
  dynamicInputs: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.layerCount) || 1))
    return Array.from({ length: count }, (_, i) => layerPort(i))
  },
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [{ id: 'layerCount', label: 'Layers', type: 'float', default: 1, min: 1, max: 8, step: 1, hidden: true, updateMode: 'recompile' }],
  glsl: (ctx) => {
    const samplers = Object.values(ctx.textureSamplers ?? {})
    if (samplers.length === 0) return `vec4 ${ctx.outputs.color} = vec4(0.0);`
    ctx.uniforms.add('u_viewport')
    const terms = samplers.map((s) => `texture(${s}, gl_FragCoord.xy / u_viewport)`)
    return `vec4 ${ctx.outputs.color} = ${terms.join(' + ')};`
  },
  ir: (ctx) => {
    const samplers = Object.values(ctx.textureSamplers ?? {})
    if (samplers.length === 0) {
      return {
        statements: [declare(ctx.outputs.color, 'vec4', variable('vec4(0.0)'))],
        uniforms: [], standardUniforms: new Set<string>(),
      }
    }
    const uv = binary('/', fragCoord('native'), variable('u_viewport'), 'vec2')
    let acc = textureSample(samplers[0], uv, 'vec4')
    for (const s of samplers.slice(1)) {
      acc = binary('+', acc, textureSample(s, uv, 'vec4'), 'vec4')
    }
    return {
      statements: [declare(ctx.outputs.color, 'vec4', acc)],
      uniforms: [], standardUniforms: new Set<string>(['u_viewport']),
    }
  },
}
nodeRegistry.register(testNode)

// Two independent sources converge on two layer ports. layer_0 is static and
// works today; layer_1 exists only through dynamicInputs and is the bug.
const nodes = [
  n('a', 'checkerboard'),
  // 'noise' only has a float 'value' output (no 'color' port) — use 'gradient',
  // which has a real 'color' output like checkerboard, so both sources feeding
  // the two layer ports are genuinely independent color producers.
  n('b', 'gradient'),
  n('fx', 'test_dyn_tex', { layerCount: 2 }),
  n('out', 'fragment_output'),
]
const edges = [
  e('e1', 'a', 'color', 'fx', LAYER(0)),
  e('e2', 'b', 'color', 'fx', LAYER(1)),
  e('e3', 'fx', 'color', 'out', 'color'),
]

/**
 * The two backends describe bound textures DIFFERENTLY, which is easy to get
 * wrong and produces a vacuously-passing test if you do:
 *   GLSL  (glsl-generator.ts:60): inputTextures is Record<samplerName, passIndex>
 *   IR    (ir-compiler.ts:461): inputTextures is Array<{passIndex, samplerName}>
 * These helpers normalise both to a list of sampler names.
 */
const glslSamplers = (pass: { inputTextures: Record<string, number> }) =>
  Object.keys(pass.inputTextures ?? {})
const irSamplers = (pass: { inputTextures?: Array<{ samplerName: string }> }) =>
  (pass.inputTextures ?? []).map((t) => t.samplerName)

test('GLSL: every wired dynamic texture port gets a sampler', () => {
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const pass = plan.passes.find((p) => glslSamplers(p).length > 0)
  assert(!!pass, 'no pass binds any input texture — both layer ports were dropped')
  const bound = glslSamplers(pass!)
  assert(bound.length === 2,
    `expected 2 bound textures (layer_0 + layer_1), got ${bound.length}: ${JSON.stringify(bound)}`)
  // Mechanism-engaged: the shader must actually reference both samplers. A plan
  // that binds two textures while the shader samples one is still broken.
  for (const s of bound) {
    assert(pass!.fragmentShader.includes(s), `sampler ${s} bound but never sampled`)
  }
  assert(!pass!.fragmentShader.includes('undefined'),
    'shader contains "undefined" — a texture port was read through ctx.inputs')
})

test('WGSL: every wired dynamic texture port gets a sampler', () => {
  const plan = compileGraphIR(nodes, edges)
  assert(plan !== null, 'IR compile returned null (a node lacks ir(), or compilation threw)')
  const pass = plan!.passes.find((p) => irSamplers(p).length > 0)
  assert(!!pass, 'no pass binds any input texture on the IR path')
  const bound = irSamplers(pass!)
  assert(bound.length === 2,
    `expected 2 bound textures, got ${bound.length}: ${JSON.stringify(bound)}`)
  // Mechanism-engaged, mirroring the GLSL assertion above: a plan that BINDS two
  // textures while the shader SAMPLES only one still invalidates the WebGPU
  // command encoder (audit P0.2). wgsl-assembler declares each bound sampler as
  // `@group(1) @binding(n) var <samplerName>_tex: texture_2d<f32>` and
  // wgsl-backend's textureSample() lowering references that same
  // `<samplerName>_tex` identifier, so — since samplerName here already ends in
  // "_tex" (e.g. "u_pass0_tex") — the identifier actually used in the shader is
  // "u_pass0_tex_tex". Confirmed against the generated WGSL before trusting it.
  for (const s of bound) {
    assert(pass!.shaderCode.includes(`${s}_tex`), `sampler ${s} bound but never sampled`)
  }
})

// Every graph above wires the STATIC port layer_0 on every producer node, so
// partitionPasses' quick-check trips on that static port regardless of whether
// its dynamicInputs resolution is correct — reverting that resolution alone
// left the gate green. This case wires ONLY a dynamic-only port (layer_1) and
// leaves the static layer_0 empty, so the quick-check's own dynamicInputs
// branch is the sole thing that can detect a texture boundary here. Without
// the fix: the quick-check sees only the unwired static layer_0, concludes
// hasTextureBoundary === false, partitionPasses returns null, the graph
// collapses to a single pass, and every texture input on 'fx' is dropped —
// while compileGraph/compileGraphIR both still report success.
// (Wiring layer_0 here would make this vacuous — don't add it back.)
test('ONLY-dynamic port wired (static layer_0 left empty) — GLSL', () => {
  const nn = [n('b', 'gradient'), n('fx', 'test_dyn_tex', { layerCount: 2 }), n('out', 'fragment_output')]
  const ee = [e('e2', 'b', 'color', 'fx', LAYER(1)), e('e3', 'fx', 'color', 'out', 'color')]
  const plan = compileGraph(nn, ee)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const pass = plan.passes.find((p) => glslSamplers(p).length > 0)
  assert(!!pass, 'no pass binds any input texture — graph collapsed to one pass')
})

test('ONLY-dynamic port wired (static layer_0 left empty) — WGSL', () => {
  const nn = [n('b', 'gradient'), n('fx', 'test_dyn_tex', { layerCount: 2 }), n('out', 'fragment_output')]
  const ee = [e('e2', 'b', 'color', 'fx', LAYER(1)), e('e3', 'fx', 'color', 'out', 'color')]
  const plan = compileGraphIR(nn, ee)
  assert(plan !== null, 'IR compile returned null (a node lacks ir(), or compilation threw)')
  const pass = plan!.passes.find((p) => irSamplers(p).length > 0)
  assert(!!pass, 'no pass binds any input texture on the IR path — graph collapsed to one pass')
})

test('a single wired port still works (no regression)', () => {
  const oneNodes = [n('a', 'checkerboard'), n('fx', 'test_dyn_tex', { layerCount: 1 }), n('out', 'fragment_output')]
  const oneEdges = [e('e1', 'a', 'color', 'fx', LAYER(0)), e('e2', 'fx', 'color', 'out', 'color')]
  const plan = compileGraph(oneNodes, oneEdges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const pass = plan.passes.find((p) => glslSamplers(p).length > 0)
  assert(!!pass && glslSamplers(pass).length === 1, 'the static port regressed')
})

run('dynamic-texture-ports')
