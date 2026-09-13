/**
 * Do parameters declared through `dynamicParams` reach codegen and change
 * detection?
 *
 * Nine call sites iterate `definition.params` directly. Any one of them left
 * unresolved makes a dynamic param silently absent: the shader compiles, the
 * uniform is never declared, and the control does nothing. The failure is
 * invisible, which is why this gate asserts uniform NAMES rather than success.
 *
 * Run: npx tsx scripts/verify-dynamic-params.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { buildSemanticKey, buildUniformKey } from '../src/compiler/param-keys'
import { declare, variable, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const gain = (i: number): NodeParameter => ({
  id: `gain_${i}`, label: `Gain ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/** Multiplies its colour input by the product of N per-instance gains. */
const testNode: NodeDefinition = {
  type: 'test_dyn_params',
  label: 'Test Dynamic Params',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  // Static fallback, as dynamicInputs requires of ports.
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return Array.from({ length: count }, (_, i) => gain(i))
  },
  glsl: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    const product = gains.map((g) => ctx.inputs[g]).join(' * ')
    return `vec4 ${ctx.outputs.color} = ${ctx.inputs.color} * (${product});`
  },
  ir: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    let acc = variable(ctx.inputs[gains[0]])
    for (const g of gains.slice(1)) acc = binary('*', acc, variable(ctx.inputs[g]), 'float')
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

test('uniformKey reacts to a dynamic param value', () => {
  const a = buildUniformKey(graph(3).nodes)
  const b = buildUniformKey(graph(3, { gain_2: 0.25 }).nodes)
  assert(a !== b,
    'uniformKey ignored a dynamic param — dragging that slider would not reach the GPU')
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

await run('dynamic-params')
