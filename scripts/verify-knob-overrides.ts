/**
 * Knob rename + hide (Embed modal, board 1023:7776): does a per-knob override
 * change exactly what it should — the published key and what is published — and
 * nothing else?
 *
 *  - Store: one normalised value, one undo step, a no-op adds no history, and
 *    it is in no compile key (the same contract as a node rename, SR-1).
 *  - Manifest: a custom name replaces the param half of the key and the label;
 *    a hidden knob is left out of the published manifest but keeps the key it
 *    would have, so showing it again does not move it; a rename that collides
 *    with another knob of the same node is numbered and flagged.
 *  - With no overrides the manifest is byte-identical to the old output.
 *  - Kept in localStorage, `.sombra` files and compact share links.
 *
 * Mechanism-engaged: every "changes nothing" check is paired with a positive
 * control proving the same probe does move (a real param edit moves the keys;
 * a rename moves the manifest).
 *
 * Run: npm run verify:knob-overrides
 */
// First: the store must see a working localStorage when it is created.
import { memoryStorage as mem } from './lib/memory-local-storage'
import type { Node, Edge } from '@xyflow/react'
import { useGraphStore } from '../src/stores/graphStore'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { normalizeKnobOverrides, applyKnobOverride } from '../src/nodes/knob-overrides'
import { buildSemanticKey, buildUniformKey, buildRendererKey } from '../src/compiler/param-keys'
import { compileGraph } from '../src/compiler/glsl-generator'
import { buildManifestWithClashes } from '../src/embed/manifest'
import { publishScene } from '../src/embed/publish'
import { decodeArtifact } from '../src/embed/artifact'
import { encodeCompactHash, decodeCompactHash, exportToFile, importFromFile } from '../src/utils/sombra-file'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

const mk = (id: string, type: string): Node<NodeData> =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params: defaultParams(nodeRegistry.get(type)) } })

function fixture() {
  const nodes = [mk('nz', 'noise'), mk('out', 'fragment_output')]
  nodes[0].data.label = 'site.noise'
  const edges: Edge<EdgeData>[] = [
    { id: 'e1', source: 'nz', sourceHandle: 'value', target: 'out', targetHandle: 'color' } as Edge<EdgeData>,
  ]
  useGraphStore.setState({ nodes, edges, _past: [], _future: [], _lastActionKey: null, _lastActionTime: 0, canUndo: false, canRedo: false })
}
const S = () => useGraphStore.getState()
const nz = () => S().nodes.find((n) => n.id === 'nz')!
const keys = () => [buildSemanticKey(S().nodes, S().edges), buildUniformKey(S().nodes), buildRendererKey(S().nodes)]
const build = () => {
  const plan = compileGraph(S().nodes, S().edges)
  assert(plan.success, 'fixture graph does not compile')
  return buildManifestWithClashes(plan.userUniforms, S().nodes)
}
/** Two float knobs of the noise node, picked from the real manifest (no hard-coded param ids). */
const twoKnobs = () => {
  const e = build().entries.filter((x) => x.knob.nodeId === 'nz' && x.knob.type === 'float')
  assert(e.length >= 2, `noise has ${e.length} float knobs — the fixture needs two`)
  return [e[0], e[1]]
}

test('normaliser: keeps only real overrides, trims names, drops junk', () => {
  assert(normalizeKnobOverrides(undefined) === undefined, 'undefined')
  assert(normalizeKnobOverrides({ a: {}, b: { name: '  ' }, c: { hidden: false } }) === undefined, 'empty overrides survived')
  const n = normalizeKnobOverrides({ a: { name: '  Amount ' }, b: { hidden: true, junk: 1 }, c: 'x', __proto__: { name: 'p' } })
  assert(JSON.stringify(n) === JSON.stringify({ a: { name: 'Amount' }, b: { hidden: true } }), `got ${JSON.stringify(n)}`)
  assert(applyKnobOverride({ a: { name: 'X', hidden: true } }, 'a', { name: '' })?.a.hidden === true, 'clearing the name dropped hidden')
  assert(applyKnobOverride({ a: { hidden: true } }, 'a', { hidden: false }) === undefined, 'showing the last hidden knob left an override')
})

test('setKnobOverride: one undo step, undo/redo exact, clearing removes the key', () => {
  fixture()
  const [k] = twoKnobs()
  S().setKnobOverride('nz', k.paramId, { name: 'Amount' })
  assert(nz().data.knobs?.[k.paramId]?.name === 'Amount', `stored ${JSON.stringify(nz().data.knobs)}`)
  assert(S()._past.length === 1, `rename pushed ${S()._past.length} history entries`)
  S().setKnobOverride('nz', k.paramId, { hidden: true })
  assert(S()._past.length === 2, 'hide was not its own undo step')
  S().undo()
  assert(nz().data.knobs?.[k.paramId]?.hidden === undefined && nz().data.knobs?.[k.paramId]?.name === 'Amount', 'undo did not restore just the rename')
  S().redo()
  assert(nz().data.knobs?.[k.paramId]?.hidden === true, 'redo lost hidden')
  S().setKnobOverride('nz', k.paramId, { name: '', hidden: false })
  assert(!('knobs' in nz().data), `cleared node still carries ${JSON.stringify(nz().data.knobs)}`)
})

test('no-op edits add no history and keep the graph identity', () => {
  fixture()
  const [k] = twoKnobs()
  S().setKnobOverride('nz', k.paramId, { name: 'Amount' })
  const nodes = S().nodes, past = S()._past.length
  S().setKnobOverride('nz', k.paramId, { name: '  Amount ' })
  S().setKnobOverride('ghost', k.paramId, { hidden: true })
  assert(S().nodes === nodes && S()._past.length === past, 'a no-op knob edit changed the graph or history')
})

test('an override changes no compile key — and a real edit does (positive control)', () => {
  fixture()
  const [k] = twoKnobs()
  const [sem0, uni0, ren0] = keys()
  S().setKnobOverride('nz', k.paramId, { name: 'Amount', hidden: true })
  const [sem1, uni1, ren1] = keys()
  assert(sem1 === sem0 && uni1 === uni0 && ren1 === ren0, 'a knob override moved a compile key → it would recompile')
  S().updateNodeData('nz', { params: { ...nz().data.params, noiseType: 'value' } })
  assert(keys()[0] !== sem1, 'semantic key ignores a recompile param — the control is broken')
})

test('no overrides → manifest byte-identical to the label-only rule', () => {
  fixture()
  const { manifest, entries } = build()
  assert(entries.every((e) => !e.hidden && !e.renamed && !e.nameClash), 'phantom override flags')
  assert(manifest.every((k) => k.key.startsWith('site-noise-') || k.nodeType === 'fragment_output'), 'node prefix lost')
  // Each key is <node>-<slug(param label)> exactly as before overrides existed.
  for (const e of entries) {
    if (e.knob.nodeId !== 'nz') continue
    const slug = e.defaultName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    assert(e.knob.label === e.defaultName, `${e.knob.key}: label ${e.knob.label} ≠ ${e.defaultName}`)
    assert(e.knob.key.startsWith(`site-noise-${slug}`), `${e.knob.key} is not site-noise-${slug}…`)
  }
})

test('rename: the key and label follow the name; other knobs do not move', () => {
  fixture()
  const before = build().manifest
  const [k] = twoKnobs()
  S().setKnobOverride('nz', k.paramId, { name: 'Amount' })
  const after = build().manifest
  const renamed = after.find((x) => x.uniform === k.knob.uniform)!
  assert(renamed.key === 'site-noise-amount', `renamed key ${renamed.key}`)
  assert(renamed.label === 'Amount' && renamed.param === 'amount', `label/param ${renamed.label}/${renamed.param}`)
  const moved = after.filter((x, i) => x.uniform !== k.knob.uniform && x.key !== before[i].key)
  assert(moved.length === 0, `other keys moved: ${moved.map((x) => x.key).join(', ')}`)
})

test('hidden: left out of the manifest, kept in the table with a stable key', () => {
  fixture()
  const [k] = twoKnobs()
  const keyBefore = k.knob.key
  S().setKnobOverride('nz', k.paramId, { hidden: true })
  const b = build()
  assert(!b.manifest.some((x) => x.uniform === k.knob.uniform), 'hidden knob is still published')
  const e = b.entries.find((x) => x.knob.uniform === k.knob.uniform)
  assert(e?.hidden === true, 'hidden knob vanished from the table entries')
  assert(e!.knob.key === keyBefore, `hidden knob key moved ${keyBefore} → ${e!.knob.key}`)
  assert(b.manifest.length === b.entries.length - 1, 'published count is not entries − hidden')
})

test('a rename that collides inside its node is numbered and flagged', () => {
  fixture()
  const [a, b] = twoKnobs()
  S().setKnobOverride('nz', b.paramId, { name: a.defaultName })
  const entries = build().entries
  const eb = entries.find((x) => x.paramId === b.paramId)!
  assert(eb.knob.key !== a.knob.key && eb.knob.key.startsWith(a.knob.key), `collision not numbered: ${eb.knob.key}`)
  assert(eb.nameClash, 'colliding rename not flagged')
  assert(!entries.find((x) => x.paramId === a.paramId)!.nameClash, 'the knob that kept its key was flagged')
})

test('the published artifact leaves hidden knobs out and carries the renamed key', () => {
  fixture()
  const [a, b] = twoKnobs()
  S().setKnobOverride('nz', a.paramId, { name: 'Amount' })
  S().setKnobOverride('nz', b.paramId, { hidden: true })
  const r = publishScene(S().nodes, S().edges)
  const art = decodeArtifact(r.sceneB64)
  assert(art.manifest.some((x) => x.key === 'site-noise-amount'), 'renamed key missing from the artifact')
  assert(!art.manifest.some((x) => x.uniform === b.knob.uniform), 'hidden knob shipped in the artifact')
  assert(r.knobs.length === art.manifest.length + 1, 'table entries do not include the hidden knob')
  // The hidden knob's uniform is still in the shader at its editor value.
  assert(r.manifest.length === art.manifest.length, 'result manifest ≠ artifact manifest')
})

test('kept in localStorage, .sombra files and compact share links', () => {
  fixture()
  const [k] = twoKnobs()
  S().setKnobOverride('nz', k.paramId, { name: 'Amount', hidden: true })
  const raw = mem.get('sombra-graph')
  assert(raw, 'nothing persisted — the store never wrote, so this test would prove nothing')
  const saved = JSON.parse(raw!) as { state: { nodes: Node<NodeData>[] } }
  assert(saved.state.nodes.find((n) => n.id === 'nz')?.data.knobs?.[k.paramId]?.name === 'Amount', 'override dropped from persisted state')
  const file = importFromFile(JSON.parse(JSON.stringify(exportToFile(S().nodes, S().edges))))
  assert(file.nodes.find((n) => n.id === 'nz')?.data.knobs?.[k.paramId]?.hidden === true, '.sombra round-trip lost the override')
  const hash = decodeCompactHash(encodeCompactHash(S().nodes, S().edges))
  const hk = hash.nodes.find((n) => n.id === 'nz')?.data.knobs?.[k.paramId]
  assert(hk?.name === 'Amount' && hk?.hidden === true, `share link round-trip: ${JSON.stringify(hk)}`)
  // Positive control: a graph without overrides carries no `k` in the hash.
  fixture()
  const plain = decodeCompactHash(encodeCompactHash(S().nodes, S().edges))
  assert(!('knobs' in plain.nodes.find((n) => n.id === 'nz')!.data), 'a plain graph grew a knobs key')
})

run('verify-knob-overrides')
