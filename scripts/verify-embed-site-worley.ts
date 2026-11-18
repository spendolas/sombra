/**
 * verify-embed-site-worley — the `site-worley-ridged` scene (spectra Preset 3
 * "Worley Ridged" as a site scene) and its static site conformance, offline:
 * no GPU, no browser. Sibling of verify-embed-site.ts (site-base).
 *
 *   npx tsx scripts/verify-embed-site-worley.ts          build + check (the gate)
 *   npx tsx scripts/verify-embed-site-worley.ts --write  (re)write public/shared/site-worley-ridged.{sombra,ombra}, then check
 *
 *   A. The fixture is the recipe: node types, labels, settings, and every wire
 *      (each accepted by the canvas's connection rule while building).
 *   B. A fresh publish passes C1..C8 (C4, C5, C7 pass, not merely warn), is ONE
 *      pass, carries WGSL, is time-live; the required keys are present and the
 *      full key list is pinned.
 *   M. Mechanism, read from the published shader text of BOTH backends: the
 *      main field is worley2d at the 3-sample warp's warped coords AND warped
 *      phase; the colour branch is the same at half time; the dither threshold
 *      is the wired Remap of feed = field + balance (no threshold knob); the
 *      shader is highp. Each assertion is run against a variant that breaks
 *      exactly what it guards (warp depth 2, value noise instead of worley2d,
 *      the warped-phase wire dropped, the threshold left unwired) and must fail.
 *   K. The threshold calibration is spectra's: for feed on a fine grid, the
 *      number of lit Bayer dots per cell (Sombra: k/63 ≤ thr) equals spectra's
 *      (feed + 0.015 ≥ 1 − k/64) for every feed; balance −1 → 0 dots, +0.985 →
 *      64. A changed threshold or accent map fails here.
 *   C. The (widened) C2 still fails where it must: an unlabelled stop node, a
 *      gap in the stop numbers, ramp and per-node key forms mixed.
 *   D. The committed public/shared/site-worley-ridged.ombra is BYTE-identical
 *      to a fresh publish and passes C1..C8; the committed .sombra is
 *      byte-identical to a fresh export, re-opens with its labels and
 *      re-publishes to the same bytes.
 *
 * Publishing happens with a `navigator.gpu` stub so the artifact carries WGSL,
 * exactly as the editor publishes in a WebGPU browser.
 *
 * Run: npm run verify:embed:site-worley
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Edge } from '@xyflow/react'
import type { EdgeData } from '../src/nodes/types'
import { initializeNodeLibrary } from '../src/nodes'
import { publishScene, type PublishResult } from '../src/embed/publish'
import { decodeArtifactBytes, type SceneArtifact } from '../src/embed/artifact'
import { exportToFile, encodeSombraPackage, decodeSombraPackage, importFromFile } from '../src/utils/sombra-file'
import type { Graph } from './lib/site-base-fixture'
import {
  buildSiteWorleyRidged, WR_REQUIRED_KEYS, SITE_STOP_HEX, hex,
  WR_WARP_SCALE, WR_WARP_STRENGTH, WR_CLOCK_SPEED, WR_DOT_PX, WR_CELL_PX, WR_THR_OUT, WR_ACCENT_EDGES, WR_BLEND_MAX,
} from './lib/site-worley-ridged-fixture'
import { checkSiteArtifact, formatSiteReport, type SiteReport } from './lib/site-conformance'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = path.resolve(import.meta.dirname, '..')
const OMBRA = path.join(ROOT, 'public/shared/site-worley-ridged.ombra')
const SOMBRA = path.join(ROOT, 'public/shared/site-worley-ridged.sombra')

initializeNodeLibrary()

function publishWithWgsl(g: Graph): PublishResult {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true, writable: true })
  try {
    return publishScene(g.nodes, g.edges)
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
}
const sombraBytes = (g: Graph) => encodeSombraPackage(exportToFile(g.nodes, g.edges))

if (process.argv[2] === '--write') {
  const g = buildSiteWorleyRidged()
  const pub = publishWithWgsl(g)
  fs.mkdirSync(path.dirname(OMBRA), { recursive: true })
  fs.writeFileSync(OMBRA, pub.sceneBytes)
  const s = sombraBytes(g)
  fs.writeFileSync(SOMBRA, s)
  console.log(`  wrote ${path.relative(ROOT, OMBRA)} (${pub.sceneBytes.length} B) and ${path.relative(ROOT, SOMBRA)} (${s.length} B)`)
}

const fixture = buildSiteWorleyRidged()
const pub = publishWithWgsl(fixture)
const report = checkSiteArtifact(pub.sceneBytes)
const keys = pub.manifest.map((k) => k.key)
console.log(`\nsite-worley-ridged (fresh build)\n${formatSiteReport(report.rows)}\n`)

/** Full published key list in manifest (uniform) order — any knob change is a reviewed diff. */
const PINNED_KEYS = [
  'site-palette-stop-0-color', 'site-palette-stop-1-color', 'site-palette-stop-2-color',
  'pixelate-pixel-size', 'site-clock-speed',
  'remap-in-min', 'remap-in-max', 'remap-out-min', 'remap-out-max',
  'site-seed-value',
  'site-warp-color-scale', 'site-warp-color-rotate', 'site-warp-color-offset-x', 'site-warp-color-offset-y', 'site-warp-color-strength',
  'noise-scale', 'noise-rotate', 'noise-offset-x', 'noise-offset-y',
  'smoothstep-low', 'smoothstep-high',
  'remap-2-in-min', 'remap-2-in-max', 'remap-2-out-min', 'remap-2-out-max',
  'site-palette-stop-3-color',
  'site-warp-scale', 'site-warp-rotate', 'site-warp-offset-x', 'site-warp-offset-y', 'site-warp-strength',
  'noise-2-scale', 'noise-2-rotate', 'noise-2-offset-x', 'noise-2-offset-y',
  'smoothstep-2-low', 'smoothstep-2-high',
  'site-balance-value',
  'smoothstep-3-low', 'smoothstep-3-high',
  'remap-3-in-min', 'remap-3-in-max', 'remap-3-out-min', 'remap-3-out-max',
  'remap-4-in-min', 'remap-4-in-max', 'remap-4-out-min', 'remap-4-out-max',
  'site-dots-pixel-size', 'site-dots-dither',
  'remap-5-in-min', 'remap-5-in-max', 'remap-5-out-min', 'remap-5-out-max',
  'fragment-output-alpha',
]

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!
const rowOf = (r: SiteReport, id: string) => r.rows.find((x) => x.id === id)!
const variantGraph = (mutate: (g: Graph) => void): Graph => { const g = structuredClone(fixture); mutate(g); return g }
const dropEdge = (g: Graph, source: string, sp: string, target: string, tp: string) => {
  const n = g.edges.length
  g.edges = g.edges.filter((e) => !(e.source === source && e.sourceHandle === sp && e.target === target && e.targetHandle === tp))
  assert(g.edges.length === n - 1, `variant: no wire ${source}.${sp} → ${target}.${tp} to drop`)
}

// A ────────────────────────────────────────────────────────────────────────
test('A. fixture: node types, labels and settings are the recipe', () => {
  const want: Array<[string, string, string | undefined]> = [
    ['site-clock', 'time', 'site.clock'], ['pixelate', 'pixelate', undefined], ['site-seed', 'float_constant', 'site.seed'],
    ['half-clock', 'remap', undefined],
    ['warp', 'warp', 'site.warp'], ['field', 'noise', undefined], ['ridged', 'ridged', undefined], ['smooth', 'smoothstep', undefined],
    ['c-warp', 'warp', 'site.warp-color'], ['c-field', 'noise', undefined], ['c-ridged', 'ridged', undefined], ['c-smooth', 'smoothstep', undefined],
    ['site-balance', 'float_constant', 'site.balance'], ['feed', 'arithmetic', undefined], ['thr', 'remap', undefined],
    ['site-dots', 'dither', 'site.dots'], ['mask', 'remap', undefined], ['acc', 'smoothstep', undefined], ['acc-k', 'remap', undefined],
    ['cv-k', 'remap', undefined],
    ['site-palette-stop-0', 'color_constant', 'site.palette.stop-0'], ['site-palette-stop-1', 'color_constant', 'site.palette.stop-1'],
    ['site-palette-stop-2', 'color_constant', 'site.palette.stop-2'], ['site-palette-stop-3', 'color_constant', 'site.palette.stop-3'],
    ['mix-cv', 'mix', undefined], ['mix-acc', 'mix', undefined], ['mix-m', 'mix', undefined], ['output', 'fragment_output', undefined],
  ]
  assert(fixture.nodes.length === want.length, `${fixture.nodes.length} nodes, want ${want.length}`)
  for (const [id, type, label] of want) {
    const n = node(fixture, id)
    assert(n && n.data.type === type, `${id} is not a ${type}`)
    assert(n.data.label === label, `${id} label ${String(n.data.label)} ≠ ${String(label)}`)
  }
  const p = (id: string) => node(fixture, id).data.params
  assert(p('site-clock').speed === WR_CLOCK_SPEED && WR_CLOCK_SPEED === 2.5e-6, `clock speed ${String(p('site-clock').speed)}`)
  assert(p('pixelate').pixelSize === WR_CELL_PX && p('site-dots').pixelSize === WR_DOT_PX && WR_CELL_PX === 8 * WR_DOT_PX, 'cell must be exactly 8 dots')
  assert(p('site-dots').shape === 'square' && p('site-dots').colorSource === 'live', 'dither square/live')
  for (const [w, s] of [['warp', WR_WARP_SCALE], ['c-warp', 2 * WR_WARP_SCALE]] as const) {
    assert(p(w).noiseType === 'value' && p(w).warpDepth === '3' && p(w).strength === WR_WARP_STRENGTH && p(w).srt_scale === s, `${w} settings`)
  }
  assert(WR_WARP_SCALE === 900 / 51.2, 'warp scale is H_css/51.2 for 900')
  for (const f of ['field', 'c-field']) assert(p(f).noiseType === 'worley2d' && p(f).srt_scale === 1, `${f} settings`)
  for (const s of ['smooth', 'c-smooth']) assert(p(s).min === 0.2 && p(s).max === 0.8, `${s} edges`)
  assert(p('half-clock').outMax === 0.5 && p('half-clock').inMax === 1 && p('half-clock').inMin === 0 && p('half-clock').outMin === 0, 'half clock')
  assert(p('feed').operation === 'add', 'feed adds')
  assert(p('thr').outMin === WR_THR_OUT[0] && p('thr').outMax === WR_THR_OUT[1], 'threshold remap')
  assert(p('acc').min === WR_ACCENT_EDGES[0] && p('acc').max === WR_ACCENT_EDGES[1], 'accent edges')
  assert(p('acc-k').outMax === WR_BLEND_MAX && p('cv-k').outMax === WR_BLEND_MAX && WR_BLEND_MAX === 0.3, 'blend caps')
  assert(p('mask').inMax === 0.5 && p('mask').outMax === 1, 'mask remap')
  for (let k = 0; k < 4; k++) assert(JSON.stringify(p(`site-palette-stop-${k}`).color) === JSON.stringify(hex(SITE_STOP_HEX[k])), `stop ${k} colour`)
  const o = p('output')
  assert(o.alpha === 1 && o.alphaOp === 'multiply' && o.quality === 'high' && o.anchor === 'center', 'output settings')
})

test('A. fixture: the wires are exactly the recipe\'s', () => {
  const e = new Set(fixture.edges.map((x) => `${x.source}.${x.sourceHandle}>${x.target}.${x.targetHandle}`))
  const want = [
    'site-clock.time>half-clock.value',
    'pixelate.uv>warp.coords', 'site-clock.time>warp.phase', 'site-seed.value>warp.seed',
    'warp.warped>field.coords', 'warp.warpedPhase>field.phase', 'site-seed.value>field.seed',
    'field.value>ridged.value', 'ridged.result>smooth.x',
    'pixelate.uv>c-warp.coords', 'half-clock.result>c-warp.phase', 'site-seed.value>c-warp.seed',
    'c-warp.warped>c-field.coords', 'c-warp.warpedPhase>c-field.phase', 'site-seed.value>c-field.seed',
    'c-field.value>c-ridged.value', 'c-ridged.result>c-smooth.x',
    'smooth.result>feed.in_0', 'site-balance.value>feed.in_1', 'feed.result>thr.value', 'thr.result>site-dots.threshold',
    'site-dots.result>mask.value', 'feed.result>acc.x', 'acc.result>acc-k.value', 'c-smooth.result>cv-k.value',
    'site-palette-stop-1.color>mix-cv.a', 'site-palette-stop-2.color>mix-cv.b', 'cv-k.result>mix-cv.factor',
    'mix-cv.result>mix-acc.a', 'site-palette-stop-3.color>mix-acc.b', 'acc-k.result>mix-acc.factor',
    'site-palette-stop-0.color>mix-m.a', 'mix-acc.result>mix-m.b', 'mask.result>mix-m.factor', 'mix-m.result>output.color',
  ]
  for (const w of want) assert(e.has(w), `missing wire ${w}`)
  assert(e.size === want.length, `${e.size} wires, want ${want.length}`)
})

// B ────────────────────────────────────────────────────────────────────────
test('B. fresh publish passes C1..C8 outright, one pass, WGSL, time-live, timeSpeed = clock speed', () => {
  const bad = report.rows.filter((r) => r.status === 'fail' || r.status === 'warn')
  assert(bad.length === 0, bad.map((r) => `${r.id} ${r.status}: ${r.detail}`).join(' | '))
  const a = report.artifact!
  assert(a.plan.passes.length === 1, `${a.plan.passes.length} passes`)
  assert(a.plan.wgsl?.passes?.length === 1, 'no WGSL in the artifact (stub not engaged)')
  assert(a.plan.isTimeLiveAtOutput === true, 'not time-live')
  assert(a.meta.timeSpeed === WR_CLOCK_SPEED, `meta.timeSpeed ${a.meta.timeSpeed}`)
  assert(pub.clashes.length === 0, `label clashes: ${JSON.stringify(pub.clashes)}`)
})

test('B. manifest: required keys present, named ⇔ site-, stop defaults, pinned key list', () => {
  for (const k of WR_REQUIRED_KEYS) assert(keys.includes(k), `missing ${k}`)
  for (const k of pub.manifest) assert((k.named === true) === k.key.startsWith('site-'), `${k.key}: named=${String(k.named)}`)
  for (let n = 0; n < 4; n++) {
    const k = pub.manifest.find((x) => x.key === `site-palette-stop-${n}-color`)!
    assert(k.nodeId === `site-palette-stop-${n}` && k.param === 'color' && k.glslType === 'vec4', `stop ${n} address ${k.nodeId}.${k.param}`)
    assert(JSON.stringify(k.default) === JSON.stringify(hex(SITE_STOP_HEX[n])), `stop ${n} default`)
  }
  assert(!keys.includes('site-dots-threshold'), 'the dither threshold is a knob — its wire is gone')
  assert(JSON.stringify(keys) === JSON.stringify(PINNED_KEYS), `keys changed:\n      got  ${keys.join(', ')}\n      want ${PINNED_KEYS.join(', ')}`)
})

// M ────────────────────────────────────────────────────────────────────────
type Shaders = { glsl: string; wgsl: string }
const shadersOf = (a: SceneArtifact): Shaders => ({
  glsl: a.plan.passes.map((p) => p.fragmentShader).join('\n'),
  wgsl: (a.plan.wgsl?.passes ?? []).map((p) => (p as { shaderCode: string }).shaderCode).join('\n'),
})
const shadersOfGraph = (g: Graph) => shadersOf(decodeArtifactBytes(publishWithWgsl(g).sceneBytes))
const has = (s: string, re: RegExp) => re.test(s)

/** One field branch: Domain Warp with the 3rd (phase) sample → worley2d at warped coords + warped phase. */
function fieldMechanism(sh: Shaders, warp: string, field: string, phaseVar: string): string[] {
  const out: string[] = []
  for (const [lang, s] of [['glsl', sh.glsl], ['wgsl', sh.wgsl]] as const) {
    if (!has(s, /fn worley2d|float worley2d\(vec3 p\)/)) out.push(`${lang}: worley2d function missing`)
    if (!has(s, new RegExp(`node_${warp}_warped_z\\b[^;]*vnoise3d\\([^;]*${phaseVar}\\s*\\+\\s*9\\.151`))) out.push(`${lang}: ${warp} has no 3rd (phase) warp sample of ${phaseVar}`)
    if (!has(s, new RegExp(`node_${warp}_warpedPhase\\b[^;]*=\\s*\\(?${phaseVar}\\s*\\+\\s*\\(?node_${warp}_warped_z\\s*\\*`))) out.push(`${lang}: ${warp}.warpedPhase is not phase + z·strength`)
    if (!has(s, new RegExp(`node_${field}_value\\b[^;]*worley2d\\([^;]*node_${warp}_warpedPhase`))) out.push(`${lang}: ${field} is not worley2d(…, ${warp}.warpedPhase)`)
  }
  return out
}
/** The tail: feed = field + balance → Remap → the dither threshold (wired, square). */
function thresholdMechanism(sh: Shaders): string[] {
  const out: string[] = []
  for (const [lang, s] of [['glsl', sh.glsl], ['wgsl', sh.wgsl]] as const) {
    if (!has(s, /node_feed_result\b[^;]*node_smooth_result[^;]*\+[^;]*site_balance/)) out.push(`${lang}: feed is not field + site.balance`)
    if (!has(s, /node_thr_result\b[^;]*node_feed_result/)) out.push(`${lang}: threshold remap does not read feed`)
    if (!has(s, /pg_m_site_dots\b[^;]*step\(\s*pg_bv_site_dots\s*,\s*node_thr_result\s*\)/)) out.push(`${lang}: dither mask is not step(bayer, thr)`)
  }
  return out
}
const ALL_MECH = (sh: Shaders) => [
  ...fieldMechanism(sh, 'warp', 'field', 'node_site_clock_time'),
  ...fieldMechanism(sh, 'c_warp', 'c_field', 'node_half_clock_result'),
  ...thresholdMechanism(sh),
]

test('M. published shaders (GLSL + WGSL): worley2d at the 3-sample warp, both branches; threshold wired; highp', () => {
  const sh = shadersOf(report.artifact!)
  assert(sh.wgsl.length > 0, 'no WGSL to check')
  const bad = ALL_MECH(sh)
  assert(bad.length === 0, bad.join(' | '))
  assert(/precision highp float;/.test(sh.glsl) && !/mediump/.test(sh.glsl), 'GLSL is not highp-only')
  assert(/node_half_clock_result\b[^;]*node_site_clock_time/.test(sh.glsl), 'colour branch time is not derived from site.clock')
})

test('M. each mechanism assertion fails on the variant that breaks it', () => {
  const cases: Array<[string, (g: Graph) => void, (sh: Shaders) => string[]]> = [
    ['warp depth 2 (no phase sample)', (g) => { node(g, 'warp').data.params.warpDepth = '2' }, (sh) => fieldMechanism(sh, 'warp', 'field', 'node_site_clock_time')],
    ['value noise instead of worley2d', (g) => { node(g, 'field').data.params.noiseType = 'value' }, (sh) => fieldMechanism(sh, 'warp', 'field', 'node_site_clock_time')],
    ['warped-phase wire dropped', (g) => dropEdge(g, 'warp', 'warpedPhase', 'field', 'phase'), (sh) => fieldMechanism(sh, 'warp', 'field', 'node_site_clock_time')],
    ['colour branch on full time', (g) => { dropEdge(g, 'half-clock', 'result', 'c-warp', 'phase'); g.edges.push({ id: 'x', source: 'site-clock', sourceHandle: 'time', target: 'c-warp', targetHandle: 'phase', type: 'typed', data: { sourcePort: 'time', targetPort: 'phase', sourcePortType: 'float' } } as Edge<EdgeData>) }, (sh) => fieldMechanism(sh, 'c_warp', 'c_field', 'node_half_clock_result')],
    ['threshold unwired', (g) => dropEdge(g, 'thr', 'result', 'site-dots', 'threshold'), thresholdMechanism],
    ['balance not added', (g) => dropEdge(g, 'site-balance', 'value', 'feed', 'in_1'), thresholdMechanism],
  ]
  for (const [name, mutate, mech] of cases) {
    const bad = mech(shadersOfGraph(variantGraph(mutate)))
    assert(bad.length > 0, `variant "${name}" still passes its mechanism assertion`)
  }
})

// K ────────────────────────────────────────────────────────────────────────
/** Lit dots per 8×8 cell, from the PUBLISHED uniform defaults (so a changed map fails). */
function uniformDefault(key: string): number {
  const k = pub.manifest.find((x) => x.key === key)
  assert(k !== undefined && typeof k.default === 'number', `no float knob ${key}`)
  return k!.default as number
}
test('K. threshold calibration: Sombra lights exactly spectra\'s dot count for every feed; balance ends 0 and 64', () => {
  const f = Math.fround
  // Remap 4 is the threshold (keys pinned above): out = outMin + (feed − inMin)(outMax − outMin)/(inMax − inMin).
  const [iMin, iMax, oMin, oMax] = ['remap-4-in-min', 'remap-4-in-max', 'remap-4-out-min', 'remap-4-out-max'].map(uniformDefault)
  const thr = (feed: number) => f(f(oMin) + f(f(f(feed) - f(iMin)) * f(f(oMax) - f(oMin))) / f(f(iMax) - f(iMin)))
  const sombra = (feed: number) => { const t = thr(feed); let n = 0; for (let k = 0; k < 64; k++) if (f(k / 63) <= t) n++; return n }
  const spectra = (feed: number) => { let n = 0; for (let k = 0; k < 64; k++) if (f(f(feed) + f(0.015)) >= f(1 - k / 64)) n++; return n }
  let mismatches = 0, worst = ''
  for (let i = 0; i <= 200000; i++) {
    const feed = -1.2 + (2.4 * i) / 200000
    const a = sombra(feed), b = spectra(feed)
    if (a !== b) {
      mismatches++
      // Only allowed right on one of spectra's 64 step edges (float32 ties).
      let edge = Infinity
      for (let k = 0; k < 64; k++) edge = Math.min(edge, Math.abs(feed + 0.015 - (1 - k / 64)))
      if (edge > 1e-5 && !worst) worst = `feed ${feed}: sombra ${a}, spectra ${b}, ${edge} from a step edge`
    }
  }
  // A grid point that lands exactly on a step boundary can round either way in
  // float32 in either engine; allow those, nothing else (≤ 1 per boundary).
  assert(!worst && mismatches <= 64, `${mismatches} feeds light a different dot count${worst ? ` (off an edge: ${worst})` : ''}`)
  console.log(`    (calibration: ${mismatches} of 200001 feeds differ, all within 1e-5 of a spectra step edge)`)
  const field = (v: number) => v   // field ∈ [0,1] after Smoothstep
  assert(sombra(field(1) + -1) === 0 && sombra(field(0.5) - 1) === 0, 'balance −1 does not empty every cell')
  assert(sombra(field(0) + 0.985) === 64, `balance +0.985 at field 0 lights ${sombra(0.985)} of 64`)
  // The accent: spectra smoothstep(0.6, 0.9, field + 0.015 + balance) ≡ smoothstep(0.585, 0.885, feed).
  assert(uniformDefault('smoothstep-3-low') === 0.585 && uniformDefault('smoothstep-3-high') === 0.885, 'accent edges moved')
  assert(uniformDefault('remap-3-out-max') === 0.3 && uniformDefault('remap-2-out-max') === 0.3, 'blend caps moved')
})

test('K. the calibration check fails on a changed threshold map', () => {
  // The map the site-base profile uses for balance ([-0.7,0,0.65]) is a HOST
  // map; inside the scene the equivalent mistake is an uncalibrated remap. An
  // identity remap (out 0..1) must disagree with spectra on many feeds.
  const f = Math.fround
  const sombraIdentity = (feed: number) => { let n = 0; for (let k = 0; k < 64; k++) if (f(k / 63) <= f(feed)) n++; return n }
  const spectra = (feed: number) => { let n = 0; for (let k = 0; k < 64; k++) if (f(f(feed) + f(0.015)) >= f(1 - k / 64)) n++; return n }
  let mismatches = 0
  for (let i = 0; i <= 20000; i++) { const feed = (1.2 * i) / 20000; if (sombraIdentity(feed) !== spectra(feed)) mismatches++ }
  assert(mismatches > 1000, `identity threshold matched spectra on all but ${mismatches} feeds — the check has no teeth`)
})

// C ────────────────────────────────────────────────────────────────────────
test('C. C2 fails on an unlabelled stop, a gap in stop numbers, and mixed key forms', async () => {
  const unl = checkSiteArtifact(publishWithWgsl(variantGraph((g) => { delete node(g, 'site-palette-stop-1').data.label })).sceneBytes)
  assert(rowOf(unl, 'C2').status === 'fail', `unlabelled stop 1: C2 ${rowOf(unl, 'C2').status}`)
  const { default: pako } = await import('pako')
  const a = decodeArtifactBytes(pub.sceneBytes)
  const gap = { ...a, manifest: a.manifest.filter((k) => k.key !== 'site-palette-stop-2-color') }
  assert(rowOf(checkSiteArtifact(pako.deflate(JSON.stringify(gap))), 'C2').status === 'fail', 'stops 0,1,3 passed C2')
  const mixed = { ...a, manifest: a.manifest.map((k) => k.key === 'site-palette-stop-3-color' ? { ...k, key: 'site-palette-stop-3' } : k) }
  assert(rowOf(checkSiteArtifact(pako.deflate(JSON.stringify(mixed))), 'C2').status === 'fail', 'mixed ramp/per-node stop keys passed C2')
  const r = checkSiteArtifact(publishWithWgsl(variantGraph((g) => { node(g, 'site-seed').data.label = 'site.balance' })).sceneBytes)
  assert(rowOf(r, 'C6').status === 'fail', `label clash: C6 ${rowOf(r, 'C6').status}`)
})

// D ────────────────────────────────────────────────────────────────────────
test('D. committed site-worley-ridged.ombra is byte-identical to a fresh publish and conforms', () => {
  assert(fs.existsSync(OMBRA), `${path.relative(ROOT, OMBRA)} missing — run with --write`)
  const bytes = new Uint8Array(fs.readFileSync(OMBRA))
  const r = checkSiteArtifact(bytes)
  const bad = r.rows.filter((x) => x.status === 'fail' || x.status === 'warn')
  assert(bad.length === 0, bad.map((x) => `${x.id}: ${x.detail}`).join(' | '))
  assert(Buffer.compare(Buffer.from(bytes), Buffer.from(pub.sceneBytes)) === 0,
    `committed .ombra (${bytes.length} B) differs from a fresh publish (${pub.sceneBytes.length} B) — regenerate with --write`)
})

test('D. committed site-worley-ridged.sombra is byte-identical to a fresh export, re-opens with its labels, re-publishes to the same bytes', () => {
  assert(fs.existsSync(SOMBRA), `${path.relative(ROOT, SOMBRA)} missing — run with --write`)
  const bytes = fs.readFileSync(SOMBRA)
  assert(Buffer.compare(bytes, Buffer.from(sombraBytes(fixture))) === 0, 'committed .sombra differs from a fresh export — regenerate with --write')
  const { nodes, edges } = importFromFile(decodeSombraPackage(bytes))
  const labels = nodes.filter((n) => n.data.label).map((n) => n.data.label).sort()
  const want = ['site.balance', 'site.clock', 'site.dots', 'site.palette.stop-0', 'site.palette.stop-1', 'site.palette.stop-2',
    'site.palette.stop-3', 'site.seed', 'site.warp', 'site.warp-color']
  assert(JSON.stringify(labels) === JSON.stringify(want), `labels ${labels.join(', ')}`)
  const again = publishWithWgsl({ nodes, edges })
  assert(Buffer.compare(Buffer.from(again.sceneBytes), Buffer.from(pub.sceneBytes)) === 0, 're-opened .sombra publishes different bytes')
})

await run('verify-embed-site-worley')
