/**
 * Does auto-layout see a connectable param that exists only on THIS instance?
 *
 * `src/utils/layout.ts` resolved `dynamicInputs` but read the static
 * `def.params` for connectable params, in two places: the handle order that
 * `reorderByHandleOrder` stacks sources by, and the size estimate dagre packs
 * with. A param declared through `dynamicParams` therefore had no handle
 * position (every wire into it sorted as index 999) and no row in the height
 * estimate. Stack's per-layer opacity and mask are exactly that shape.
 *
 * Three sites, each perturbable on its own: the handle order, the connectable
 * row count, and the regular (non-connectable) row count. Each has a test that
 * reads ONLY that site.
 *
 * The fixture's params live only in `dynamicParams`, and every test asserts
 * that by asking the node DEFINITION directly — never through the function
 * under test, which would turn a real regression into a "fixture is broken"
 * complaint (see verify-connection-validity.ts for the same rule).
 *
 * Run: npm run verify:layout-dynamic-params
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { getInputHandleOrder, estimateNodeSize, layoutGraph } from '../src/utils/layout'
import { declare, variable, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeParameter, NodeData, EdgeData } from '../src/nodes/types'

initializeNodeLibrary()

const TYPE = 'test_layout_dynamic'

const late = (i: number): NodeParameter => ({
  id: `late_${i}`, label: `Late ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/** A visible, non-connectable dynamic param — the regular-row site. */
const knob: NodeParameter = {
  id: 'knob', label: 'Knob', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01,
  updateMode: 'uniform',
}

const fixture: NodeDefinition = {
  type: TYPE,
  label: 'Test Layout Dynamic',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  // Deliberately EMPTY: anything layout finds, it found through dynamicParams.
  params: [],
  dynamicParams: (params) => [
    ...Array.from({ length: Math.max(1, Math.min(8, Number(params.layerCount) || 1)) }, (_, i) => late(i)),
    ...(params.withKnob ? [knob] : []),
  ],
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.color} * ${ctx.inputs.late_0};`,
  ir: (ctx) => ({
    statements: [declare(ctx.outputs.color, 'vec4',
      binary('*', variable(ctx.inputs.color), variable(ctx.inputs.late_0), 'vec4'))],
    uniforms: [], standardUniforms: new Set<string>(),
  }),
}
nodeRegistry.register(fixture)

/** Asked of the definition, not of layout.ts. */
function assertOnlyDynamic(id: string, params: Record<string, unknown>) {
  const def = nodeRegistry.get(TYPE)!
  assert(!(def.params ?? []).some((p) => p.id === id),
    `fixture no longer exercises the bug: ${id} is in the STATIC params`)
  assert(def.dynamicParams !== undefined, 'fixture is broken: the node lost its dynamicParams')
  assert(def.dynamicParams!(params).some((p) => p.id === id),
    `fixture is broken: ${id} is not a param of this instance at all`)
}

const data = (params: Record<string, unknown>): NodeData => ({ type: TYPE, params }) as NodeData

test('1 · handle order lists per-instance connectable params, after the inputs, in order', () => {
  const p = { layerCount: 4 }
  for (let i = 0; i < 4; i++) assertOnlyDynamic(`late_${i}`, p)
  const order = getInputHandleOrder(data(p))
  assert(JSON.stringify(order) === JSON.stringify(['color', 'late_0', 'late_1', 'late_2', 'late_3']),
    `expected [color, late_0..late_3], got ${JSON.stringify(order)}`)
})

test('2 · the handle order follows THIS instance’s count, not a fixed resolution', () => {
  const order = getInputHandleOrder(data({ layerCount: 2 }))
  assert(!order.includes('late_3'), `late_3 is in the order at layerCount 2, where it does not exist: ${JSON.stringify(order)}`)
  assert(order.includes('late_1'), `late_1 is missing at layerCount 2: ${JSON.stringify(order)}`)
})

test('3 · each per-instance connectable param adds a row to the size estimate', () => {
  assertOnlyDynamic('late_3', { layerCount: 4 })
  const one = estimateNodeSize(data({ layerCount: 1 }))
  const four = estimateNodeSize(data({ layerCount: 4 }))
  const perRow = (four.height - one.height) / 3
  assert(perRow > 0,
    `four connectable params estimate no taller than one (${one.height} vs ${four.height}) — the estimator cannot see them`)
  // Wider when a node has connectable params at all — the same predicate, so
  // assert it lands on the dynamic path too.
  assert(four.width === estimateNodeSize({ type: 'mix', params: {} } as NodeData).width,
    `a node with connectable dynamic params should size like one with static ones (mix); got ${four.width}`)
})

test('4 · a per-instance NON-connectable param adds a regular row', () => {
  assertOnlyDynamic('knob', { layerCount: 1, withKnob: true })
  const without = estimateNodeSize(data({ layerCount: 1 }))
  const withKnob = estimateNodeSize(data({ layerCount: 1, withKnob: true }))
  assert(withKnob.height > without.height,
    `a visible dynamic param added no height (${without.height} vs ${withKnob.height})`)
  assert(!getInputHandleOrder(data({ layerCount: 1, withKnob: true })).includes('knob'),
    'a non-connectable param was given a handle position')
})

test('5 · layoutGraph stacks sources wired into dynamic params in handle order', () => {
  // End to end through dagre + reorderByHandleOrder. Edges are inserted in
  // REVERSE handle order so that any order other than the handle order —
  // dagre's own, or edge-insertion order — fails.
  const p = { layerCount: 3 }
  assertOnlyDynamic('late_2', p)
  const mk = (id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> =>
    ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } as NodeData })
  const nodes = [mk('c2', 'float_constant'), mk('c1', 'float_constant'), mk('c0', 'float_constant'), mk('fx', TYPE, p)]
  const edges: Edge<EdgeData>[] = [2, 1, 0].map((i) => ({
    id: `e${i}`, source: `c${i}`, sourceHandle: 'value', target: 'fx', targetHandle: `late_${i}`,
  }))
  const laid = layoutGraph(nodes, edges)
  const y = (id: string) => laid.find((n) => n.id === id)!.position.y
  const x = (id: string) => laid.find((n) => n.id === id)!.position.x
  assert(x('c0') === x('c1') && x('c1') === x('c2'), 'fixture broken: the sources did not land in one dagre rank')
  assert(y('c0') < y('c1') && y('c1') < y('c2'),
    `sources not stacked in handle order: c0=${y('c0')} c1=${y('c1')} c2=${y('c2')}`)
})

test('6 · a shipped node’s STATIC connectable params still get handle positions', () => {
  const def = nodeRegistry.get('mix')!
  assert(!def.dynamicParams, 'fixture assumption broken: mix now has dynamicParams')
  const stat = (def.params ?? []).filter((q) => q.connectable).map((q) => q.id)
  assert(stat.length > 0, 'fixture assumption broken: mix has no static connectable param')
  const order = getInputHandleOrder({ type: 'mix', params: {} } as NodeData)
  for (const id of stat) assert(order.includes(id), `mix's static connectable ${id} lost its handle position`)
})

await run('layout-dynamic-params')
