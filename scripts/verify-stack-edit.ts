/**
 * Stack layer edits through the REAL graph store: every structural edit keeps
 * the wires right, lands as ONE history entry, and one undo restores params
 * AND wires together.
 *
 * Why each part exists:
 *  - Wires: ports are keyed by stable layer id. Remove must take a layer's
 *    three wires with it (a wire left on a vanished port is unreadable);
 *    reorder, hide and blend must leave every wire on its own layer.
 *  - One undo: React Flow's default edge removal is a SEPARATE history entry
 *    from the param write, so remove-port-plus-wires was two undo steps — one
 *    undo restored the layer without its wires. The store action writes both in
 *    one `set`.
 *  - No aliasing: undo snapshots are shallow. An edit that mutated the layer
 *    array in place would rewrite the snapshot it is undoing to.
 *  - The flip: `layers` is stored bottom-first; the layer list speaks top-first.
 *    A reorder given in top-first indices must store the order the list showed,
 *    and display it back the same way.
 *  - A slider drag after an edit must not coalesce into it (`_lastActionKey`).
 *
 * Run: npm run verify:stack-edit
 */
import { initializeNodeLibrary } from '../src/nodes'
import { useGraphStore } from '../src/stores/graphStore'
import { getLayers, type StackLayer } from '../src/nodes/color/stack'
import { toTopFirst, applyStackEdit } from '../src/nodes/color/stack-edit'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'

initializeNodeLibrary()

const L = (id: string, name: string, visible = true): StackLayer => ({ id, name, blendMode: 'normal', visible })
const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }) as Node<NodeData>
const edge = (id: string, s: string, sh: string, t: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th }) as Edge<EdgeData>

/** Bottom-first: A at the bottom, C on top. Every layer wired; A and C also have opacity / mask wires. */
function fixture() {
  const nodes = [
    node('stk', 'stack', { layers: [L('a', 'Layer 1'), L('b', 'Layer 2'), L('c', 'Layer 3')], nextLayerNumber: 4, opacity_b: 0.4 }),
    node('sa', 'gradient'), node('sb', 'checkerboard'), node('sc', 'dots'), node('f', 'float_constant'),
    node('out', 'fragment_output'),
  ]
  const edges = [
    edge('ea', 'sa', 'color', 'stk', 'layer_a'), edge('eb', 'sb', 'color', 'stk', 'layer_b'), edge('ec', 'sc', 'color', 'stk', 'layer_c'),
    edge('eoa', 'f', 'value', 'stk', 'opacity_a'), edge('emc', 'f', 'value', 'stk', 'mask_c'),
    edge('eo', 'stk', 'color', 'out', 'color'),
  ]
  useGraphStore.setState({ nodes, edges, _past: [], _future: [], _lastActionKey: null, canUndo: false, canRedo: false })
}
const S = () => useGraphStore.getState()
const stackParams = () => S().nodes.find((n) => n.id === 'stk')!.data.params as Record<string, unknown>
const order = () => getLayers(stackParams()).map((l) => l.id).join('')
const wires = () => S().edges.filter((e) => e.target === 'stk').map((e) => `${e.source}>${e.targetHandle}`).sort().join(' ')
const WIRES0 = 'f>mask_c f>opacity_a sa>layer_a sb>layer_b sc>layer_c'

function assertOneUndoRestores(label: string, before: { params: Record<string, unknown>; edges: Edge<EdgeData>[] }) {
  assert(S()._past.length === 1, `${label}: ${S()._past.length} history entries, expected exactly 1`)
  S().undo()
  assert(S()._past.length === 0, `${label}: history not empty after one undo`)
  assert(JSON.stringify(stackParams()) === JSON.stringify(before.params), `${label}: one undo did not restore the params`)
  assert(JSON.stringify(S().edges) === JSON.stringify(before.edges), `${label}: one undo did not restore the wires`)
}

const snap = () => ({ params: structuredClone(stackParams()), edges: structuredClone(S().edges) })

test('add: a new layer on TOP, named from nextLayerNumber, wires untouched, one undo', () => {
  fixture()
  const before = snap()
  S().editStackLayers('stk', { kind: 'add' })
  const ls = getLayers(stackParams())
  assert(ls.length === 4, `${ls.length} layers`)
  assert(ls[3].name === 'Layer 4' && ls[3].visible && ls[3].blendMode === 'normal', `new layer ${JSON.stringify(ls[3])} — must be "Layer 4", on top`)
  assert(/^[A-Za-z0-9]+$/.test(ls[3].id) && !['a', 'b', 'c'].includes(ls[3].id), `new id ${ls[3].id} must be fresh and alphanumeric`)
  assert(stackParams().nextLayerNumber === 5, `nextLayerNumber ${stackParams().nextLayerNumber}`)
  assert(wires() === WIRES0, `wires changed on add: ${wires()}`)
  // The undo snapshot itself (not our deep copy) must still hold three layers.
  const snapLayers = S()._past[0].nodes.find((x) => x.id === 'stk')!.data.params!.layers as unknown[]
  assert(snapLayers.length === 3, `the undo snapshot now holds ${snapLayers.length} layers — the edit mutated it in place`)
  assertOneUndoRestores('add', before)
})

test('remove: the layer and ALL its wires go in one step; names never reuse', () => {
  fixture()
  const before = snap()
  S().editStackLayers('stk', { kind: 'remove', id: 'c' })
  assert(order() === 'ab', `order ${order()}`)
  assert(wires() === 'f>opacity_a sa>layer_a sb>layer_b', `wires after removing c: ${wires()} — its source and mask wires must go`)
  assert(!('mask_c' in stackParams()) && !('opacity_c' in stackParams()), 'removed layer left its params behind')
  S().editStackLayers('stk', { kind: 'add' })
  assert(getLayers(stackParams()).at(-1)!.name === 'Layer 4', 'after removing Layer 3, a new layer must be Layer 4, not a second Layer 3')
  S().undo()
  assertOneUndoRestores('remove', before)
})

test('reorder: top-first indices in, the order the list showed is stored; wires follow their layer', () => {
  fixture()
  const before = snap()
  const shown = () => toTopFirst(getLayers(stackParams())).map((l) => l.name).join(',')
  assert(shown() === 'Layer 3,Layer 2,Layer 1', `fixture shows ${shown()}`)
  // Drag the visible TOP layer (top-first index 0) to the bottom (index 2).
  S().editStackLayers('stk', { kind: 'reorder', from: 0, to: 2 })
  assert(shown() === 'Layer 2,Layer 1,Layer 3', `the list now shows ${shown()}, expected Layer 3 at the bottom`)
  assert(order() === 'cab', `stored bottom-first ${order()}, expected c,a,b — Layer 3 composites FIRST now`)
  assert(wires() === WIRES0, `wires changed on reorder: ${wires()}`)
  assertOneUndoRestores('reorder', before)
  // And the other direction, bottom to top.
  S().editStackLayers('stk', { kind: 'reorder', from: 2, to: 0 })
  assert(shown() === 'Layer 1,Layer 3,Layer 2' && order() === 'bca', `bottom→top: shows ${shown()}, stores ${order()}`)
})

test('reorder matches the list\'s own move semantics for every (from, to)', () => {
  // StackLayerList reports `to` as the dragged layer's index in the RESULTING
  // top-first list (splice out, splice in). Check every pair of a 4-layer list.
  const layers = [L('a', 'A'), L('b', 'B'), L('c', 'C'), L('d', 'D')]
  const top = toTopFirst(layers).map((l) => l.id)
  for (let from = 0; from < 4; from++) {
    for (let to = 0; to < 4; to++) {
      if (from === to) continue
      const expect = [...top]; const [m] = expect.splice(from, 1); expect.splice(to, 0, m)
      const r = applyStackEdit('stk', { layers }, [], { kind: 'reorder', from, to })
      const got = toTopFirst(getLayers(r.params)).map((l) => l.id)
      assert(JSON.stringify(got) === JSON.stringify(expect), `reorder ${from}→${to}: list shows ${got}, expected ${expect}`)
    }
  }
})

test('hide: wires KEPT, one undo', () => {
  fixture()
  const before = snap()
  S().editStackLayers('stk', { kind: 'toggleVisible', id: 'b' })
  assert(getLayers(stackParams()).find((l) => l.id === 'b')!.visible === false, 'layer b still visible')
  assert(wires() === WIRES0, `hiding a layer changed the wires: ${wires()}`)
  assertOneUndoRestores('hide', before)
})

test('blend: mode stored, wires kept, one undo; an unknown mode is refused', () => {
  fixture()
  const before = snap()
  S().editStackLayers('stk', { kind: 'blend', id: 'c', blendMode: 'screen' })
  assert(getLayers(stackParams()).find((l) => l.id === 'c')!.blendMode === 'screen', 'blend not stored')
  assert(wires() === WIRES0, 'blend changed the wires')
  assertOneUndoRestores('blend', before)
  S().editStackLayers('stk', { kind: 'blend', id: 'c', blendMode: 'nonsense' as never })
  assert(S()._past.length === 0, 'an unknown blend mode created a history entry')
})

test('removing the last layer leaves the designed empty state, not the defaults', () => {
  fixture()
  for (const id of ['a', 'b', 'c']) S().editStackLayers('stk', { kind: 'remove', id })
  assert(getLayers(stackParams()).length === 0, `${getLayers(stackParams()).length} layers after removing all three`)
  assert(wires() === '', `wires left on an empty Stack: ${wires()}`)
})

test('a slider drag right after a structural edit is its OWN undo step', () => {
  fixture()
  S().editStackLayers('stk', { kind: 'toggleVisible', id: 'b' })
  // Opacity takes the ordinary param path (uniform fast path, coalescing).
  S().updateNodeData('stk', { params: { ...stackParams(), opacity_b: 0.9 } })
  assert(S()._past.length === 2, `${S()._past.length} entries — the drag coalesced into the hide`)
  S().undo()
  assert(stackParams().opacity_b === 0.4 && getLayers(stackParams()).find((l) => l.id === 'b')!.visible === false,
    'one undo after the drag should restore the opacity and leave the layer hidden')
})

await run('stack-edit')
