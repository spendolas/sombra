/**
 * verify-manifest — buildManifest joins compiler uniforms with NodeDefinition
 * metadata, one knob per uniform, deduped keys. Run: npx tsx scripts/verify-manifest.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import type { NodeData, EdgeData, UniformSpec } from '../src/nodes/types'
import { buildManifest } from '../src/embed/manifest'
import { publishScene } from '../src/embed/publish'
import { compileGraph } from '../src/compiler/glsl-generator'
import * as TG from '../src/utils/test-graph'

initializeNodeLibrary()

let passed = 0, failed = 0
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) }
}

// Find any registered node with a uniform-mode, non-hidden param to test against.
let testType = '', testParamId = '', testLabel = ''
for (const def of nodeRegistry.getAll()) {
  const p = def.params?.find((p) => p.updateMode === 'uniform' && !p.hidden)
  if (p) { testType = def.type; testParamId = p.id; testLabel = p.label; break }
}
check('found a uniform-mode param to test', testType !== '')

const nodes = [
  { id: 'n1', data: { type: testType, params: {} } },
  { id: 'n2', data: { type: testType, params: {} } },
] as Node<NodeData>[]

const uniforms: UniformSpec[] = [
  { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
  { name: `u_n2_${testParamId}`, glslType: 'float', value: 2, nodeId: 'n2', paramId: testParamId },
]

const manifest = buildManifest(uniforms, nodes)
check('one descriptor per uniform', manifest.length === 2)
check('first key is slugified label', manifest[0].key.length > 0 && manifest[0].key === manifest[0].key.toLowerCase())
check('duplicate label is deduped', manifest[0].key !== manifest[1].key)
check('descriptor carries label + uniform wire name', manifest[0].label === testLabel && manifest[0].uniform === `u_n1_${testParamId}`)
check('descriptor carries owning node display name', manifest[0].node.length > 0)
check('duplicate nodes get distinct display names', manifest[0].node !== manifest[1].node)
check('key is node-scoped (node prefix + param)', manifest[0].key.includes('-') && manifest[0].key.length > testLabel.length)
check('descriptor carries stable nodeId + type', manifest[0].nodeId === 'n1' && manifest[0].nodeType === testType)
check('param is the friendly slug matching the key suffix', manifest[0].param.length > 0 && manifest[0].key.endsWith(manifest[0].param))
check('nodeId addresses distinct instances', manifest[0].nodeId !== manifest[1].nodeId && manifest[1].nodeId === 'n2')
check('unknown node is skipped', buildManifest(
  [{ name: 'u_x_y', glslType: 'float', value: 0, nodeId: 'ghost', paramId: 'y' }],
  nodes,
).length === 0)
// Multi-pass graphs repeat a node's uniform once per pass — must collapse to one knob.
check('repeated uniform name is deduped to one knob', buildManifest(
  [
    { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
    { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
  ],
  nodes,
).length === 1)

// Intra-node param-slug collision: two uniform params on ONE node whose labels
// slugify identically must still get distinct node-directed addresses.
const localSlug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
let collideType = '', cp1 = '', cp2 = ''
for (const def of nodeRegistry.getAll()) {
  const ups = (def.params ?? []).filter((p) => p.updateMode === 'uniform' && !p.hidden)
  const bySlug = new Map<string, string>()
  for (const p of ups) {
    const s = localSlug(p.label)
    if (bySlug.has(s)) { collideType = def.type; cp1 = bySlug.get(s)!; cp2 = p.id; break }
    bySlug.set(s, p.id)
  }
  if (collideType) break
}
if (collideType) {
  const cn = [{ id: 'c1', data: { type: collideType, params: {} } }] as Node<NodeData>[]
  const cu: UniformSpec[] = [
    { name: `u_c1_${cp1}`, glslType: 'float', value: 1, nodeId: 'c1', paramId: cp1 },
    { name: `u_c1_${cp2}`, glslType: 'float', value: 2, nodeId: 'c1', paramId: cp2 },
  ]
  const cm = buildManifest(cu, cn)
  check('same-label params on one node get distinct node-directed addresses',
    cm.length === 2 && cm[0].param !== cm[1].param && new Set(cm.map((k) => `${k.nodeId}|${k.param}`)).size === 2)
} else {
  console.log(`  (no intra-node label collision in registry to test — skipped)`)
}

// ---------------------------------------------------------------------------
// SR-1 — author-named nodes → stable knob keys. Real graphs through the real
// compiler (publishScene), so the uniforms are the ones a published scene has.
// ---------------------------------------------------------------------------

type G = { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }
const N = (id: string, type: string, params: Record<string, unknown> = {}, label?: string): Node<NodeData> => ({
  id, type: 'shaderNode', position: { x: 0, y: 0 },
  data: { type, params: { ...defaultParams(nodeRegistry.get(type)), ...params }, ...(label !== undefined ? { label } : {}) },
})
const E = (s: string, sh: string, t: string, th: string) =>
  ({ id: `${s}.${sh}>${t}.${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th }) as Edge<EdgeData>
/** Sum float sources (in this WIRING order) through knob-less Add nodes into the output. */
function graph(nodes: Node<NodeData>[], sources: string[], port = 'value'): G {
  const all = [...nodes]
  const edges: Edge<EdgeData>[] = []
  let acc: [string, string] = [sources[0], port]
  sources.slice(1).forEach((src, i) => {
    all.push(N(`add${i}`, 'arithmetic', { operation: 'add' }))
    edges.push(E(acc[0], acc[1], `add${i}`, 'in_0'), E(src, port, `add${i}`, 'in_1'))
    acc = [`add${i}`, 'result']
  })
  all.push(N('out', 'fragment_output'))
  edges.push(E(acc[0], acc[1], 'out', 'color'))
  return { nodes: all, edges }
}
const publish = (g: G) => publishScene(g.nodes, g.edges).manifest
const keyOf = (m: ReturnType<typeof publish>, nodeId: string, param: string) =>
  m.find((k) => k.nodeId === nodeId && k.param === param)?.key

// (a) a labelled node → the key derives from its label, and only its knobs are `named`.
{
  const m = publish(graph([N('bal', 'float_constant', {}, 'site.balance'), N('x', 'float_constant')], ['x', 'bal']))
  check('(a) labelled Number "site.balance" → key site-balance-value', keyOf(m, 'bal', 'value') === 'site-balance-value')
  check('(a) its knob is named: true', m.find((k) => k.nodeId === 'bal')?.named === true)
  check('(a) unlabelled knobs carry no `named` field at all', m.filter((k) => k.nodeId !== 'bal').every((k) => !('named' in k)))
  check('(a) the knob keeps its node display name = the label', m.find((k) => k.nodeId === 'bal')?.node === 'site.balance')
}

// (b) unlabelled nodes of the SAME type before and after it (array AND wiring
// order) do not move the labelled key — and a label that collides with the
// type label still wins over the unlabelled ones.
{
  const alone = publish(graph([N('bal', 'float_constant', {}, 'site.balance')], ['bal']))
  const crowded = publish(graph([
    N('u1', 'float_constant'), N('u2', 'float_constant'), N('bal', 'float_constant', {}, 'site.balance'), N('u3', 'float_constant'),
  ], ['u1', 'u2', 'bal', 'u3']))
  check('(b) key is identical alone and crowded', keyOf(alone, 'bal', 'value') === 'site-balance-value' && keyOf(crowded, 'bal', 'value') === 'site-balance-value')
  check('(b) the unlabelled ones are still number, number-2, number-3 in uniform order',
    keyOf(crowded, 'u1', 'value') === 'number-value' && keyOf(crowded, 'u2', 'value') === 'number-2-value' && keyOf(crowded, 'u3', 'value') === 'number-3-value')
  // A label equal to the TYPE label, wired last: before SR-1 the first-wired
  // unlabelled Number took "number-value" and the labelled one became "number-3-value".
  const typed = publish(graph([N('u1', 'float_constant'), N('u2', 'float_constant'), N('lab', 'float_constant', {}, 'Number')], ['u1', 'u2', 'lab']))
  check('(b) a label equal to the type label claims the bare slug even when wired last',
    keyOf(typed, 'lab', 'value') === 'number-value' && keyOf(typed, 'u1', 'value') === 'number-2-value' && keyOf(typed, 'u2', 'value') === 'number-3-value')
}

// (c) an unlabelled Noise + a Noise labelled "Noise": the labelled one gets noise-…, the other noise-2-…
{
  const m = publish(graph([N('plain', 'noise'), N('lab', 'noise', {}, 'Noise')], ['plain', 'lab']))
  check('(c) labelled "Noise" → noise-seed', keyOf(m, 'lab', 'seed') === 'noise-seed')
  check('(c) the unlabelled Noise (wired first) → noise-2-seed', keyOf(m, 'plain', 'seed') === 'noise-2-seed')
}

// (d) duplicate custom labels — including two that only slugify the same —
// get distinct keys in GRAPH (nodes-array) order, independent of wiring order.
{
  const nodes = () => [N('d1', 'float_constant', {}, 'site.balance'), N('d2', 'float_constant', {}, 'site.balance'), N('d3', 'float_constant', {}, 'Site Balance')]
  const fwd = publish(graph(nodes(), ['d1', 'd2', 'd3']))
  const rev = publish(graph(nodes(), ['d3', 'd2', 'd1']))
  const expect = { d1: 'site-balance-value', d2: 'site-balance-2-value', d3: 'site-balance-3-value' }
  check('(d) duplicates → site-balance, -2, -3 in nodes-array order',
    Object.entries(expect).every(([id, k]) => keyOf(fwd, id, 'value') === k))
  check('(d) reversing the wiring order changes no key (deterministic)',
    Object.entries(expect).every(([id, k]) => keyOf(rev, id, 'value') === k))
  check('(d) all duplicates are still named', fwd.filter((k) => k.nodeType === 'float_constant').every((k) => k.named === true))
}

// Labels are normalised exactly as the store stores them (trim, 120-char safety cap).
{
  const m = publish(graph([N('w', 'float_constant', {}, `   ${'site.x'.padEnd(140, 'y')}   `), N('blank', 'float_constant', {}, '   ')], ['w', 'blank']))
  check('label is trimmed and capped at 120 chars before slugging', m.find((k) => k.nodeId === 'w')?.node === 'site.x'.padEnd(120, 'y'))
  check('a whitespace-only label is no label (type name, not named)', keyOf(m, 'blank', 'value') === 'number-value' && !('named' in m.find((k) => k.nodeId === 'blank')!))
}

// (e) unlabelled scenes publish manifests BYTE-IDENTICAL to the pre-SR-1 code —
// apart from SR-2's ramp-stop knobs (group "stops"), which are purely added:
// with them removed, the bytes must match the frozen snapshot exactly.
{
  let stopKnobs = 0
  const withoutStops = (m: ReturnType<typeof publish>) => {
    const kept = m.filter((k) => k.group !== 'stops')
    stopKnobs += m.length - kept.length
    return JSON.stringify(kept)
  }
  const base = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'baselines/manifest-unlabelled.json'), 'utf8')) as {
    presets: Record<string, unknown>; graphs: Record<string, G & { manifest: unknown }>
  }
  let compared = 0, knobs = 0, nodeDedup = false
  for (const [name, frozen] of Object.entries(base.presets)) {
    const fn = (TG as Record<string, unknown>)[name] as (() => G) | undefined
    if (!fn) { check(`(e) preset ${name} still exists`, false); continue }
    const g = fn()
    const now = withoutStops(publish(g))
    check(`(e) ${name}: manifest byte-identical to the pre-label snapshot`, now === JSON.stringify(frozen))
    compared++; knobs += (frozen as unknown[]).length
  }
  for (const [name, g] of Object.entries(base.graphs)) {
    const now = withoutStops(publish(g))
    check(`(e) ${name}: manifest byte-identical to the pre-label snapshot`, now === JSON.stringify(g.manifest))
    compared++; knobs += (g.manifest as unknown[]).length
    nodeDedup ||= now.includes('"noise-3-seed"')
  }
  // The snapshot must actually exercise the name pass: many knobs, and node-level " 2"/" 3" de-dup.
  check(`(e) snapshot is non-trivial (${compared} graphs, ${knobs} knobs, node de-dup present)`, compared >= 10 && knobs >= 120 && nodeDedup)
  // The presets include ramps/gradients, so the filter above is really engaged.
  check(`(e) the snapshot graphs do gain ramp-stop knobs (${stopKnobs}) — the stop filter is engaged`, stopKnobs > 0)
}

// N1 — a param that exists only through dynamicParams must still become a knob.
// Stack layers other than the defaults l1/l2 declare their opacity/mask only
// per instance; the static def.params lookup used to drop them silently.
{
  const layers = [{ id: 'la', name: 'Sky', blendMode: 'normal', visible: true }, { id: 'lb', name: 'Ground', blendMode: 'screen', visible: true }]
  const g: G = {
    nodes: [N('stk', 'stack', { layers, nextLayerNumber: 3, opacity_lb: 0.4 }), N('ca', 'color_constant'), N('cb', 'color_constant'), N('out', 'fragment_output')],
    edges: [E('ca', 'color', 'stk', 'layer_la'), E('cb', 'color', 'stk', 'layer_lb'), E('stk', 'color', 'out', 'color')],
  }
  const plan = publishScene(g.nodes, g.edges)
  const uniforms = new Set(plan.manifest.map((k) => k.uniform))
  const stackKeys = plan.manifest.filter((k) => k.nodeId === 'stk').map((k) => k.key)
  // Mechanism: those uniforms really are declared by the compiled shader, so a
  // missing knob is a manifest bug, not an absent uniform.
  const compiled = compileGraph(g.nodes, g.edges)
  const src = compiled.passes.map((p) => p.fragmentShader).join('\n')
  check('N1 fixture: the compiled passes declare the la/lb opacity uniforms',
    /\bu_stk_opacity_la\b/.test(src) && /\bu_stk_opacity_lb\b/.test(src))
  check('N1 fixture: Stack layer la/lb params are NOT in the static def.params',
    !(nodeRegistry.get('stack')!.params ?? []).some((p) => p.id === 'opacity_la' || p.id === 'opacity_lb'))
  check('N1: non-default Stack layers publish their opacity + mask knobs',
    ['stack-sky-opacity', 'stack-sky-mask', 'stack-ground-opacity', 'stack-ground-mask'].every((k) => stackKeys.includes(k)))
  check('N1: the knob carries the instance value as default', plan.manifest.find((k) => k.key === 'stack-ground-opacity')?.default === 0.4)
  check('N1: every stack knob maps to a distinct uniform', stackKeys.length === new Set(plan.manifest.filter((k) => k.nodeId === 'stk').map((k) => k.uniform)).size && uniforms.size === plan.manifest.length)
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
