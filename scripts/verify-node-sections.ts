/**
 * Node-body section state (the Transform section's open/collapsed) and the
 * node-title duplicate rule — the store, file and embed halves, offline.
 *
 * Owner decision: a collapse is deliberate and must stay as the user left it.
 * So the state is stored on the node (`data.ui.collapsed`) and saved with the
 * graph (localStorage + .sombra) — but it is VIEW state, not shader content:
 *  - no undo history entry, and an unrelated undo/redo must not flip it;
 *  - in no compile / uniform / renderer key (a toggle never recompiles);
 *  - not in the compact share hash, the knob manifest or a published artifact;
 *  - absent = default (collapsed): an untouched graph carries no `ui` at all.
 *
 * Each "does not change X" check is paired with a positive control that DOES
 * change X on the same graph, so a constant key cannot pass it.
 *
 * The duplicate-name warning groups custom labels by the slug the manifest
 * numbers; `labelSlug` is a copy of the manifest's private rule, so this file
 * asserts the copy agrees with buildManifest's actual numbering.
 *
 * Run: npm run verify:node-sections
 */
// First: the store must see a working localStorage when it is created.
import { memoryStorage as mem } from './lib/memory-local-storage'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { useGraphStore } from '../src/stores/graphStore'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { buildSemanticKey, buildUniformKey, buildRendererKey } from '../src/compiler/param-keys'
import { isSectionCollapsed, withSectionCollapsed, TRANSFORM_SECTION } from '../src/nodes/node-ui'
import { duplicateLabelSlugs, hasDuplicateLabel, labelSlug } from '../src/nodes/node-label'
import { exportToFile, importFromFile, encodeSombraPackage, decodeSombraPackage, encodeCompactHash } from '../src/utils/sombra-file'
import { buildManifest } from '../src/embed/manifest'
import { publishScene } from '../src/embed/publish'
import type { NodeData, EdgeData, UniformSpec } from '../src/nodes/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

const mk = (id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params: { ...defaultParams(nodeRegistry.get(type)), ...params } } })
const edge = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string) =>
  ({ id, source, sourceHandle, target, targetHandle }) as Edge<EdgeData>

function fixture() {
  const nodes = [mk('num', 'float_constant', { value: 2 }), mk('st', 'stripes'), mk('out', 'fragment_output')]
  const edges = [edge('e1', 'num', 'value', 'st', 'srt_scale'), edge('e2', 'st', 'color', 'out', 'color')]
  useGraphStore.setState({ nodes, edges, _past: [], _future: [], _lastActionKey: null, _lastActionTime: 0, canUndo: false, canRedo: false })
}
const S = () => useGraphStore.getState()
const st = () => S().nodes.find((n) => n.id === 'st')!
const keys = () => [buildSemanticKey(S().nodes, S().edges), buildUniformKey(S().nodes), buildRendererKey(S().nodes)]
const open = () => !isSectionCollapsed(st().data, TRANSFORM_SECTION)

test('default: an untouched node is collapsed and carries no `ui`', () => {
  fixture()
  assert(!open(), 'Transform defaults to open — unmodified graphs would change look')
  assert(!('ui' in st().data), 'an untouched node has a ui key')
})

test('toggle: stored on the node, no history entry, no-op when unchanged; back to default leaves no trace', () => {
  fixture()
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  assert(open(), 'setSectionCollapsed(false) did not open the section — the store action is not wired')
  assert(JSON.stringify(st().data.ui) === '{"collapsed":{"transform":false}}', `stored ${JSON.stringify(st().data.ui)}`)
  assert(S()._past.length === 0 && !S().canUndo, `a toggle pushed history (${S()._past.length} entries)`)
  const nodes = S().nodes
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  assert(S().nodes === nodes, 'a no-op toggle replaced the nodes array')
  S().setSectionCollapsed('st', TRANSFORM_SECTION, true)
  assert(!open() && !('ui' in st().data), `collapsing back left ${JSON.stringify(st().data.ui)}`)
  // A redundant stored default is normalised away, not kept.
  const d = withSectionCollapsed({ type: 'x', params: {}, ui: { collapsed: { transform: true } } }, 'transform', true)
  assert(!('ui' in d), `a stored default was kept: ${JSON.stringify(d.ui)}`)
})

test('a toggle does not split a param-drag coalesce', () => {
  fixture()
  S().updateNodeData('st', { params: { ...st().data.params, srt_rotate: 10 } })
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  S().updateNodeData('st', { params: { ...st().data.params, srt_rotate: 20 } })
  assert(S()._past.length === 1, `drag → toggle → drag made ${S()._past.length} history entries, expected 1`)
})

test('undo / redo of an unrelated edit keep the section as the user left it', () => {
  fixture()
  S().updateNodeData('num', { params: { ...S().nodes[0].data.params, value: 5 } })
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  S().undo()
  assert(S().nodes[0].data.params.value === 2, 'fixture: the undo did not revert the param — this test proves nothing')
  assert(open(), 'undo of an unrelated edit collapsed the section — the toggle rode along in the snapshot')
  S().setSectionCollapsed('st', TRANSFORM_SECTION, true)
  S().redo()
  assert(S().nodes[0].data.params.value === 5, 'fixture: redo did not re-apply the param')
  assert(!open(), 'redo re-opened the section')
})

test('undo of a delete restores the node with the state it was deleted with', () => {
  fixture()
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  S().removeElements(['st'], [])
  S().undo()
  assert(st() && open(), 'the restored node lost its section state')
})

test('no compile / uniform / renderer key moves on a toggle — a real edit does (control)', () => {
  fixture()
  const [sem0, uni0, ren0] = keys()
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  const [sem1, uni1, ren1] = keys()
  assert(sem1 === sem0, 'semantic key moved on toggle → the live compiler would RECOMPILE')
  assert(uni1 === uni0, 'uniform key moved on toggle')
  assert(ren1 === ren0, 'renderer key moved on toggle')
  S().updateNodeData('st', { params: { ...st().data.params, srt_rotate: 33 } })
  assert(keys()[1] !== uni1, 'control: the uniform key ignores a uniform param — the comparison above proves nothing')
  S().removeEdge('e1')
  assert(keys()[0] !== sem1, 'control: the semantic key ignores an edge removal')
})

test('persisted to localStorage', () => {
  fixture()
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  const raw = mem.get('sombra-graph')
  assert(raw, 'nothing persisted — the store never wrote')
  const saved = JSON.parse(raw!) as { state: { nodes: Node<NodeData>[] } }
  assert(saved.state.nodes.find((n) => n.id === 'st')?.data.ui?.collapsed?.transform === false, 'section state dropped from the persisted graph')
})

test('.sombra package round-trip keeps it; an old file without it loads collapsed', () => {
  fixture()
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  const bytes = encodeSombraPackage(exportToFile(S().nodes, S().edges))
  const back = importFromFile(decodeSombraPackage(bytes))
  const n = back.nodes.find((x) => x.id === 'st')!
  assert(!isSectionCollapsed(n.data, TRANSFORM_SECTION), `re-imported state ${JSON.stringify(n.data.ui)} — the file lost it`)
  fixture()
  const old = importFromFile(JSON.parse(JSON.stringify(exportToFile(S().nodes, S().edges))))
  const o = old.nodes.find((x) => x.id === 'st')!
  assert(!('ui' in o.data) && isSectionCollapsed(o.data, TRANSFORM_SECTION), 'a file without ui did not load as default-collapsed')
})

test('compact share hash: identical with and without the section state (left out)', () => {
  fixture()
  const before = encodeCompactHash(S().nodes, S().edges)
  S().setSectionCollapsed('st', TRANSFORM_SECTION, false)
  assert(encodeCompactHash(S().nodes, S().edges) === before, 'the share hash changed on a toggle')
  S().updateNodeData('st', { params: { ...st().data.params, srt_rotate: 33 } })
  assert(encodeCompactHash(S().nodes, S().edges) !== before, 'control: the hash ignores a param edit')
})

// ── Corpus: manifests and published artifacts unchanged by section state ────
const SHADERS = path.resolve(import.meta.dirname, '..', 'shaders')
const corpus = fs.existsSync(SHADERS) ? fs.readdirSync(SHADERS).filter((f) => f.endsWith('.sombra')) : []
test('corpus: opening every Transform section changes no artifact byte and no manifest', () => {
  if (corpus.length === 0) {
    console.warn('  WARN: shaders/ is empty or absent (gitignored, never in a worktree/CI) — the corpus check ran on NOTHING')
    return
  }
  let compared = 0, toggled = 0
  for (const f of corpus) {
    let g: { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }
    try { g = importFromFile(decodeSombraPackage(fs.readFileSync(path.join(SHADERS, f)))) } catch { continue }
    let a
    try { a = publishScene(g.nodes, g.edges) } catch { continue }
    const opened = g.nodes.map((n) => {
      const def = nodeRegistry.get(n.data.type)
      if (!(def?.params ?? []).some((p) => p.id.startsWith('srt_'))) return n
      toggled++
      return { ...n, data: withSectionCollapsed(n.data, TRANSFORM_SECTION, false) }
    })
    const b = publishScene(opened, g.edges)
    assert(a.sceneB64 === b.sceneB64, `${f}: the published artifact changed when sections were opened`)
    assert(JSON.stringify(a.manifest) === JSON.stringify(b.manifest), `${f}: the manifest changed`)
    compared++
  }
  assert(compared > 0, `no corpus graph published (${corpus.length} files) — nothing compared`)
  assert(toggled > 0, 'no corpus node has a Transform section — nothing was toggled')
  console.log(`  corpus: ${compared} graphs published twice, ${toggled} sections opened`)
})

// ── Duplicate names: the warning matches the manifest's numbering ───────────
test('labelSlug agrees with the manifest: labels it numbers are exactly the ones flagged', () => {
  const cases: Array<[string, string]> = [
    ['Site Balance', 'site-balance'], ['site.balance', 'SITE BALANCE'], ['a', 'a '], ['hue!', 'hue'],
    ['site.balance', 'site.hue'], ['x1', 'x 1'], ['---', '***'],
  ]
  for (const [l1, l2] of cases) {
    const nodes = [mk('a', 'float_constant'), mk('b', 'float_constant')]
    nodes[0].data.label = l1
    nodes[1].data.label = l2
    const u = (n: Node<NodeData>): UniformSpec => ({ name: `u_${n.id}_value`, glslType: 'float', nodeId: n.id, paramId: 'value', value: 0 })
    const keys = buildManifest(nodes.map(u), nodes).map((k) => k.key)
    // Numbered = some node's key differs from the key it gets when alone.
    const alone = nodes.map((n) => buildManifest([u(n)], [n])[0].key)
    const numbered = keys.some((k, i) => k !== alone[i])
    const flagged = hasDuplicateLabel(nodes, l1) && hasDuplicateLabel(nodes, l2)
    assert(numbered === flagged, `"${l1}" vs "${l2}": manifest ${numbered ? 'numbers them' : 'does not number them'} (${keys}) but the warning is ${flagged ? 'on' : 'off'} (slugs ${labelSlug(l1)} / ${labelSlug(l2)})`)
  }
})

test('duplicate set: once per nodes array, both nodes flagged, clearing one clears both', () => {
  const nodes = [mk('a', 'noise'), mk('b', 'noise'), mk('c', 'noise')]
  nodes[0].data.label = 'site.seed'; nodes[1].data.label = 'Site Seed'
  const s1 = duplicateLabelSlugs(nodes)
  assert(duplicateLabelSlugs(nodes) === s1, 'not cached per nodes array — every node title recomputes it')
  assert(hasDuplicateLabel(nodes, 'site.seed') && hasDuplicateLabel(nodes, 'Site Seed'), 'both clashing nodes must be flagged')
  assert(!hasDuplicateLabel(nodes, undefined), 'an unnamed node was flagged')
  const cleared = [nodes[0], { ...nodes[1], data: { ...nodes[1].data, label: undefined } }, nodes[2]]
  assert(!hasDuplicateLabel(cleared, 'site.seed'), 'clearing one name left the other flagged')
})

await run('node-sections')
