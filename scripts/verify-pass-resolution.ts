/**
 * Does a node's declared per-pass scale reach the RenderPlan, on BOTH codegen
 * paths?
 *
 * No shipped node declares a scale (that is deliberate — this change is
 * plumbing), so the producer is a synthetic node registered here. A data field
 * nothing can write cannot be verified, and an unverifiable field is how a
 * harness ends up silently vacuous.
 *
 * Run: npx tsx scripts/verify-pass-resolution.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { declare, variable } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

// A three-pass node whose sub-passes ask for 0.5, 0.25 and 1 (in chain order).
// Modelled on src/nodes/effect/blur.ts, the real multiPass consumer.
//
// The LAST sub-pass asks for 1, not a further-downscaled value, because it is
// the one whose output reaches fragment_output directly: fragment_output's
// 'color' input isn't a textureInput port (src/nodes/output/fragment-output.ts),
// so nothing separates that sub-pass from the compiler's actual final
// RenderPass, and the renderers give the final pass the canvas's own pixel
// size (e.g. src/webgl/renderer.ts renderMultiPass: `isLast` binds the default
// framebuffer and viewports to `w,h` — no later blit-back-up step exists). A
// well-behaved multiPass node keeps its output-facing sub-pass at full
// resolution and only shrinks the genuinely intermediate ones — so the test
// below asserts the same thing.
const PYRAMID_SCALES = [0.5, 0.25, 1]
const testNode: NodeDefinition = {
  type: 'test_pyramid',
  label: 'Test Pyramid',
  category: 'effect',
  multiPass: {
    count: () => 3,
    from: 'color',
    to: 'source',
    resolution: (passIndex) => PYRAMID_SCALES[passIndex] ?? 1,
  },
  inputs: [{ id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [],
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.source};`,
  ir: (ctx) => ({
    statements: [declare(ctx.outputs.color, 'vec4', variable(ctx.inputs.source))],
    uniforms: [],
    standardUniforms: new Set<string>(),
  }),
}

nodeRegistry.register(testNode)

const nodes = [n('src', 'checkerboard'), n('fx', 'test_pyramid'), n('out', 'fragment_output')]
const edges = [
  e('e1', 'src', 'color', 'fx', 'source'),
  e('e2', 'fx', 'color', 'out', 'color'),
]

test('GLSL plan carries a resolution per pass', () => {
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const scales = plan.passes.map((p) => p.resolution)
  assert(scales.includes(0.5), `expected a 0.5 pass, got ${JSON.stringify(scales)}`)
  assert(scales.includes(0.25), `expected a 0.25 pass, got ${JSON.stringify(scales)}`)
  const last = plan.passes[plan.passes.length - 1]
  assert(last.resolution === undefined || last.resolution === 1,
    `final pass must be full resolution, got ${last.resolution}`)
})

test('WGSL plan carries the same resolutions', () => {
  const plan = compileGraph(nodes, edges)
  // compileGraph() alone never populates plan.wgsl — every real caller
  // (compiler.worker.ts, viewer.ts, embed/publish.ts) merges compileGraphIR()
  // into it manually, e.g. src/embed/publish.ts:48
  // `if (wgsl) plan.wgsl = { passes: wgsl.passes }`. Mirror that here rather
  // than assuming compileGraph does it.
  const wgslResult = compileGraphIR(nodes, edges)
  if (wgslResult) plan.wgsl = { passes: wgslResult.passes }
  assert(!!plan.wgsl, 'no wgsl half in the plan')
  const glsl = plan.passes.map((p) => p.resolution ?? 1)
  const wgsl = plan.wgsl!.passes.map((p) => p.resolution ?? 1)
  assert(JSON.stringify(glsl) === JSON.stringify(wgsl),
    `backends disagree: GLSL ${JSON.stringify(glsl)} vs WGSL ${JSON.stringify(wgsl)}`)
})

test('IR compiler emits resolution directly', () => {
  const res = compileGraphIR(nodes, edges)
  assert(!!res, 'IR compile failed')
  const scales = res!.passes.map((p) => p.resolution ?? 1)
  assert(scales.includes(0.5) && scales.includes(0.25),
    `expected 0.5 and 0.25, got ${JSON.stringify(scales)}`)
})

test('a graph with no declaring node has no resolution anywhere', () => {
  const plain = [n('s', 'checkerboard'), n('o', 'fragment_output')]
  const plainEdges = [e('pe', 's', 'color', 'o', 'color')]
  const plan = compileGraph(plain, plainEdges)
  assert(plan.passes.every((p) => p.resolution === undefined),
    'an undeclared graph must leave the field absent, not default it to 1')
})

await run('pass-resolution')
