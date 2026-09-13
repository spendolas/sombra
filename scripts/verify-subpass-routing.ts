/**
 * Can a multiPass node expand without a wired chain input, and route its
 * incoming edges per sub-pass?
 *
 * expandMultiPassNodes skips expansion when the chain input is unwired, and
 * duplicates every other incoming edge onto every sub-pass. Both are right for
 * blur and wrong for a node that composites a list: its chain input is wired by
 * the expansion itself, and its per-item inputs belong to one step each.
 *
 * Run: npx tsx scripts/verify-subpass-routing.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { expandMultiPassNodes, SUB_PASS_PARAM } from '../src/compiler/expand-passes'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const layerPort = (i: number) => ({
  id: `layer_${i}`, label: `Layer ${i}`, type: 'color' as const,
  textureInput: true, default: [0, 0, 0, 0] as [number, number, number, number],
})

/**
 * Three sub-passes. `backdrop` is the chain input and is NEVER wired by the
 * fixture — the expansion wires it. Each layer_i belongs to sub-pass i only.
 */
const testNode: NodeDefinition = {
  type: 'test_stackish',
  label: 'Test Stackish',
  category: 'effect',
  inputs: [
    { id: 'backdrop', label: 'Backdrop', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    layerPort(0), layerPort(1), layerPort(2),
  ],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [],
  multiPass: {
    count: () => 3,
    from: 'color',
    to: 'backdrop',
    requiresWiredSource: false,
    routeEdge: (targetHandle, passIndex) => targetHandle === `layer_${passIndex}`,
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(0.0);`,
  ir: () => ({ statements: [], uniforms: [], standardUniforms: new Set<string>() }),
}
nodeRegistry.register(testNode)

const nodes = [
  n('a', 'checkerboard'), n('b', 'gradient'), n('c', 'checkerboard'),
  n('fx', 'test_stackish'),
  n('out', 'fragment_output'),
]
const edges = [
  e('e0', 'a', 'color', 'fx', 'layer_0'),
  e('e1', 'b', 'color', 'fx', 'layer_1'),
  e('e2', 'c', 'color', 'fx', 'layer_2'),
  e('e3', 'fx', 'color', 'out', 'color'),
]

const subPassNodes = (out: { nodes: Node[] }) =>
  out.nodes.filter((x) => (x.data as { type: string }).type === 'test_stackish')

/**
 * A SECOND fixture, expanding under the DEFAULT `requiresWiredSource` (the
 * field is omitted entirely — exactly like blur), with `routeEdge` set. This
 * exists so `requiresWiredSource` and `routeEdge` are independently
 * observable: `test_stackish` above needs `requiresWiredSource: false` just
 * to produce any sub-passes at all, so reverting that field there leaves
 * nothing for routing to be checked on — one feature is a precondition for
 * observing the other in that fixture. Here the chain input (`src`) IS wired
 * by the graph, so expansion happens with no `requiresWiredSource` involved,
 * and `tint_0`/`tint_1` each belong to one sub-pass only.
 */
const testWiredNode: NodeDefinition = {
  type: 'test_wired_routed',
  label: 'Test Wired Routed',
  category: 'effect',
  inputs: [
    { id: 'src', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    { id: 'tint_0', label: 'Tint 0', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    { id: 'tint_1', label: 'Tint 1', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
  ],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [],
  multiPass: {
    count: () => 2,
    from: 'color',
    to: 'src',
    // requiresWiredSource intentionally omitted — default true, same as blur.
    routeEdge: (targetHandle, passIndex) => targetHandle === `tint_${passIndex}`,
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(0.0);`,
  ir: () => ({ statements: [], uniforms: [], standardUniforms: new Set<string>() }),
}
nodeRegistry.register(testWiredNode)

const wiredNodes = [
  n('wsrc', 'checkerboard'), n('wt0', 'gradient'), n('wt1', 'checkerboard'),
  n('wfx', 'test_wired_routed'),
  n('wout', 'fragment_output'),
]
const wiredEdges = [
  e('w0', 'wsrc', 'color', 'wfx', 'src'), // the chain input — wired by the fixture itself
  e('w1', 'wt0', 'color', 'wfx', 'tint_0'),
  e('w2', 'wt1', 'color', 'wfx', 'tint_1'),
  e('w3', 'wfx', 'color', 'wout', 'color'),
]

const wiredSubPassNodes = (out: { nodes: Node[] }) =>
  out.nodes.filter((x) => (x.data as { type: string }).type === 'test_wired_routed')

test('expansion happens even though the chain input is unwired', () => {
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const chain = subPassNodes(out as never)
  assert(chain.length === 3,
    `expected 3 sub-passes, got ${chain.length} — expansion was skipped because 'backdrop' is unwired`)
  const indices = chain
    .map((x) => Number((x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM] ?? 0))
    .sort()
  assert(JSON.stringify(indices) === '[0,1,2]', `sub-pass indices wrong: ${JSON.stringify(indices)}`)
})

test('each layer edge reaches only its own sub-pass', () => {
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const chain = subPassNodes(out as never)
  const byIndex = new Map(chain.map((x) =>
    [Number((x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM] ?? 0), x.id]))

  for (const passIndex of [0, 1, 2]) {
    const nodeId = byIndex.get(passIndex)
    if (nodeId === undefined) {
      assert(false,
        `sub-pass ${passIndex} does not exist (only ${chain.length} sub-pass node(s) present) — ` +
        `expansion was skipped, so per-sub-pass routing cannot be checked yet`)
      continue
    }
    const incoming = (out as unknown as { edges: Edge[] }).edges
      .filter((x) => x.target === nodeId && x.targetHandle?.startsWith('layer_'))
      .map((x) => x.targetHandle)
    assert(incoming.length === 1,
      `sub-pass ${passIndex} received ${incoming.length} layer edges (${JSON.stringify(incoming)}) — every layer was duplicated onto every sub-pass`)
    assert(incoming[0] === `layer_${passIndex}`,
      `sub-pass ${passIndex} received ${incoming[0]}`)
  }
})

test('a node that expands via the default requiresWiredSource still routes its other inputs per sub-pass', () => {
  const out = expandMultiPassNodes(wiredNodes as never, wiredEdges as never)
  const chain = wiredSubPassNodes(out as never)
  assert(chain.length === 2,
    `expected 2 sub-passes, got ${chain.length} — expansion was skipped even though 'src' is wired`)
  const byIndex = new Map(chain.map((x) =>
    [Number((x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM] ?? 0), x.id]))

  for (const passIndex of [0, 1]) {
    const nodeId = byIndex.get(passIndex)
    if (nodeId === undefined) {
      assert(false,
        `sub-pass ${passIndex} does not exist (only ${chain.length} sub-pass node(s) present) — ` +
        `expansion was skipped, so per-sub-pass routing cannot be checked yet`)
      continue
    }
    const incoming = (out as unknown as { edges: Edge[] }).edges
      .filter((x) => x.target === nodeId && x.targetHandle?.startsWith('tint_'))
      .map((x) => x.targetHandle)
    assert(incoming.length === 1,
      `sub-pass ${passIndex} received ${incoming.length} tint edges (${JSON.stringify(incoming)}) — every tint was duplicated onto every sub-pass`)
    assert(incoming[0] === `tint_${passIndex}`,
      `sub-pass ${passIndex} received ${incoming[0]}`)
  }
})

test('a node with neither field expands exactly as before', () => {
  // blur is the reference consumer: multiPass with a wired source and no routing.
  const bn = [n('src', 'checkerboard'), n('fx', 'blur'), n('out', 'fragment_output')]
  const be = [e('b0', 'src', 'color', 'fx', 'source'), e('b1', 'fx', 'color', 'out', 'color')]
  const out = expandMultiPassNodes(bn as never, be as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'blur')
  assert(chain.length === 2, `blur should expand to 2 sub-passes, got ${chain.length}`)
})

test('an unwired chain input still skips expansion when the field is absent', () => {
  const bn = [n('fx', 'blur'), n('out', 'fragment_output')]
  const be = [e('b1', 'fx', 'color', 'out', 'color')]
  const out = expandMultiPassNodes(bn as never, be as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'blur')
  assert(chain.length === 1,
    'blur with nothing wired into `source` must NOT expand — extra passes would re-read a blank target')
})

// This test's real sequence, verified by hand while writing the routing fix:
// it passes trivially while expansion is skipped entirely (no layer edges
// survive to be counted, so the union/count checks vacuously hold); it FAILS
// on duplication once expansion is enabled but routing is not applied (each
// layer_i is duplicated onto every sub-pass — 'appeared 3 times'); it FAILS on
// a drop if routing withholds an edge at every index (temporarily forcing
// `targetHandle === 'layer_2' ? false : ...` in the fixture above reproduced
// this: the union came back missing layer_2 entirely — 'appeared 0 times');
// and it passes for real only when each edge lands in exactly one pass. A
// green run here is NOT on its own proof that routing works — pair it with
// the per-sub-pass test above, which is the one that catches duplication at
// its actual source.
test('a routed edge is routed, not dropped: each layer appears exactly once across all sub-passes', () => {
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const layerEdges = (out as unknown as { edges: Edge[] }).edges
    .filter((x) => x.targetHandle?.startsWith('layer_'))
    .map((x) => x.targetHandle as string)
  const counts = new Map<string, number>()
  for (const h of layerEdges) counts.set(h, (counts.get(h) ?? 0) + 1)
  const union = new Set(layerEdges)
  assert(
    union.size === 3 && ['layer_0', 'layer_1', 'layer_2'].every((h) => union.has(h)),
    `expected the union of layer edges across all sub-passes to be exactly {layer_0, layer_1, layer_2}, got ${JSON.stringify([...union].sort())}`,
  )
  for (const h of ['layer_0', 'layer_1', 'layer_2']) {
    assert(counts.get(h) === 1,
      `${h} should appear exactly once across all sub-passes, appeared ${counts.get(h) ?? 0} times — ` +
      `a routing off-by-one can misroute or silently drop an edge, which a per-pass-only check would not catch`)
  }
})

/**
 * The whitelist idiom both fixtures above use (`handle === 'layer_' + passIndex`)
 * rejects every handle it doesn't recognise — including a routed node's own
 * GLOBAL connectable params, ones meant to reach every sub-pass rather than one
 * step. This fixture adds a `gain` param alongside the per-sub-pass layers and
 * wires it once, from a single float_constant, to prove: (a) a NAIVE whitelist
 * silently drops that wire from every sub-pass — the hazard the routeEdge doc
 * now warns about — and (b) the documented idiom (fall through to `true` for
 * any handle the routing doesn't recognise) keeps it reaching every sub-pass.
 */
const testGlobalGainNode = (type: string, naive: boolean): NodeDefinition => ({
  type,
  label: 'Test Global Gain',
  category: 'effect',
  inputs: [
    { id: 'src', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    layerPort(0), layerPort(1),
  ],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [
    { id: 'gain', label: 'Gain', type: 'float', default: 1, connectable: true, updateMode: 'uniform' },
  ],
  multiPass: {
    count: () => 2,
    from: 'color',
    to: 'src',
    requiresWiredSource: false,
    // naive: a whitelist that only recognises the per-sub-pass layer handles —
    // this is what both earlier fixtures in this file use, and it is the
    // pattern the routeEdge doc now warns against.
    // correct: the same whitelist, but any OTHER handle (the global `gain`)
    // falls through to true instead of being rejected.
    routeEdge: naive
      ? (targetHandle, passIndex) => targetHandle === `layer_${passIndex}`
      : (targetHandle, passIndex) => targetHandle.startsWith('layer_') ? targetHandle === `layer_${passIndex}` : true,
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(0.0);`,
  ir: () => ({ statements: [], uniforms: [], standardUniforms: new Set<string>() }),
})
nodeRegistry.register(testGlobalGainNode('test_global_gain_naive', true))
nodeRegistry.register(testGlobalGainNode('test_global_gain_correct', false))

const globalGainGraph = (type: string) => ({
  nodes: [
    n('gsrc', 'checkerboard'), n('gl0', 'gradient'), n('gl1', 'checkerboard'),
    n('gnum', 'float_constant', { value: 2 }),
    n(`gfx`, type),
    n('gout', 'fragment_output'),
  ],
  edges: [
    e('g0', 'gsrc', 'color', 'gfx', 'src'),
    e('g1', 'gl0', 'color', 'gfx', 'layer_0'),
    e('g2', 'gl1', 'color', 'gfx', 'layer_1'),
    e('g3', 'gnum', 'value', 'gfx', 'gain'), // global param, wired ONCE
    e('g4', 'gfx', 'color', 'gout', 'color'),
  ],
})

test('a naive per-sub-pass whitelist silently drops a global connectable param (the documented hazard)', () => {
  const { nodes: gnodes, edges: gedges } = globalGainGraph('test_global_gain_naive')
  const out = expandMultiPassNodes(gnodes as never, gedges as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'test_global_gain_naive')
  assert(chain.length === 2, `expected 2 sub-passes, got ${chain.length}`)
  const gainEdges = (out as unknown as { edges: Edge[] }).edges
    .filter((x) => x.targetHandle === 'gain')
  // This is the hazard, not the desired behaviour: a naive whitelist rejects
  // `gain` at every index, so the edge is dropped entirely, not withheld from
  // some sub-passes and kept on others.
  assert(gainEdges.length === 0,
    `expected the naive whitelist to DROP the gain edge from every sub-pass (0 remaining), ` +
    `got ${gainEdges.length} — if this ever passes with edges present, the hazard this test ` +
    `documents no longer reproduces and the test should be revisited`)
})

test('the documented idiom (fall through to true for unrecognised handles) keeps a global param on every sub-pass', () => {
  const { nodes: gnodes, edges: gedges } = globalGainGraph('test_global_gain_correct')
  const out = expandMultiPassNodes(gnodes as never, gedges as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'test_global_gain_correct')
  assert(chain.length === 2, `expected 2 sub-passes, got ${chain.length}`)
  for (const node of chain) {
    const fed = (out as unknown as { edges: Edge[] }).edges
      .some((x) => x.target === node.id && x.targetHandle === 'gain' && x.source === 'gnum')
    assert(fed, `sub-pass ${node.id} is missing the wired gain — the global param did not reach every sub-pass`)
  }
})

run('subpass-routing')
