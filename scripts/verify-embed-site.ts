/**
 * verify-embed-site — the `site-base` fixture and the static site-conformance
 * checklist (feature request §6, SR-9), offline: no GPU, no browser.
 *
 *   npx tsx scripts/verify-embed-site.ts              build + check the fixture (the gate)
 *   npx tsx scripts/verify-embed-site.ts <file.ombra> validate any .ombra, print the C1..C8 table
 *   npx tsx scripts/verify-embed-site.ts --write      (re)write public/shared/site-base.{sombra,ombra}, then check
 *
 * The gate (no argument):
 *   A. The fixture graph is the §6.1 table: node types, author labels, every
 *      wire accepted by the canvas's connection rule (enforced while building).
 *   B. publishScene → C1..C8 all pass (C4/C5/C7 pass, not merely warn) and the
 *      manifest carries the §6.1 keys. The full key list is pinned, so a knob
 *      appearing or vanishing is a visible change, not a silent one.
 *   C. The checklist can fail: each check is run against a broken variant of
 *      the fixture (or of the bytes) and must report fail/warn — so a pass above
 *      is a decision, not a default.
 *   D. The committed public/shared/site-base.ombra decodes, passes C1..C8, and
 *      carries the same manifest keys as a fresh build; the committed .sombra
 *      re-opens through the editor's importer with its labels and re-publishes
 *      to the same keys.
 *   E. Compat fixture (the pre-change recipe: four Color + three Mix, Dither ·
 *      Result → Remap → final Mix factor) still publishes and exposes its four
 *      colour knobs; its published shader and manifest equal the ones 5752aa9
 *      (before SR-1..SR-4) published for the same graph
 *      (scripts/baselines/site-compat-5752aa9.ombra). The GPU gate compares
 *      their pixels.
 *
 * Publishing happens with a `navigator.gpu` stub so the artifact carries WGSL,
 * exactly as the editor publishes in a WebGPU browser (publishScene adds WGSL
 * only when navigator.gpu exists); the stub is removed right after.
 *
 * Run: npm run verify:embed:site
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Edge } from '@xyflow/react'
import type { EdgeData } from '../src/nodes/types'
import { initializeNodeLibrary } from '../src/nodes'
import { publishScene, type PublishResult } from '../src/embed/publish'
import { decodeArtifactBytes } from '../src/embed/artifact'
import { exportToFile, encodeSombraPackage, decodeSombraPackage, importFromFile } from '../src/utils/sombra-file'
import { buildSiteBase, buildSiteCompat, REQUIRED_SITE_KEYS, SITE_STOP_HEX, hex, type Graph } from './lib/site-base-fixture'
import { checkSiteArtifact, formatSiteReport, type SiteReport } from './lib/site-conformance'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = path.resolve(import.meta.dirname, '..')
const OMBRA = path.join(ROOT, 'public/shared/site-base.ombra')
const SOMBRA = path.join(ROOT, 'public/shared/site-base.sombra')
const COMPAT_REF = path.join(ROOT, 'scripts/baselines/site-compat-5752aa9.ombra')

initializeNodeLibrary()

/** publishScene as a WebGPU-capable browser would run it (artifact carries WGSL). */
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

// ── CLI: validate an arbitrary file ──────────────────────────────────────────
const arg = process.argv[2]
if (arg && arg !== '--write') {
  const bytes = new Uint8Array(fs.readFileSync(arg))
  const r = checkSiteArtifact(bytes)
  console.log(`\n${arg}\n${formatSiteReport(r.rows)}`)
  if (r.artifact?.manifest) {
    console.log('\n  knobs:')
    for (const k of r.artifact.manifest) {
      console.log(`    ${k.key.padEnd(30)} ${`${k.type}/${k.glslType}`.padEnd(13)} ${k.named ? 'named ' : '      '}${JSON.stringify(k.default)}`)
    }
  }
  console.log(`\n  ${r.ok ? 'CONFORMS' : 'DOES NOT CONFORM'}`)
  process.exit(r.ok ? 0 : 1)
}

// ── --write: regenerate the committed fixture files ─────────────────────────
if (arg === '--write') {
  const g = buildSiteBase()
  const pub = publishWithWgsl(g)
  fs.mkdirSync(path.dirname(OMBRA), { recursive: true })
  fs.writeFileSync(OMBRA, pub.sceneBytes)
  fs.writeFileSync(SOMBRA, encodeSombraPackage(exportToFile(g.nodes, g.edges)))
  console.log(`  wrote ${path.relative(ROOT, OMBRA)} (${pub.sceneBytes.length} B) and ${path.relative(ROOT, SOMBRA)}`)
}

// ── The gate ────────────────────────────────────────────────────────────────
const fixture = buildSiteBase()
const pub = publishWithWgsl(fixture)
const report = checkSiteArtifact(pub.sceneBytes)
const keys = pub.manifest.map((k) => k.key)
console.log(`\nsite-base (fresh build)\n${formatSiteReport(report.rows)}\n`)

/**
 * The full published key list, in manifest (uniform) order. §6.1 fixes only the
 * author-named keys; pinning the rest makes any knob change a reviewed diff.
 * `site-dots-dither` is NOT in §6.1's list: it is Dither's circle-shape "Dither"
 * param — hidden in the UI for Shape Square, but still a uniform, so it
 * publishes (as on every Dither node).
 */
const PINNED_KEYS = [
  'pixelate-pixel-size', 'site-clock-speed', 'site-seed-value',
  'fbm-scale', 'fbm-offset-x', 'fbm-offset-y', 'fbm-octaves', 'fbm-lacunarity', 'fbm-gain',
  'site-balance-value', 'site-dots-pixel-size', 'site-dots-dither',
  'remap-in-min', 'remap-in-max', 'remap-out-min', 'remap-out-max',
  'noise-scale', 'noise-offset-x', 'noise-offset-y',
  'remap-2-in-min', 'remap-2-in-max', 'remap-2-out-min', 'remap-2-out-max',
  'site-palette-stop-0', 'site-palette-stop-1', 'site-palette-stop-2', 'site-palette-stop-3',
  'fragment-output-alpha',
]

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!
const clone = (g: Graph): Graph => structuredClone(g)
const rowOf = (r: SiteReport, id: string) => r.rows.find((x) => x.id === id)!
const variant = (mutate: (g: Graph) => void): SiteReport => {
  const g = clone(fixture); mutate(g)
  return checkSiteArtifact(publishWithWgsl(g).sceneBytes)
}

// A ────────────────────────────────────────────────────────────────────────
test('A. fixture is the §6.1 table (types, labels, settings) + the SR-6 fallback Remap', () => {
  const want: Array<[string, string, string | undefined]> = [
    ['site-clock', 'time', 'site.clock'], ['pixelate', 'pixelate', undefined], ['site-seed', 'float_constant', 'site.seed'],
    ['fbm', 'fbm', undefined], ['site-balance', 'float_constant', 'site.balance'], ['add', 'arithmetic', undefined],
    ['site-dots', 'dither', 'site.dots'], ['noise', 'noise', undefined], ['remap-selector', 'remap', undefined],
    ['multiply', 'arithmetic', undefined], ['site-palette', 'color_ramp', 'site.palette'], ['output', 'fragment_output', undefined],
    ['remap-mask', 'remap', undefined],   // SR-6 fallback (Dither·Result → Remap 0..0.5 → 0..1)
  ]
  assert(fixture.nodes.length === want.length, `${fixture.nodes.length} nodes`)
  for (const [id, type, label] of want) {
    const n = node(fixture, id)
    assert(n && n.data.type === type, `${id} is not a ${type}`)
    assert(n.data.label === label, `${id} label ${String(n.data.label)} ≠ ${String(label)}`)
  }
  const p = (id: string) => node(fixture, id).data.params
  assert(p('site-clock').speed === 0.05 && p('pixelate').pixelSize === 64 && p('site-seed').value === 123, 'time/pixelate/seed settings')
  assert(p('fbm').noiseType === 'value' && p('fbm').fractalMode === 'standard' && p('fbm').octaves === 4 && p('fbm').lacunarity === 2 && p('fbm').gain === 0.5, 'fbm settings')
  assert(p('add').operation === 'add' && p('multiply').operation === 'multiply', 'arithmetic ops')
  assert(p('site-dots').pixelSize === 8 && p('site-dots').shape === 'square' && p('site-dots').colorSource === 'live', 'dither settings')
  assert(p('noise').noiseType === 'simplex' && p('remap-selector').outMin === 0.3 && p('remap-selector').outMax === 0.9, 'selector settings')
  assert(p('remap-mask').inMax === 0.5 && p('remap-mask').outMax === 1, 'mask remap settings')
  const o = p('output')
  assert(o.alpha === 1 && o.alphaOp === 'multiply' && o.quality === 'high' && o.anchor === 'center', 'output settings')
  const stops = p('site-palette').stops as Array<{ position: number; color: number[] }>
  assert(p('site-palette').interpolation === 'constant' && stops.length === 4, 'ramp interpolation / stop count')
  stops.forEach((s, k) => {
    assert(s.position === [0, 0.25, 0.5, 0.75][k], `stop ${k} position ${s.position}`)
    assert(JSON.stringify(s.color) === JSON.stringify(hex(SITE_STOP_HEX[k])) && s.color[3] === 1, `stop ${k} colour`)
  })
  assert(new Set(stops.map((s) => s.color.join())).size === 4, 'stop colours not distinct')
  // §6.1 wires (+ the fallback's two).
  const e = new Set(fixture.edges.map((x) => `${x.source}.${x.sourceHandle}>${x.target}.${x.targetHandle}`))
  for (const w of [
    'pixelate.uv>fbm.coords', 'pixelate.uv>noise.coords', 'site-clock.time>fbm.phase', 'site-clock.time>noise.phase',
    'site-seed.value>fbm.seed', 'site-seed.value>noise.seed', 'fbm.value>add.in_0', 'site-balance.value>add.in_1',
    'add.result>site-dots.threshold', 'noise.value>remap-selector.value', 'site-dots.result>remap-mask.value',
    'remap-mask.result>multiply.in_0', 'remap-selector.result>multiply.in_1', 'multiply.result>site-palette.t',
    'site-palette.color>output.color',
  ]) assert(e.has(w), `missing wire ${w}`)
  assert(e.size === 15, `${e.size} wires`)
})

// B ────────────────────────────────────────────────────────────────────────
test('B. fresh publish passes C1..C8 (C4, C5, C7 pass outright) and carries WGSL', () => {
  const bad = report.rows.filter((r) => r.status === 'fail' || r.status === 'warn')
  assert(bad.length === 0, bad.map((r) => `${r.id} ${r.status}: ${r.detail}`).join(' | '))
  assert(report.artifact?.plan.wgsl?.passes?.length, 'no WGSL in the artifact (stub not engaged)')
  assert(report.artifact?.plan.isTimeLiveAtOutput === true, 'fixture is not time-live')
})

test('B. manifest: every §6.1 key present; the named knobs are named and only they start with site-', () => {
  for (const k of REQUIRED_SITE_KEYS) assert(keys.includes(k), `missing ${k} (have ${keys.join(', ')})`)
  for (const k of pub.manifest) assert((k.named === true) === k.key.startsWith('site-'), `${k.key}: named=${String(k.named)}`)
  const stops = pub.manifest.filter((k) => k.group === 'stops')
  stops.forEach((k, n) => {
    assert(k.key === `site-palette-stop-${n}` && k.index === n && k.position === [0, 0.25, 0.5, 0.75][n], `stop ${n}: ${k.key}`)
    assert(JSON.stringify(k.default) === JSON.stringify(hex(SITE_STOP_HEX[n])), `stop ${n} default ${JSON.stringify(k.default)}`)
  })
})

test('B. manifest: the full key list is the pinned one', () => {
  assert(JSON.stringify(keys) === JSON.stringify(PINNED_KEYS),
    `keys changed:\n      got  ${keys.join(', ')}\n      want ${PINNED_KEYS.join(', ')}`)
})

// C ────────────────────────────────────────────────────────────────────────
test('C. C1 fails on bytes that do not inflate, and on v/kind it does not know', () => {
  assert(rowOf(checkSiteArtifact(new Uint8Array([1, 2, 3, 4])), 'C1').status === 'fail', 'garbage bytes passed C1')
  const a = decodeArtifactBytes(pub.sceneBytes)
  const reenc = async (o: unknown) => (await import('pako')).default.deflate(JSON.stringify(o))
  return Promise.all([reenc({ ...a, v: 2 }), reenc({ ...a, kind: 'live' })]).then(([v2, live]) => {
    assert(rowOf(checkSiteArtifact(v2), 'C1').status === 'fail', 'v:2 passed C1')
    assert(rowOf(checkSiteArtifact(live), 'C1').status === 'fail', "kind:'live' passed C1")
  })
})

test('C. C2 fails without the palette label, on a gap in the stop numbers, and on an RGB stop', async () => {
  assert(rowOf(variant((g) => { delete node(g, 'site-palette').data.label }), 'C2').status === 'fail', 'unlabelled ramp passed C2')
  // Artifact surgery for shapes no graph can produce today.
  const { default: pako } = await import('pako')
  const a = decodeArtifactBytes(pub.sceneBytes)
  const gap = { ...a, manifest: a.manifest.filter((k) => k.key !== 'site-palette-stop-1') }
  assert(rowOf(checkSiteArtifact(pako.deflate(JSON.stringify(gap))), 'C2').status === 'fail', 'stops 0,2,3 passed C2')
  const rgb = { ...a, manifest: a.manifest.map((k) => k.key === 'site-palette-stop-2' ? { ...k, glslType: 'vec3', default: [1, 0, 0] } : k) }
  assert(rowOf(checkSiteArtifact(pako.deflate(JSON.stringify(rgb))), 'C2').status === 'fail', 'an RGB vec3 stop passed C2')
})

test('C. C3 fails when Fragment Output alpha is wired (no alpha knob)', () => {
  const r = variant((g) => g.edges.push({ id: 'ea', source: 'site-balance', sourceHandle: 'value', target: 'output', targetHandle: 'alpha' } as Edge<EdgeData>))
  assert(rowOf(r, 'C3').status === 'fail', `C3 ${rowOf(r, 'C3').status}`)
})

test('C. C4 / C5 warn (not fail) when balance / seed are unlabelled', () => {
  const r = variant((g) => { delete node(g, 'site-balance').data.label; delete node(g, 'site-seed').data.label })
  assert(rowOf(r, 'C4').status === 'warn' && rowOf(r, 'C5').status === 'warn', `C4 ${rowOf(r, 'C4').status}, C5 ${rowOf(r, 'C5').status}`)
  assert(r.ok, 'a missing optional role must not fail the scene')
})

test('C. C6 fails when two nodes share a site label', () => {
  const r = variant((g) => { node(g, 'site-seed').data.label = 'site.balance' })
  assert(rowOf(r, 'C6').status === 'fail', `C6 ${rowOf(r, 'C6').status}: ${rowOf(r, 'C6').detail}`)
  assert(!r.ok, 'a label clash must fail the scene')
})

test('C. C7 warns on adaptive and low quality', () => {
  for (const q of ['adaptive', 'low']) {
    const r = variant((g) => { node(g, 'output').data.params.quality = q })
    assert(rowOf(r, 'C7').status === 'warn', `${q}: C7 ${rowOf(r, 'C7').status}`)
  }
})

// D ────────────────────────────────────────────────────────────────────────
test('D. committed public/shared/site-base.ombra conforms and has the fresh build\'s keys', () => {
  assert(fs.existsSync(OMBRA), `${path.relative(ROOT, OMBRA)} missing — run with --write`)
  const r = checkSiteArtifact(new Uint8Array(fs.readFileSync(OMBRA)))
  const bad = r.rows.filter((x) => x.status === 'fail' || x.status === 'warn')
  assert(bad.length === 0, bad.map((x) => `${x.id}: ${x.detail}`).join(' | '))
  const committed = r.artifact!.manifest.map((k) => k.key)
  assert(JSON.stringify(committed) === JSON.stringify(keys), `committed keys ${committed.join(', ')}`)
  assert(r.artifact!.plan.wgsl?.passes?.length, 'committed .ombra has no WGSL (plays on WebGL2 only)')
  // Informational: a different shader means the file predates a codegen change.
  const fresh = report.artifact!.plan.passes.map((p) => p.fragmentShader).join('\n')
  const theirs = r.artifact!.plan.passes.map((p) => p.fragmentShader).join('\n')
  if (fresh !== theirs) console.warn('  [WARN] committed site-base.ombra shader differs from a fresh build — regenerate with --write')
})

test('D. committed public/shared/site-base.sombra re-opens with its labels and re-publishes to the same keys', () => {
  assert(fs.existsSync(SOMBRA), `${path.relative(ROOT, SOMBRA)} missing — run with --write`)
  const { nodes, edges } = importFromFile(decodeSombraPackage(fs.readFileSync(SOMBRA)))
  const labels = nodes.filter((n) => n.data.label).map((n) => n.data.label).sort()
  assert(JSON.stringify(labels) === JSON.stringify(['site.balance', 'site.clock', 'site.dots', 'site.palette', 'site.seed']), `labels ${labels.join(', ')}`)
  const again = publishWithWgsl({ nodes, edges }).manifest.map((k) => k.key)
  assert(JSON.stringify(again) === JSON.stringify(keys), `re-published keys ${again.join(', ')}`)
})

// E ────────────────────────────────────────────────────────────────────────
const compat = buildSiteCompat()
const compatPub = publishWithWgsl(compat)

test('E. compat fixture: still publishes (one pass) and exposes its four colour knobs', () => {
  const a = decodeArtifactBytes(compatPub.sceneBytes)
  assert(a.plan.success && a.plan.passes.length === 1, 'compat did not publish to one pass')
  const colours = compatPub.manifest.filter((k) => k.nodeType === 'color_constant')
  assert(colours.length === 4 && colours.every((k) => k.type === 'color' && k.glslType === 'vec4'), `colour knobs: ${colours.map((k) => k.key).join(', ')}`)
  const defaults = new Set(colours.map((k) => JSON.stringify(k.default)))
  for (const h of SITE_STOP_HEX) assert(defaults.has(JSON.stringify(hex(h))), `no colour knob defaults to ${h}`)
})

test('E. compat fixture: shader + manifest equal what 5752aa9 published for the same graph', () => {
  assert(fs.existsSync(COMPAT_REF), `${path.relative(ROOT, COMPAT_REF)} missing`)
  const ref = decodeArtifactBytes(new Uint8Array(fs.readFileSync(COMPAT_REF)))
  const now = decodeArtifactBytes(compatPub.sceneBytes)
  const refKeys = ref.manifest.map((k) => `${k.key}=${JSON.stringify(k.default)}`)
  const nowKeys = now.manifest.map((k) => `${k.key}=${JSON.stringify(k.default)}`)
  assert(JSON.stringify(refKeys) === JSON.stringify(nowKeys), `manifest drifted:\n      5752aa9 ${refKeys.join(', ')}\n      now     ${nowKeys.join(', ')}`)
  const glsl = (x: typeof ref) => x.plan.passes.map((p) => p.fragmentShader).join('\n')
  const wgsl = (x: typeof ref) => (x.plan.wgsl?.passes ?? []).map((p) => p.shaderCode).join('\n')
  assert(glsl(ref) === glsl(now), 'GLSL fragment shader differs from 5752aa9')
  assert(wgsl(ref).length > 0 && wgsl(ref) === wgsl(now), 'WGSL differs from 5752aa9 (or the reference has none)')
})

await run('verify-embed-site')
