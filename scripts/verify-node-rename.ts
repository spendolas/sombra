/**
 * Does renaming a node (SR-1) store exactly one normalised label, as one undo
 * step, without ever triggering a shader recompile?
 *
 * The label is what an embed host binds to (`site.balance` →
 * `site-balance-value`, src/embed/manifest.ts), so the store must keep it in
 * one canonical form; and a rename is a naming act, not an edit to the shader,
 * so it must not appear in any compile key.
 *
 * The no-recompile half is mechanism-engaged: the live compiler recompiles
 * exactly when buildSemanticKey changes and re-uploads uniforms when
 * buildUniformKey changes (use-live-compiler.ts), so the test proves those keys
 * DO move for a real param edit on the same node (positive control) and do
 * NOT move for a rename.
 *
 * Run: npm run verify:node-rename
 */
// First: the store must see a working localStorage when it is created.
import { memoryStorage as mem } from './lib/memory-local-storage'
import type { Node, Edge } from '@xyflow/react'
import { useGraphStore } from '../src/stores/graphStore'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { NODE_LABEL_MAX, normalizeNodeLabel } from '../src/nodes/node-label'
import { buildSemanticKey, buildUniformKey, buildRendererKey } from '../src/compiler/param-keys'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'


initializeNodeLibrary()

const mk = (id: string, type: string): Node<NodeData> =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params: defaultParams(nodeRegistry.get(type)) } })

function fixture() {
  const nodes = [mk('nz', 'noise'), mk('out', 'fragment_output')]
  const edges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'nz', sourceHandle: 'value', target: 'out', targetHandle: 'color' } as Edge<EdgeData>,
  ]
  useGraphStore.setState({ nodes, edges, _past: [], _future: [], _lastActionKey: null, _lastActionTime: 0, canUndo: false, canRedo: false })
}
const S = () => useGraphStore.getState()
const nz = () => S().nodes.find((n) => n.id === 'nz')!
const keys = () => [buildSemanticKey(S().nodes, S().edges), buildUniformKey(S().nodes), buildRendererKey(S().nodes)]

test('normaliser: trims, caps at 40, empty / whitespace / non-string mean "no label"', () => {
  assert(NODE_LABEL_MAX === 40, `limit is ${NODE_LABEL_MAX}, spec says 40`)
  assert(normalizeNodeLabel('  site.balance  ') === 'site.balance', 'not trimmed')
  const long = 'x'.repeat(41)
  assert(normalizeNodeLabel(long) === 'x'.repeat(40), `41 chars kept ${normalizeNodeLabel(long)?.length}`)
  assert(normalizeNodeLabel(`${'a'.repeat(39)} b`) === 'a'.repeat(39), 'a cut that ends in a space must be trimmed again')
  for (const v of ['', '   ', undefined, null, 42, {}]) {
    assert(normalizeNodeLabel(v) === undefined, `${JSON.stringify(v)} should mean no label`)
  }
})

test('renameNode stores the normalised label on that node only, params untouched', () => {
  fixture()
  const paramsBefore = nz().data.params
  S().renameNode('nz', `  ${'q'.repeat(50)}  `)
  assert(nz().data.label === 'q'.repeat(40), `stored ${JSON.stringify(nz().data.label)}`)
  assert(nz().data.params === paramsBefore, 'rename replaced the params object')
  assert(!('label' in S().nodes.find((n) => n.id === 'out')!.data), 'another node gained a label')
})

test('one rename = one undo step; undo/redo round-trip; consecutive renames do not coalesce', () => {
  fixture()
  S().renameNode('nz', 'site.seed')
  assert(S()._past.length === 1, `${S()._past.length} history entries after one rename`)
  S().renameNode('nz', 'site.balance')
  assert(S()._past.length === 2, 'second rename coalesced into the first — one undo would lose both')
  S().undo()
  assert(nz().data.label === 'site.seed', `undo → ${nz().data.label}`)
  S().undo()
  assert(!('label' in nz().data), 'undo to the start must leave no label key')
  S().redo()
  assert(nz().data.label === 'site.seed', `redo → ${nz().data.label}`)
})

test('a rename right after a param drag is its own undo step', () => {
  fixture()
  S().updateNodeData('nz', { params: { ...nz().data.params, seed: 7 } })
  S().renameNode('nz', 'site.seed')
  assert(S()._past.length === 2, `param edit + rename share ${S()._past.length === 1 ? 'one' : S()._past.length} entr(y/ies)`)
  // ...and the next drag must not coalesce into the rename either.
  S().updateNodeData('nz', { params: { ...nz().data.params, seed: 8 } })
  assert(S()._past.length === 3, 'a drag after a rename coalesced into it')
})

test('empty string and undefined clear the label (back to the type label)', () => {
  fixture()
  S().renameNode('nz', 'site.seed')
  S().renameNode('nz', '   ')
  assert(!('label' in nz().data), `whitespace left ${JSON.stringify(nz().data.label)}`)
  S().renameNode('nz', 'site.seed')
  S().renameNode('nz', undefined)
  assert(!('label' in nz().data), 'undefined did not clear')
})

test('no-op renames add no history and keep the graph identity', () => {
  fixture()
  S().renameNode('nz', 'site.seed')
  const nodes = S().nodes, past = S()._past.length
  S().renameNode('nz', '  site.seed ')          // same after normalising
  S().renameNode('ghost', 'whatever')           // unknown node
  assert(S().nodes === nodes, 'a no-op rename replaced the nodes array')
  assert(S()._past.length === past, 'a no-op rename pushed history')
  fixture()
  const nodes0 = S().nodes
  S().renameNode('nz', '')                       // clearing an unlabelled node
  assert(S().nodes === nodes0 && S()._past.length === 0, 'clearing an absent label was not a no-op')
})

test('a rename changes no compile key — and a real edit does (positive control)', () => {
  fixture()
  const [sem0, uni0, ren0] = keys()
  S().renameNode('nz', 'site.seed')
  const [sem1, uni1, ren1] = keys()
  assert(sem1 === sem0, 'semantic key moved on rename → the live compiler would RECOMPILE')
  assert(uni1 === uni0, 'uniform key moved on rename → spurious uniform upload')
  assert(ren1 === ren0, 'renderer key moved on rename')
  // Positive controls on the same node: the keys are live, not constant.
  S().updateNodeData('nz', { params: { ...nz().data.params, noiseType: 'value' } })
  assert(keys()[0] !== sem1, 'semantic key ignores a recompile param — the control is broken')
  S().updateNodeData('nz', { params: { ...nz().data.params, seed: 1 } })
  assert(keys()[1] !== uni1, 'uniform key ignores a uniform param — the control is broken')
})

test('the label is written to the persisted (localStorage) graph', () => {
  fixture()
  S().renameNode('nz', 'site.seed')
  const raw = mem.get('sombra-graph')
  assert(raw, 'nothing persisted — the store never wrote, so this test would prove nothing')
  const saved = JSON.parse(raw!) as { state: { nodes: Node<NodeData>[] } }
  assert(saved.state.nodes.find((n) => n.id === 'nz')?.data.label === 'site.seed', 'label dropped from persisted state')
})

run('verify-node-rename')
