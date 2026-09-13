/**
 * Does an edge into a connectable DYNAMIC param survive persistence?
 *
 * Two places validate an edge's targetHandle against a set built from the node
 * definition. Both resolve dynamicInputs and then read the STATIC def.params for
 * connectable ones, so a handle that exists only through dynamicParams is not in
 * the set and the edge is silently dropped.
 *
 * The assertions check that the EDGE SURVIVES, not that the function returns —
 * both functions return happily today while deleting it.
 *
 * Run: npx tsx scripts/verify-dynamic-param-edges.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { exportToFile, importFromFile } from '../src/utils/sombra-file'
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

/**
 * `gain_0` is static, `gain_1` exists only through dynamicParams. Both are
 * wired. The static one must survive (proving the fixture works); the dynamic
 * one is the bug.
 */
const testNode: NodeDefinition = {
  type: 'test_dyn_param_edges',
  label: 'Test Dynamic Param Edges',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return Array.from({ length: count }, (_, i) => gain(i))
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.color};`,
  ir: () => ({
    // Body intentionally trivial — this gate is about persistence, not codegen.
    // Never reaches a codegen path: the gate only exports/imports the graph.
    statements: [],
    uniforms: [],
    standardUniforms: new Set<string>(),
  }),
}
nodeRegistry.register(testNode)

function graph() {
  const nodes = [
    n('a', 'checkerboard'),
    n('g0', 'gradient'),
    n('g1', 'gradient'),
    n('fx', 'test_dyn_param_edges', { gainCount: 2 }),
    n('out', 'fragment_output'),
  ]
  const edges = [
    e('e0', 'a', 'color', 'fx', 'color'),
    e('e1', 'g0', 'value', 'fx', 'gain_0'),   // static param — must survive
    e('e2', 'g1', 'value', 'fx', 'gain_1'),   // DYNAMIC param — the bug
    e('e3', 'fx', 'color', 'out', 'color'),
  ]
  return { nodes, edges }
}

test('a .sombra round trip keeps the wire into a dynamic param', () => {
  const { nodes, edges } = graph()
  const back = importFromFile(exportToFile(nodes as never, edges as never))
  const ids = back.edges.map((x) => x.id)
  assert(ids.includes('e1'), 'the STATIC param wire was dropped — the fixture is wrong, fix it before reading anything else')
  assert(ids.includes('e2'),
    `the wire into the dynamic param gain_1 was deleted on load. Survivors: ${JSON.stringify(ids)}`)
})

run('dynamic-param-edges')
