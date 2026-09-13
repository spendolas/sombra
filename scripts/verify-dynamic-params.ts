/**
 * Do parameters declared through `dynamicParams` reach codegen and change
 * detection?
 *
 * Nine call sites iterate `definition.params` directly. Any one of them left
 * unresolved makes a dynamic param silently absent: the shader compiles, the
 * uniform is never declared, and the control does nothing. The failure is
 * invisible, which is why this gate asserts uniform NAMES rather than success.
 *
 * Fixture covers three kinds of dynamic param, one per pair of call sites:
 *   - `gain_i`   — connectable, uniform-mode   → sites 4, 5, 7 (pass depth +
 *                  both codegen paths' connectable-param loops)
 *   - `bias_0`   — non-connectable, uniform-mode → sites 6, 8 (both codegen
 *                  paths' non-connectable-uniform-param loops)
 *   - `renderMode_0` — renderer-mode            → site 3 (buildRendererKey)
 * plus `buildSemanticKey` (param count, sites 1) and `buildUniformKey`
 * (site 2). Site 9 (ShaderNode.tsx `allParams`) is a React render path this
 * script never exercises — see task-4-report.md for why it is left
 * uncovered rather than faked.
 *
 * Run: npx tsx scripts/verify-dynamic-params.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph, partitionPasses } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { buildSemanticKey, buildUniformKey, buildRendererKey } from '../src/compiler/param-keys'
import { topologicalSort } from '../src/compiler/topological-sort'
import { declare, variable, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const gain = (i: number): NodeParameter => ({
  id: `gain_${i}`, label: `Gain ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

// Non-connectable dynamic uniform param — covers sites 6/8 (the
// non-connectable-uniform-param loops in glsl-generator.ts/ir-compiler.ts),
// which `gain_i` cannot reach because it is connectable.
const bias = (i: number): NodeParameter => ({
  id: `bias_${i}`, label: `Bias ${i}`, type: 'float', default: 0,
  min: -1, max: 1, step: 0.01, connectable: false, updateMode: 'uniform',
})

// Renderer-mode dynamic param — covers site 3 (buildRendererKey), which
// neither gain_i (uniform-mode) nor bias_i (uniform-mode) can reach.
const renderMode = (i: number): NodeParameter => ({
  id: `renderMode_${i}`, label: `Render Mode ${i}`, type: 'float', default: 0,
  min: 0, max: 1, step: 1, connectable: false, updateMode: 'renderer',
})

/** Multiplies its colour input by the product of N per-instance gains, plus a bias. */
const testNode: NodeDefinition = {
  type: 'test_dyn_params',
  label: 'Test Dynamic Params',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  // Static fallback, as dynamicInputs requires of ports. Deliberately omits
  // bias_0/renderMode_0 — they exist ONLY through dynamicParams, same as
  // gain_1/gain_2, so a call site that reads the static array instead of
  // resolveParams() cannot see them either.
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return [
      ...Array.from({ length: count }, (_, i) => gain(i)),
      bias(0),
      renderMode(0),
    ]
  },
  glsl: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    const biases = Object.keys(ctx.inputs).filter((k) => k.startsWith('bias_'))
    let acc = gains.map((g) => ctx.inputs[g]).join(' * ')
    for (const b of biases) acc = `(${acc}) + ${ctx.inputs[b]}`
    return `vec4 ${ctx.outputs.color} = ${ctx.inputs.color} * (${acc});`
  },
  ir: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    const biases = Object.keys(ctx.inputs).filter((k) => k.startsWith('bias_'))
    let acc = variable(ctx.inputs[gains[0]])
    for (const g of gains.slice(1)) acc = binary('*', acc, variable(ctx.inputs[g]), 'float')
    for (const b of biases) acc = binary('+', acc, variable(ctx.inputs[b]), 'float')
    return {
      statements: [declare(ctx.outputs.color, 'vec4',
        binary('*', variable(ctx.inputs.color), acc, 'vec4'))],
      uniforms: [], standardUniforms: new Set<string>(),
    }
  },
}
nodeRegistry.register(testNode)

const graph = (gainCount: number, overrides: Record<string, unknown> = {}) => {
  const nodes = [
    n('src', 'checkerboard'),
    n('fx', 'test_dyn_params', { gainCount, ...overrides }),
    n('out', 'fragment_output'),
  ]
  const edges = [e('e1', 'src', 'color', 'fx', 'color'), e('e2', 'fx', 'color', 'out', 'color')]
  return { nodes, edges }
}

test('GLSL: every dynamic param becomes a uniform', () => {
  const { nodes, edges } = graph(3)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const names = plan.passes.flatMap((p) => p.userUniforms.map((u) => u.name))
  for (const i of [0, 1, 2]) {
    assert(names.some((nm) => nm.includes(`gain_${i}`)),
      `gain_${i} never became a uniform. Got: ${JSON.stringify(names)}`)
  }
})

test('WGSL: every dynamic param becomes a uniform', () => {
  const { nodes, edges } = graph(3)
  const plan = compileGraphIR(nodes, edges)
  // compileGraphIR returns WGSLMultiPassOutput | null — it has NO `success` or
  // `errors` field (ir-compiler.ts:483). null is its only failure signal.
  assert(plan !== null, 'IR compile returned null')
  // WGSLPassOutput has no `userUniforms` field (GLSL-only) — read the actual
  // GPU buffer layout names instead, and confirm each is referenced in the
  // generated shader body (declared-but-unused would still be a bug).
  const names = plan!.passes.flatMap((p) => [...p.uniformLayout.offsets.keys()])
  for (const i of [0, 1, 2]) {
    const found = names.some((nm) => nm.includes(`gain_${i}`))
    assert(found, `gain_${i} never became a uniform on the IR path. Got: ${JSON.stringify(names)}`)
    if (found) {
      const name = names.find((nm) => nm.includes(`gain_${i}`))!
      const referenced = plan!.passes.some((p) => p.shaderCode.includes(name))
      assert(referenced, `gain_${i} uniform "${name}" is declared but never referenced in shaderCode`)
    }
  }
})

test('GLSL: a non-connectable dynamic param becomes a uniform', () => {
  // Covers site 6 (glsl-generator.ts's non-connectable-uniform-param loop).
  // bias_0 is connectable:false, so gain's connectable-loop tests (site 5)
  // can't accidentally cover this — and bias_0 is absent from the static
  // `params` fallback, so a site reading that fallback instead of
  // resolveParams() cannot see it either.
  const { nodes, edges } = graph(3)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const names = plan.passes.flatMap((p) => p.userUniforms.map((u) => u.name))
  const name = names.find((nm) => nm.includes('bias_0'))
  assert(name, `bias_0 never became a uniform. Got: ${JSON.stringify(names)}`)
  const referenced = plan.passes.some((p) => p.fragmentShader.includes(name!))
  assert(referenced, `bias_0 uniform "${name}" is declared but never referenced in fragmentShader`)
})

test('WGSL: a non-connectable dynamic param becomes a uniform', () => {
  // Covers site 8 (ir-compiler.ts's non-connectable-uniform-param loop).
  const { nodes, edges } = graph(3)
  const plan = compileGraphIR(nodes, edges)
  assert(plan !== null, 'IR compile returned null')
  const names = plan!.passes.flatMap((p) => [...p.uniformLayout.offsets.keys()])
  const name = names.find((nm) => nm.includes('bias_0'))
  assert(name, `bias_0 never became a uniform on the IR path. Got: ${JSON.stringify(names)}`)
  const referenced = plan!.passes.some((p) => p.shaderCode.includes(name!))
  assert(referenced, `bias_0 uniform "${name}" is declared but never referenced in shaderCode`)
})

test('uniformKey reacts to a dynamic param value', () => {
  const a = buildUniformKey(graph(3).nodes)
  const b = buildUniformKey(graph(3, { gain_2: 0.25 }).nodes)
  assert(a !== b,
    'uniformKey ignored a dynamic param — dragging that slider would not reach the GPU')
})

test('rendererKey reacts to a dynamic renderer-mode param value', () => {
  // Covers site 3 (buildRendererKey). The two graphs differ ONLY in
  // renderMode_0's value (same gainCount, same everything else), so any
  // difference in the resulting keys must come from that param.
  const a = buildRendererKey(graph(3, { renderMode_0: 0 }).nodes)
  const b = buildRendererKey(graph(3, { renderMode_0: 1 }).nodes)
  assert(a !== b,
    'rendererKey ignored a dynamic renderer-mode param — a renderer-only setting would not reach the renderer')
})

test('semanticKey reacts to the param COUNT', () => {
  const a = buildSemanticKey(graph(2).nodes, graph(2).edges)
  const b = buildSemanticKey(graph(3).nodes, graph(3).edges)
  assert(a !== b,
    'semanticKey ignored the param count — adding a layer would not recompile')
})

test('a node without dynamicParams is unaffected', () => {
  const nodes = [n('src', 'checkerboard'), n('out', 'fragment_output')]
  const edges = [e('e1', 'src', 'color', 'out', 'color')]
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `static-param node regressed: ${JSON.stringify(plan.errors)}`)
})

// ---------------------------------------------------------------------------
// Site 4 — partitionPasses' connectable-param depth loop
// ---------------------------------------------------------------------------

/**
 * A trivial texture-consuming node, used only to force a real pass boundary
 * (a wired `textureInput` port) so `partitionPasses` takes its multi-pass
 * branch instead of returning null at the single-pass fast path.
 */
const textureSrcNode: NodeDefinition = {
  type: 'test_tex_src',
  label: 'Test Texture Src',
  category: 'effect',
  inputs: [{ id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  glsl: (ctx) => {
    const sampler = ctx.textureSamplers?.source
    return `vec4 ${ctx.outputs.color} = ${sampler ? `texture(${sampler}, v_uv)` : 'vec4(0.0)'};`
  },
}
nodeRegistry.register(textureSrcNode)

/** Builds the (executionOrder, nodeMap, edgesByTarget) triple partitionPasses needs. */
function partitionInputsFor(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) {
  const executionOrder = topologicalSort(nodes, edges)
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
  for (const edge of edges) {
    const list = edgesByTarget.get(edge.target) ?? []
    list.push(edge)
    edgesByTarget.set(edge.target, list)
  }
  return { executionOrder, nodeMap, edgesByTarget }
}

/**
 * Graph shape:
 *   src ──────────────────────► fx.color        (same-pass input)
 *   src ──[textureInput]──────► texnode          (forces texnode to pass 1)
 *   texnode ──────────────────► fx.gain_2        (connectable dynamic param)
 *   fx ────────────────────────► out.color
 *
 * fx.color only pulls depth 0 from src. The ONLY thing that can push fx into
 * texnode's pass is the connectable-param depth loop resolving fx's dynamic
 * params and finding the gain_2 edge — gain_2 exists solely via
 * dynamicParams (gainCount:3), not in the static `params: [gain(0)]`
 * fallback. If site 4 reads the static fallback instead, it never sees a
 * gain_2 edge to match, fx stays at depth 0, and it lands in an earlier pass
 * than the node it actually depends on — a scheduling bug, not merely a
 * missing uniform.
 */
const texGraph = () => {
  const nodes = [
    n('src', 'checkerboard'),
    n('texnode', 'test_tex_src'),
    n('fx', 'test_dyn_params', { gainCount: 3 }),
    n('out', 'fragment_output'),
  ]
  const edges = [
    e('e1', 'src', 'color', 'texnode', 'source'),
    e('e2', 'src', 'color', 'fx', 'color'),
    e('e3', 'texnode', 'color', 'fx', 'gain_2'),
    e('e4', 'fx', 'color', 'out', 'color'),
  ]
  return { nodes, edges }
}

test('partitionPasses: a connectable dynamic param pulls the node into its source\'s pass', () => {
  const { nodes, edges } = texGraph()
  const { executionOrder, nodeMap, edgesByTarget } = partitionInputsFor(nodes, edges)
  const passes = partitionPasses(executionOrder, nodeMap, edgesByTarget)
  assert(passes !== null, 'expected a multi-pass graph (texnode has a wired textureInput)')
  const passOf = (id: string) => passes!.findIndex((p) => p.includes(id))
  const fxPass = passOf('fx')
  const texPass = passOf('texnode')
  assert(fxPass !== -1 && texPass !== -1,
    `nodes missing from the partition: fx=${fxPass}, texnode=${texPass}`)
  assert(fxPass === texPass,
    `fx's connectable dynamic param gain_2 is fed by texnode (pass ${texPass}), but fx landed in ` +
    `pass ${fxPass} — the connectable-param depth loop did not resolve fx's dynamicParams`)
})

await run('dynamic-params')
