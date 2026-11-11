/**
 * Are Color Ramp / Gradient stop colours runtime RGBA knobs (SR-2)?
 *
 * Offline: real graphs → publishScene → the published manifest and plan.
 *
 *   (a) a ramp with N stops publishes N knobs `<node>-stop-<n>`, n by ascending
 *       position, `color`/`vec4`, RGBA defaults (legacy 3-tuples padded to a=1),
 *       group "stops", index n, position — for Color Ramp AND Gradient, and
 *       under an author label (`site.palette` → `site-palette-stop-2`).
 *   (b) mechanism: each stop's uniform is declared AND read by the published
 *       fragment shader, and none of the stop colours survives as a literal —
 *       so the knob really drives the pixels instead of sitting beside a baked
 *       colour.
 *   (c) N1: a Stack with non-default layers publishes those layers' opacity
 *       knobs (dynamic params reach the manifest).
 *   (d) an id-less (legacy) stop list resolves to the same ids — and so the
 *       same uniform names — on two separate loads; ids survive edits; a
 *       minted id is fresh.
 *
 * Plus the guarantees the ids rest on: every stop param stays out of the
 * stored params (params.stops is the single source of truth), and positions /
 * interpolation remain compile-time (no position uniform, no extra pass).
 *
 * Run: npm run verify:ramp-knobs
 */
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { defaultParams } from '../src/nodes/default-params'
import { resolveParams } from '../src/nodes/resolve-dynamic'
import { normalizeStops, newStopId, stopParamId, DEFAULT_RAMP_STOPS } from '../src/nodes/color/ramp-stops'
import { publishScene } from '../src/embed/publish'
import { decodeArtifact } from '../src/embed/artifact'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { exportToFile, importFromFile, encodeSombraPackage, decodeSombraPackage } from '../src/utils/sombra-file'
import { buildSemanticKey } from '../src/compiler/param-keys'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()

type G = { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }
const N = (id: string, type: string, params: Record<string, unknown> = {}, label?: string): Node<NodeData> => ({
  id, type: 'shaderNode', position: { x: 0, y: 0 },
  data: { type, params: { ...defaultParams(nodeRegistry.get(type)), ...params }, ...(label ? { label } : {}) },
})
const E = (s: string, sh: string, t: string, th: string) =>
  ({ id: `${s}.${sh}>${t}.${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th }) as Edge<EdgeData>

/** Stored OUT of position order on purpose: index order ≠ position order. */
const STOPS = [
  { position: 0.75, color: [0.5, 0.6, 0.7, 0.25] },
  { position: 0.0, color: [0.08, 0.03, 0.04] },          // legacy RGB → a = 1
  { position: 0.5, color: [1, 0.2, 0.1, 0] },
  { position: 0.25, color: [0.1, 0.9, 0.3, 0.5] },
]
const byPosition = STOPS.map((s, k) => ({ ...s, k })).sort((a, b) => a.position - b.position)
const rgba = (c: number[]) => (c.length === 4 ? c : [c[0], c[1], c[2], 1])

function rampGraph(type: 'color_ramp' | 'gradient', label?: string, stops: unknown = STOPS, extra: Record<string, unknown> = {}): G {
  if (type === 'color_ramp') {
    return {
      nodes: [N('src', 'noise'), N('ramp', 'color_ramp', { interpolation: 'constant', stops, ...extra }, label), N('out', 'fragment_output')],
      edges: [E('src', 'value', 'ramp', 't'), E('ramp', 'color', 'out', 'color')],
    }
  }
  return {
    nodes: [N('ramp', 'gradient', { interpolation: 'smooth', stops, ...extra }, label), N('out', 'fragment_output')],
    edges: [E('ramp', 'color', 'out', 'color')],
  }
}

for (const type of ['color_ramp', 'gradient'] as const) {
  const nodeSlug = type === 'color_ramp' ? 'color-ramp' : 'gradient'

  test(`(a) ${type}: N stop knobs in position order, RGBA defaults, group/index/position`, () => {
    const m = publishScene(rampGraph(type).nodes, rampGraph(type).edges).manifest
    const stops = m.filter((k) => k.group === 'stops')
    assert(stops.length === STOPS.length, `${stops.length} stop knobs for ${STOPS.length} stops`)
    stops.forEach((k, n) => {
      const want = byPosition[n]
      assert(k.key === `${nodeSlug}-stop-${n}`, `knob ${n} key ${k.key}`)
      assert(k.param === `stop-${n}` && k.label === `Stop ${n}`, `knob ${n} param/label ${k.param}/${k.label}`)
      assert(k.type === 'color' && k.glslType === 'vec4', `knob ${n} type ${k.type}/${k.glslType}`)
      assert(JSON.stringify(k.default) === JSON.stringify(rgba(want.color)), `knob ${n} default ${JSON.stringify(k.default)} ≠ ${JSON.stringify(rgba(want.color))}`)
      assert(k.index === n && k.position === want.position, `knob ${n} index/position ${k.index}/${k.position}`)
      assert(k.nodeId === 'ramp', 'stop knob owned by the wrong node')
    })
    // Manifest order: the stop knobs are contiguous and in index order.
    const idx = m.map((k, i) => (k.group === 'stops' ? i : -1)).filter((i) => i >= 0)
    assert(idx.every((v, i) => i === 0 || v === idx[i - 1] + 1), 'stop knobs are not contiguous in the manifest')
    // Non-stop knobs carry no group fields (additive only).
    assert(m.filter((k) => k.group !== 'stops').every((k) => !('group' in k) && !('index' in k) && !('position' in k)), 'a non-stop knob gained group/index/position')
  })

  test(`(a) ${type}: an author label names the stops — site.palette → site-palette-stop-n`, () => {
    const g = rampGraph(type, 'site.palette')
    const m = publishScene(g.nodes, g.edges).manifest.filter((k) => k.group === 'stops')
    assert(m.map((k) => k.key).join() === STOPS.map((_, n) => `site-palette-stop-${n}`).join(), m.map((k) => k.key).join())
    assert(m.every((k) => k.named === true), 'labelled stops not named')
  })

  test(`(b) ${type}: each stop uniform is declared and read by the published shader; no colour literal survives`, () => {
    const g = rampGraph(type)
    const pub = publishScene(g.nodes, g.edges)
    const art = decodeArtifact(pub.sceneB64)
    const frag = art.plan.passes.map((p) => p.fragmentShader).join('\n')
    const knobs = pub.manifest.filter((k) => k.group === 'stops')
    for (const k of knobs) {
      assert(new RegExp(`uniform vec4 ${k.uniform};`).test(frag), `${k.uniform} not declared`)
      assert((frag.match(new RegExp(`\\b${k.uniform}\\b`, 'g')) ?? []).length >= 2, `${k.uniform} declared but never read`)
      assert(art.plan.userUniforms.some((u) => u.name === k.uniform), `${k.uniform} has no upload in plan.userUniforms`)
    }
    // The old codegen baked every stop as vec4(r, g, b, a) with JS number text.
    const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)
    for (const s of STOPS) {
      const c = rgba(s.color)
      const lit = `vec4(${c.map(f).join(', ')})`
      assert(!frag.includes(lit), `baked colour literal ${lit} still in the shader`)
    }
    // Positions stay compile-time: no position uniform, still one pass.
    assert(!/stop_\w*pos/i.test(frag) && art.plan.passes.length === 1, 'positions became uniforms or a pass was added')
    // And the WGSL path reads the same uniforms.
    const wgsl = compileGraphIR(g.nodes, g.edges)!.passes.map((p) => p.shaderCode).join('\n')
    for (const k of knobs) assert(wgsl.includes(`uniforms.${k.uniform}`), `WGSL does not read ${k.uniform}`)
  })

  test(`${type}: the stop params never enter the stored params; a stop colour edit still recompiles (editor behaviour unchanged)`, () => {
    const g = rampGraph(type)
    const params = g.nodes.find((n) => n.id === 'ramp')!.data.params
    assert(!Object.keys(params).some((k) => k.startsWith('stop_')), 'defaultParams materialised a stop param')
    const imported = importFromFile(decodeSombraPackage(encodeSombraPackage(exportToFile(g.nodes, g.edges))))
    assert(!Object.keys(imported.nodes.find((n) => n.id === 'ramp')!.data.params).some((k) => k.startsWith('stop_')), 'import materialised a stop param')
    const before = buildSemanticKey(g.nodes, g.edges)
    const edited = g.nodes.map((n) => n.id === 'ramp'
      ? { ...n, data: { ...n.data, params: { ...n.data.params, stops: STOPS.map((s, k) => (k === 2 ? { ...s, color: [0, 0, 1, 1] } : s)) } } } : n)
    assert(buildSemanticKey(edited, g.edges) !== before, 'a stop colour edit no longer changes the semantic key')
  })
}

test('(c) N1: a Stack with non-default layers publishes their opacity knobs', () => {
  const layers = [{ id: 'la', name: 'Sky', blendMode: 'normal', visible: true }, { id: 'lb', name: 'Ground', blendMode: 'screen', visible: true }]
  const nodes = [N('stk', 'stack', { layers, nextLayerNumber: 3 }), N('ca', 'color_constant'), N('cb', 'color_constant'), N('out', 'fragment_output')]
  const edges = [E('ca', 'color', 'stk', 'layer_la'), E('cb', 'color', 'stk', 'layer_lb'), E('stk', 'color', 'out', 'color')]
  const keys = publishScene(nodes, edges).manifest.map((k) => k.key)
  assert(keys.includes('stack-sky-opacity') && keys.includes('stack-ground-opacity'), `stack knobs: ${keys.filter((k) => k.startsWith('stack')).join(', ')}`)
})

test('(d) id-less legacy stops resolve to the same ids (and uniforms) on two separate loads', () => {
  const legacy = JSON.stringify(rampGraph('color_ramp'))
  const load = () => {
    const { nodes, edges } = importFromFile(JSON.parse(legacy))
    return compileGraph(nodes, edges).userUniforms.filter((u) => u.paramId.startsWith('stop_')).map((u) => u.name).sort().join()
  }
  const a = load(), b = load()
  assert(a.length > 0 && a === b, `loads disagree: ${a} vs ${b}`)
  assert(a === STOPS.map((_, k) => `u_ramp_stop_s${k}`).sort().join(), `legacy ids are not s<stored index>: ${a}`)
  // Ids by STORED index, independent of position: s<k> is the k-th stored stop —
  // same position, same colour — and the array keeps stored order.
  const norm = normalizeStops(STOPS)
  assert(norm.map((s) => s.id).join() === 's0,s1,s2,s3', 'ids not in stored order')
  norm.forEach((s, k) => assert(s.position === STOPS[k].position && JSON.stringify(s.color) === JSON.stringify(rgba(STOPS[k].color)),
    `${s.id} is not stored stop ${k} (position ${s.position} vs ${STOPS[k].position})`))
  // …and the compiled uniform named s<k> uploads stored stop k's colour.
  const { nodes, edges } = importFromFile(JSON.parse(legacy))
  for (const u of compileGraph(nodes, edges).userUniforms.filter((x) => x.paramId.startsWith('stop_'))) {
    const k = Number(u.paramId.slice('stop_s'.length))
    assert(JSON.stringify(u.value) === JSON.stringify(rgba(STOPS[k].color)), `${u.name} uploads ${JSON.stringify(u.value)}, not stored stop ${k}`)
  }
})

test('(d) ids: kept when valid, repaired when invalid/duplicate without colliding, fallback is s0/s1', () => {
  const mixed = normalizeStops([
    { id: 's1', position: 0, color: [0, 0, 0] },          // explicit id that collides with index-1's default
    { position: 0.5, color: [1, 1, 1] },                  // id-less at index 1 → s1 taken → s1x2
    { id: 'bad-id!', position: 1, color: [1, 0, 0] },     // invalid → s2
    { id: 's1', position: 0.7, color: [0, 1, 0] },        // duplicate → s3
    { position: 'x', color: [0, 0, 0] },                  // unusable → dropped
  ])
  assert(mixed.map((s) => s.id).join() === 's1,s1x2,s2,s3', mixed.map((s) => s.id).join())
  assert(new Set(mixed.map((s) => s.id)).size === mixed.length, 'duplicate ids after normalising')
  assert(JSON.stringify(normalizeStops(undefined)) === JSON.stringify(DEFAULT_RAMP_STOPS), 'fallback is not black→white s0/s1')
  assert(normalizeStops([{ position: 0, color: [1, 0, 0] }]).length === 2, 'a single stop must fall back like before')
  // Ids survive an edit that removes a stop (the editor writes normalised stops back).
  const kept = normalizeStops(STOPS).filter((s) => s.id !== 's1')
  assert(normalizeStops(kept).map((s) => s.id).join() === 's0,s2,s3', 'ids shifted after removing a stop')
  // A minted id is fresh and alphanumeric.
  const taken = new Set(['s0', 'sabc123'])
  let calls = 0
  const id = newStopId(taken, () => (calls++ === 0 ? 0.3 : 0.7))
  assert(/^[A-Za-z0-9]+$/.test(id) && !taken.has(id), `minted ${id}`)
  assert(stopParamId(id) === `stop_${id}`, 'param id shape')
})

test('the hidden stop params are hidden, uniform, non-connectable — no new UI, no new handle', () => {
  for (const type of ['color_ramp', 'gradient']) {
    const def = nodeRegistry.get(type)!
    const ps = resolveParams(def, { stops: STOPS }).filter((p) => p.id.startsWith('stop_'))
    assert(ps.length === STOPS.length, `${type}: ${ps.length} stop params`)
    assert(ps.every((p) => p.hidden && p.updateMode === 'uniform' && !p.connectable && p.type === 'color'), `${type}: a stop param is visible, connectable or not a uniform colour`)
  }
})

run('verify-ramp-knobs')
