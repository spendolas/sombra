/**
 * Does the Kawase blur stay CLEAN at large radius — no crawling grid — thanks to the
 * stochastic per-pixel tap rotation?
 *
 * A plain fixed-tap Kawase at large radius has passband recurrences: high-frequency content
 * leaks through in a coherent GRID that crawls when the content moves. Measured on this exact
 * node WITHOUT jitter: worst grating leakage 131 codes at radius 256, and a fixed pixel
 * flickered by the same as content panned. The per-pixel hashed rotation fills the kernel gaps
 * and decorrelates the residual into STATIC (screen-fixed) grain, so:
 *   - LEAKAGE: the largest grating amplitude that survives an extreme blur must be small
 *     (a true Gaussian crushes them to 0). Threshold 20 codes — far below the 131 the
 *     un-jittered kernel leaks, so removing the jitter fails this gate (mechanism-engaged).
 *   - TEMPORAL: with the grating PANNING, a fixed screen pixel must barely change — the proof
 *     there is no crawl. Threshold 12 codes (un-jittered: the full passband, tens of codes).
 *   - GRAIN: the static noise the jitter trades the grid for must be tiny (< a few codes),
 *     or we have swapped one artifact for another.
 *
 * Run: npx tsx scripts/verify-kawase-shimmer.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { createRig, type RawGlslPass } from './blur-bakeoff/lib/gpu-rig'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './blur-bakeoff/lib/image'
import { gaussianBlur } from './blur-bakeoff/lib/reference'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

// Wide, so the blur kernel never reaches the image edges at the measured centre.
const W = 1024, H = 8, CENTER = 512

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

/** Vertical grating along x, sub-pixel phase shift = a pan. */
function grating(period: number, phase: number): Rgba8 {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.round(128 + 120 * Math.cos(2 * Math.PI * (x - phase) / period))
    const i = (y * W + x) * 4; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
  }
  return { width: W, height: H, data: d }
}

function blurPasses(radius: number): RawGlslPass[] {
  const plan = compileGraph(
    [n('src', 'checkerboard'), n('fx', 'kawase_blur', { radius }), n('out', 'fragment_output')],
    [e('e1', 'src', 'color', 'fx', 'source'), e('e2', 'fx', 'color', 'out', 'color')],
  )
  if (!plan.success) throw new Error('compile failed: ' + JSON.stringify(plan.errors))
  return plan.passes.slice(1).map((p) => ({
    fragmentShader: p.fragmentShader, vertexShader: p.vertexShader,
    sampler: Object.keys(p.inputTextures)[0], scale: p.resolution ?? 1,
    userUniforms: (p.userUniforms ?? []).map((u) => ({
      name: u.name, glslType: u.glslType as 'float', value: Array.isArray(u.value) ? u.value[0] : u.value,
    })),
  }))
}

const row = (img: Rgba8) => { const y = H / 2 | 0, r: number[] = []; for (let x = 384; x < 640; x++) r.push(img.data[(y * W + x) * 4]); return r }
const centerPx = (img: Rgba8) => img.data[((H / 2 | 0) * W + CENTER) * 4]
const grain = (r: number[]) => { let ss = 0; for (let i = 1; i < r.length; i++) ss += (r[i] - r[i - 1]) ** 2; return Math.sqrt(ss / (r.length - 1)) }

const rig = await createRig()
const R = 256, sigma = R / 3
const PERIODS = [6, 8, 12, 16, 24, 32, 48, 64]

// Capture eagerly (rig closes below): one static frame per period, plus a pan sweep.
const staticCap = new Map<number, Rgba8>()
const panCap = new Map<number, number[]>() // period -> centre pixel across phases
const PH = 12
for (const P of PERIODS) {
  staticCap.set(P, await rig.captureRawGlsl({ width: W, height: H, input: grating(P, 0), passes: blurPasses(R), dpr: 1 }))
  const seq: number[] = []
  for (let i = 0; i < PH; i++) seq.push(centerPx(await rig.captureRawGlsl({ width: W, height: H, input: grating(P, P * i / PH), passes: blurPasses(R), dpr: 1 })))
  panCap.set(P, seq)
}
// Reference sanity: a true Gaussian crushes these gratings (proves the stimulus is in-band).
const refLeak = Math.max(...PERIODS.map((P) => {
  const r = row(encodeToSrgb8(gaussianBlur(decodeToLinear(grating(P, 0)), sigma)))
  return Math.max(...r) - Math.min(...r)
}))
await rig.close()

test('WebGL2 available (a skipped run proves nothing)', () => {
  assert(rig.available.webgl2, 'WebGL2 unavailable — this gate cannot run')
})

test('reference Gaussian crushes every grating (stimulus is in-band, gate is meaningful)', () => {
  assert(refLeak < 2, `reference leaked ${refLeak} codes — gratings not fully in-band, gate would be vacuous`)
})

test(`r${R}: grating leakage stays low (un-jittered kernel leaks 131 — jitter must fix it)`, () => {
  let worst = 0, wp = 0
  for (const P of PERIODS) { const r = row(staticCap.get(P)!); const amp = Math.max(...r) - Math.min(...r); if (amp > worst) { worst = amp; wp = P } }
  assert(worst < 20, `worst leakage ${worst} codes at period ${wp} (want < 20; no-jitter baseline 131)`)
})

test(`r${R}: no crawl — a fixed pixel barely moves as the grating pans`, () => {
  let worst = 0, wp = 0
  for (const P of PERIODS) { const s = panCap.get(P)!; const fl = Math.max(...s) - Math.min(...s); if (fl > worst) { worst = fl; wp = P } }
  assert(worst < 12, `worst fixed-pixel flicker ${worst} codes at period ${wp} (want < 12; the crawl the jitter removes)`)
})

test(`r${R}: the static grain traded for the grid is tiny`, () => {
  let worst = 0
  for (const P of PERIODS) worst = Math.max(worst, grain(row(staticCap.get(P)!)))
  assert(worst < 4, `worst grain ${worst.toFixed(1)} codes (want < 4 — jitter must not swap grid for visible noise)`)
})

await run('kawase-shimmer')
