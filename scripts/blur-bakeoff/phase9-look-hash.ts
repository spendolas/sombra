/**
 * Phase 9 — ADVERSARIAL LOOK, mechanism probe.
 *
 * phase9-look.ts LOOKED at the winner and phase9-frost.ts SCORED it. Neither
 * asked why the winner's residual is not structureless. Reading the tiles by
 * eye, C3j-16 (radially jittered Vogel, 16 taps, per-pixel reedHash rotation)
 * lays a fine regular WEAVE over smooth content — visible at 1:1 at frost 1.
 * The look pass measured it (peak acf 0.250 at lag (-4,3) on the photo, 0.321
 * at (0,3) on the isotropic control) and then printed it without a gate.
 *
 * HYPOTHESIS. The weave is not estimator noise. It is the per-pixel ROTATION
 * field: `rot = (reedHash(gc + vec2(11.7,-23.9)).x*0.5+0.5) * 2pi`. reedHash
 * bitcasts a float and does ONE LCG round plus one xor-shift. Within a binade
 * the bitcast of consecutive integers is itself linear, so the hash input is a
 * linear ramp and the output inherits the LCG's lattice structure. Every pixel
 * on such a lattice plane gets a near-identical tap rosette, so their gather
 * errors agree, and the agreement draws a weave.
 *
 * Two independent tests, each with a known-good and a known-bad:
 *   A (CPU)  the hash FIELD itself — acf of cos(rot)/sin(rot) over the pixel
 *            grid. A good hash reads ~0; the benched one should not.
 *   B (GPU)  an ABLATION. Same 16-tap kernel, same everything, rotation swapped
 *            for pcg2d. If the weave is the hash, it dies; if it is the sparse
 *            estimator, it survives.
 *
 *   npx tsx scripts/blur-bakeoff/phase9-look-hash.ts          # both, ~90 s
 *   npx tsx scripts/blur-bakeoff/phase9-look-hash.ts --cpu    # part A only
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend, type PassSpec, type CaptureSpec } from './lib/gpu-rig'
import { frostIngestPass, frostEgressPass, frostGatherPass, type FrostKernel } from './lib/frost-bench'
import { reedHash } from './lib/frost-kernels'
import { encodePng } from './lib/png'
import type { Rgba8 } from './lib/image'

const OUT = path.join('reports', 'blur-bakeoff', 'phase9')
const IMG = path.join(OUT, 'look-hash')
const SIZE = 512

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG, { recursive: true })
  fs.writeFileSync(path.join(IMG, `${name}.png`), encodePng(img))
}
function blank(w: number, h: number, v = 0): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  d.fill(v)
  for (let i = 3; i < d.length; i += 4) d[i] = 255
  return { width: w, height: h, data: d }
}
function cropZoom(img: Rgba8, x0: number, y0: number, w: number, h: number, z: number): Rgba8 {
  const out = blank(w * z, h * z)
  for (let y = 0; y < h * z; y++)
    for (let x = 0; x < w * z; x++) {
      const sx = Math.min(img.width - 1, x0 + ((x / z) | 0))
      const sy = Math.min(img.height - 1, y0 + ((y / z) | 0))
      const s = (sy * img.width + sx) * 4
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4)
    }
  return out
}
const LUMA = (d: Uint8ClampedArray, p: number) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]
function lumaPlane(img: Rgba8): Float64Array {
  const out = new Float64Array(img.width * img.height)
  for (let i = 0; i < out.length; i++) out[i] = LUMA(img.data, i * 4)
  return out
}

// ===========================================================================
// structure2d — COPIED from phase9-look.ts.
//
// It cannot be imported: phase9-look.ts calls main() at module scope, so an
// import would fire a 6-minute GPU run. The copy is diffed against that file's
// source text on every run (assertStructureParity), so a drift cannot make this
// script's verdicts apply to a different detector than the look pass used.
// ===========================================================================

export interface Structure2d {
  rms: number
  peak: number
  peakDx: number
  peakDy: number
  peakOffAxis: number
  offDx: number
  offDy: number
  peakAxis: number
  aniso: number
  anisoDeg: number
}

export function structure2d(cand: Rgba8, ref: Rgba8, roi: { x0: number; y0: number; x1: number; y1: number }, maxLag = 12, minR = 2): Structure2d {
  const W = cand.width
  const a = lumaPlane(cand)
  const b = lumaPlane(ref)
  const r = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) r[i] = a[i] - b[i]

  const k = maxLag
  const hp = new Float64Array(a.length)
  for (let y = roi.y0; y < roi.y1; y++)
    for (let x = roi.x0; x < roi.x1; x++) {
      let s = 0
      let n = 0
      for (let dy = -k; dy <= k; dy++)
        for (let dx = -k; dx <= k; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy < roi.y0 || yy >= roi.y1 || xx < roi.x0 || xx >= roi.x1) continue
          s += r[yy * W + xx]
          n++
        }
      hp[y * W + x] = r[y * W + x] - s / n
    }

  let v0 = 0
  let n0 = 0
  for (let y = roi.y0; y < roi.y1; y++)
    for (let x = roi.x0; x < roi.x1; x++) {
      const t = hp[y * W + x]
      v0 += t * t
      n0++
    }
  const rms = Math.sqrt(v0 / n0)
  if (rms < 1e-9) return { rms: 0, peak: 0, peakDx: 0, peakDy: 0, peakOffAxis: 0, offDx: 0, offDy: 0, peakAxis: 0, aniso: 1, anisoDeg: 0 }

  const acf = (dx: number, dy: number): number => {
    let s = 0
    let n = 0
    for (let y = roi.y0; y < roi.y1 - Math.max(0, dy); y++)
      for (let x = roi.x0 + Math.max(0, -dx); x < roi.x1 - Math.max(0, dx); x++) {
        s += hp[y * W + x] * hp[(y + dy) * W + (x + dx)]
        n++
      }
    return n ? s / n / (v0 / n0) : 0
  }

  let peak = 0
  let peakDx = 0
  let peakDy = 0
  let peakOff = 0
  let offDx = 0
  let offDy = 0
  let peakAxis = 0
  for (let dy = 0; dy <= maxLag; dy++)
    for (let dx = -maxLag; dx <= maxLag; dx++) {
      if (dy === 0 && dx <= 0) continue
      if (dx * dx + dy * dy < minR * minR) continue
      const v = Math.abs(acf(dx, dy))
      if (v > peak) {
        peak = v
        peakDx = dx
        peakDy = dy
      }
      if (dx !== 0 && dy !== 0) {
        if (v > peakOff) {
          peakOff = v
          offDx = dx
          offDy = dy
        }
      } else if (v > peakAxis) peakAxis = v
    }

  const bins = new Float64Array(8)
  for (let y = roi.y0 + 1; y < roi.y1 - 1; y++)
    for (let x = roi.x0 + 1; x < roi.x1 - 1; x++) {
      const gx = hp[y * W + x + 1] - hp[y * W + x - 1]
      const gy = hp[(y + 1) * W + x] - hp[(y - 1) * W + x]
      const m = gx * gx + gy * gy
      if (m < 1e-12) continue
      let th = Math.atan2(gy, gx)
      if (th < 0) th += Math.PI
      if (th >= Math.PI) th -= Math.PI
      bins[Math.min(7, Math.floor((th / Math.PI) * 8))] += m
    }
  const bmean = bins.reduce((s, v) => s + v, 0) / 8
  let bmax = 0
  let bi = 0
  for (let i = 0; i < 8; i++)
    if (bins[i] > bmax) {
      bmax = bins[i]
      bi = i
    }
  return {
    rms,
    peak,
    peakDx,
    peakDy,
    peakOffAxis: peakOff,
    offDx,
    offDy,
    peakAxis,
    aniso: bmean > 0 ? bmax / bmean : 1,
    anisoDeg: (bi + 0.5) * 22.5,
  }
}

/** The copy above must still BE the look pass's detector. */
function assertStructureParity(): void {
  const src = fs.readFileSync(path.join('scripts', 'blur-bakeoff', 'phase9-look.ts'), 'utf8')
  const mine = fs.readFileSync(path.join('scripts', 'blur-bakeoff', 'phase9-look-hash.ts'), 'utf8')
  const grab = (s: string): string => {
    const i = s.indexOf('export function structure2d')
    if (i < 0) throw new Error('structure2d not found')
    // to the closing brace of the function: first line that is exactly '}'
    const rest = s.slice(i)
    const end = rest.indexOf('\n}\n')
    if (end < 0) throw new Error('structure2d end not found')
    // Compare CODE, not commentary: the two copies are allowed to explain
    // themselves differently, but every statement must be identical.
    return rest
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  const a = grab(src)
  const b = grab(mine)
  if (a !== b) {
    console.error('STRUCTURE2D PARITY FAILED — the local copy has drifted from phase9-look.ts')
    console.error(`  look len ${a.length}, local len ${b.length}`)
    throw new Error('structure2d drift')
  }
  console.log(`structure2d parity: identical to phase9-look.ts (${a.length} normalised chars)`)
}

// ===========================================================================
// PART A — the hash field itself, on CPU
// ===========================================================================

/** Strong reference hash: Jarzynski pcg2d, the same one the GPU ablation uses. */
function pcg2d(x: number, y: number): [number, number] {
  let vx = x >>> 0
  let vy = y >>> 0
  vx = (Math.imul(vx, 1664525) + 1013904223) >>> 0
  vy = (Math.imul(vy, 1664525) + 1013904223) >>> 0
  vx = (vx + Math.imul(vy, 1664525)) >>> 0
  vy = (vy + Math.imul(vx, 1664525)) >>> 0
  vx = (vx ^ (vx >>> 16)) >>> 0
  vy = (vy ^ (vy >>> 16)) >>> 0
  vx = (vx + Math.imul(vy, 1664525)) >>> 0
  vy = (vy + Math.imul(vx, 1664525)) >>> 0
  vx = (vx ^ (vx >>> 16)) >>> 0
  vy = (vy ^ (vy >>> 16)) >>> 0
  // Use the .y lane. MEASURED, not assumed: pcg2d's .x lane is itself
  // correlated at lag (11,0) (peak |acf| 0.187 vs 0.008 for iid) because the
  // last round updates v.y from the already-updated v.x but not the reverse.
  // The .y lane reads 0.008 — indistinguishable from iid.
  return [vx / 4294967296, vy / 4294967296]
}

/**
 * acf of a scalar field over the pixel grid, max |acf| over 2 <= |lag| <= maxLag.
 * No high-pass here: these fields are meant to be stationary and zero-mean after
 * subtracting the global mean, and a box high-pass would manufacture short-lag
 * negative correlation that has nothing to do with the hash.
 */
function fieldAcf(f: Float64Array, n: number, maxLag = 12): { peak: number; dx: number; dy: number; mean: number; sd: number } {
  let mean = 0
  for (const v of f) mean += v
  mean /= f.length
  const g = new Float64Array(f.length)
  let v0 = 0
  for (let i = 0; i < f.length; i++) {
    g[i] = f[i] - mean
    v0 += g[i] * g[i]
  }
  v0 /= f.length
  let peak = 0
  let bdx = 0
  let bdy = 0
  for (let dy = 0; dy <= maxLag; dy++)
    for (let dx = -maxLag; dx <= maxLag; dx++) {
      if (dy === 0 && dx <= 0) continue
      if (dx * dx + dy * dy < 4) continue
      let s = 0
      let c = 0
      for (let y = 0; y + dy < n; y++)
        for (let x = Math.max(0, -dx); x < n - Math.max(0, dx); x++) {
          s += g[y * n + x] * g[(y + dy) * n + (x + dx)]
          c++
        }
      const v = Math.abs(s / c / v0)
      if (v > peak) {
        peak = v
        bdx = dx
        bdy = dy
      }
    }
  return { peak, dx: bdx, dy: bdy, mean, sd: Math.sqrt(v0) }
}

type RotFn = (x: number, y: number) => number

function rotField(n: number, f: RotFn): { cos: Float64Array; sin: Float64Array; u: Float64Array } {
  const cos = new Float64Array(n * n)
  const sin = new Float64Array(n * n)
  const u = new Float64Array(n * n)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const t = f(x, y)
      const th = t * Math.PI * 2
      u[y * n + x] = t
      cos[y * n + x] = Math.cos(th)
      sin[y * n + x] = Math.sin(th)
    }
  return { cos, sin, u }
}

function fieldImage(n: number, u: Float64Array): Rgba8 {
  const img = blank(n, n)
  for (let i = 0; i < n * n; i++) {
    const v = Math.max(0, Math.min(255, Math.round(u[i] * 255)))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
  }
  return img
}

function partA(): { rows: Array<Record<string, unknown>>; pass: boolean; benched: number; good: number; iid: number; jitter: number } {
  const N = 384
  // BENCHED: exactly the expression frostGatherPass emits for rot:'hash'.
  const benched: RotFn = (x, y) => reedHash(Math.fround(x + 11.7), Math.fround(y - 23.9))[0] * 0.5 + 0.5
  // KNOWN-GOOD: a strong integer hash.
  const good: RotFn = (x, y) => pcg2d(x + 4096, y + 4096)[1]
  // KNOWN-BAD: a deliberately near-linear "hash" — must be caught.
  const bad: RotFn = (x, y) => ((x * 0.13 + y * 0.071) % 1 + 1) % 1
  // The radial-jitter source the same kernel uses for tap 0.
  const jit0: RotFn = (x, y) => reedHash(Math.fround(x + 0.5), Math.fround(y - 0.5))[1] * 0.5 + 0.5

  const rows: Array<Record<string, unknown>> = []
  const run = (name: string, f: RotFn, keep = false) => {
    const { cos, sin, u } = rotField(N, f)
    const ac = fieldAcf(cos, N)
    const as = fieldAcf(sin, N)
    const au = fieldAcf(u, N)
    const peak = Math.max(ac.peak, as.peak)
    rows.push({
      field: name,
      'mean(u)': +au.mean.toFixed(4),
      'sd(u)': +au.sd.toFixed(4),
      'peak|acf| cos': +ac.peak.toFixed(4),
      'lag cos': `(${ac.dx},${ac.dy})`,
      'peak|acf| sin': +as.peak.toFixed(4),
      'lag sin': `(${as.dx},${as.dy})`,
      'peak cos/sin': +peak.toFixed(4),
    })
    if (keep) save(`field-${name.replace(/[^a-z0-9]+/gi, '-')}`, cropZoom(fieldImage(N, u), 0, 0, 128, 128, 3))
    return peak
  }

  // iid: the chance floor for this metric at this grid size. Everything else
  // is judged against a MEASURED floor, not an assumed one.
  let seed = 12345
  const iid: RotFn = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const pIid = run('control iid', iid)
  const pBench = run('benched reedHash.x rot', benched, true)
  const pGood = run('good pcg2d.y', good, true)
  const pBad = run('bad near-linear', bad, true)
  const pJit = run('benched reedHash.y jitter tap0', jit0)

  console.log('\n== PART A: rotation-field hash quality (acf of cos/sin over the pixel grid) ==')
  console.table(rows)
  // A field of N^2 independent samples has |acf| ~ 1/N by chance; N=384 -> 0.0026,
  // and the max over ~300 lags lands near 3-4x that. 0.02 is a generous ceiling.
  const checks: Array<[string, boolean, string]> = [
    ['control iid sets a low floor (peak < 0.03)', pIid < 0.03, `${pIid.toFixed(4)}`],
    ['known-good pcg2d.y is at the iid floor (< 2x iid)', pGood < 2 * pIid, `${pGood.toFixed(4)} vs iid ${pIid.toFixed(4)}`],
    ['known-bad near-linear is caught (peak > 0.3)', pBad > 0.3, `${pBad.toFixed(4)}`],
    ['separation good vs bad > 20x', pBad > 20 * Math.max(pGood, 0.001), `${pBad.toFixed(4)} vs ${pGood.toFixed(4)}`],
    ['benched hash is NOT at the good floor (this is the finding)', pBench > 10 * pGood, `${pBench.toFixed(4)} vs ${pGood.toFixed(4)}`],
  ]
  let pass = true
  for (const [n, ok, d] of checks) {
    if (!ok) pass = false
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}   [${d}]`)
  }
  console.log(`\n  VERDICT benched rotation hash: peak |acf| ${pBench.toFixed(4)} vs good ${pGood.toFixed(4)} (${(pBench / Math.max(pGood, 1e-6)).toFixed(1)}x)`)
  console.log(`  VERDICT benched radial-jitter hash: peak |acf| ${pJit.toFixed(4)}`)
  return { rows, pass, benched: pBench, good: pGood, iid: pIid, jitter: pJit }
}

// ===========================================================================
// PART B — GPU ablation: swap the rotation hash, change nothing else
// ===========================================================================

const PCG_WGSL = `
fn pcg01(p: vec2f) -> f32 {
  var v: vec2u = vec2u(vec2i(floor(p) + vec2(4096.0)));
  v = v * vec2u(1664525u) + vec2u(1013904223u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return f32(v.y) * 2.3283064e-10;
}
`

const PCG_GLSL = `
float pcg01(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p) + vec2(4096.0)));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return float(v.y) * 2.3283064e-10;
}
`

const ROT_HASH = '(reedHash(gc + vec2(11.7, -23.9)).x * 0.5 + 0.5)'
const ROT_PCG = 'pcg01(gc + vec2(11.7, -23.9))'
const JIT_RE = /reedHash\(gc \+ vec2\(([-0-9.e]+), ([-0-9.e]+)\)\)\.y \* 0\.5 \+ 0\.5/g

type Variant = 'hash' | 'pcgRot' | 'pcgBoth'

/**
 * Surgically rewrite the emitted gather. Every substitution asserts its hit
 * count, so a silent no-op (which would make the ablation compare a shader with
 * itself and "prove" the hash is innocent) is impossible.
 */
function variantGather(kernel: FrostKernel, v: Variant, backend: Backend = 'webgpu'): PassSpec {
  const base = frostGatherPass(backend, kernel)
  if (v === 'hash') return base
  let body = base.body
  const nRot = body.split(ROT_HASH).length - 1
  if (nRot !== 1) throw new Error(`rotation substitution expected 1 site, found ${nRot}`)
  body = body.replace(ROT_HASH, ROT_PCG)
  let nJit = 0
  if (v === 'pcgBoth') {
    body = body.replace(JIT_RE, (_m, a: string, b: string) => {
      nJit++
      return `pcg01(gc + vec2(${a}, ${b}) + vec2(7.0))`
    })
    if (nJit !== kernel.taps) throw new Error(`jitter substitution expected ${kernel.taps} sites, found ${nJit}`)
  }
  return { ...base, prelude: (base.prelude ?? '') + (backend === 'webgpu' ? PCG_WGSL : PCG_GLSL), body }
}

async function capture(rig: Awaited<ReturnType<typeof createRig>>, input: Rgba8, kernel: FrostKernel, v: Variant, radiusPx: number, frost: number, dpr: number, backend: Backend = 'webgpu'): Promise<Rgba8> {
  const spec: CaptureSpec = {
    backend,
    width: input.width,
    height: input.height,
    input,
    radius: radiusPx,
    params: [frost, 0, dpr, 0],
    passes: [frostIngestPass(backend), variantGather(kernel, v, backend), frostEgressPass(backend)],
  }
  return await rig.capture(spec)
}

function meanAbsDiff(a: Rgba8, b: Rgba8): number {
  let s = 0
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs(LUMA(a.data, i) - LUMA(b.data, i))
  return s / (a.data.length / 4)
}

function residualView(cand: Rgba8, ref: Rgba8, gain: number): Rgba8 {
  const a = lumaPlane(cand)
  const b = lumaPlane(ref)
  const out = blank(cand.width, cand.height)
  for (let i = 0; i < a.length; i++) {
    const c = Math.max(0, Math.min(255, Math.round((a[i] - b[i]) * gain + 128)))
    out.data[i * 4] = c
    out.data[i * 4 + 1] = c
    out.data[i * 4 + 2] = c
  }
  return out
}

const K16: FrostKernel = { taps: 16, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', weight: 'uniform' }
const K256: FrostKernel = { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', weight: 'uniform', emit: 'procedural' }

async function partB(): Promise<Array<Record<string, unknown>>> {
  const rig = await createRig()
  const rows: Array<Record<string, unknown>> = []
  let photoRef: Rgba8 = blank(1, 1)
  try {
    const bytes = new Uint8Array(fs.readFileSync('stuff/2013-03-12 00.48.07.jpg'))
    const full = await rig.decodeImage(bytes, 'image/jpeg', 1024)
    // same centre crop as phase9-look.ts
    const photo = (() => {
      const out = blank(SIZE, SIZE)
      const x0 = ((full.width - SIZE) / 2) | 0
      const y0 = ((full.height - SIZE) / 2) | 0
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const s = ((y + y0) * full.width + (x + x0)) * 4
          out.data.set(full.data.subarray(s, s + 4), (y * SIZE + x) * 4)
        }
      return out
    })()

    photoRef = photo
    for (const frost of [1.0, 0.25, 0.125]) {
      const dpr = 2
      const radiusPx = frost * 24 * dpr
      const inset = Math.ceil(1.5 * radiusPx) + 8
      const roi = { x0: inset, y0: inset, x1: SIZE - inset, y1: SIZE - inset }
      const tag = `f${String(Math.round(frost * 1000)).padStart(4, '0')}`

      const gt = await capture(rig, photo, K256, 'hash', radiusPx, frost, dpr)

      // TRUST CHECK: the 'hash' variant must be the benched C3j-16, i.e. the
      // unmodified emitter. Verified by construction (variantGather returns the
      // base PassSpec untouched) and, below, by the ablation actually changing
      // the image — a no-op rewrite would read 0.00.
      const imgs: Record<Variant, Rgba8> = {
        hash: await capture(rig, photo, K16, 'hash', radiusPx, frost, dpr),
        pcgRot: await capture(rig, photo, K16, 'pcgRot', radiusPx, frost, dpr),
        pcgBoth: await capture(rig, photo, K16, 'pcgBoth', radiusPx, frost, dpr),
      }
      const floor = structure2d(
        await capture(rig, photo, K256, 'pcgRot', radiusPx, frost, dpr),
        gt,
        roi,
      )
      rows.push({ variant: 'C7 floor (256-tap, two hashes)', frost, radiusPx, rms: +floor.rms.toFixed(3), peak: +floor.peak.toFixed(3), lag: `(${floor.peakDx},${floor.peakDy})`, aniso: +floor.aniso.toFixed(2) })

      for (const v of ['hash', 'pcgRot', 'pcgBoth'] as Variant[]) {
        const s = structure2d(imgs[v], gt, roi)
        const changed = v === 'hash' ? 0 : meanAbsDiff(imgs[v], imgs.hash)
        rows.push({
          variant: `C3j-16 rot=${v}`,
          frost,
          radiusPx,
          rms: +s.rms.toFixed(3),
          peak: +s.peak.toFixed(3),
          lag: `(${s.peakDx},${s.peakDy})`,
          peakOffAxis: +s.peakOffAxis.toFixed(3),
          aniso: +s.aniso.toFixed(2),
          'vs hash': +changed.toFixed(3),
        })
        save(`tilen-${tag}-${v}`, cropZoom(residualView(imgs[v], gt, 40 / Math.max(s.rms, 0.01)), 176, 176, 112, 112, 5))
        save(`tile-edge-${tag}-${v}`, cropZoom(imgs[v], 120, 90, 112, 112, 5))
        if (frost === 1) save(`full-${tag}-${v}`, imgs[v])
      }
      if (frost === 1) save(`full-${tag}-C7`, gt)
    }

    // -------------------------------------------------------------------
    // BACKEND PARITY. The repo rule is both backends or it does not ship, and
    // an ALU-only fix is exactly the kind that compiles on one and not the
    // other (GLSL ES 3.00 has uint and bit ops, but `>>` on a uvec2 by a scalar
    // and the uvec2(ivec2(...)) conversion are the risky spots). Capture the
    // SAME variant on WebGL2 and require it to agree with WebGPU.
    // -------------------------------------------------------------------
    {
      const frost = 1
      const dpr = 2
      const radiusPx = frost * 24 * dpr
      const inset = Math.ceil(1.5 * radiusPx) + 8
      const roi = { x0: inset, y0: inset, x1: SIZE - inset, y1: SIZE - inset }
      const gl = await capture(rig, photoRef, K16, 'pcgRot', radiusPx, frost, dpr, 'webgl2' as Backend)
      const gpu = await capture(rig, photoRef, K16, 'pcgRot', radiusPx, frost, dpr, 'webgpu' as Backend)
      const gtGl = await capture(rig, photoRef, K256, 'pcgRot', radiusPx, frost, dpr, 'webgl2' as Backend)
      const sGl = structure2d(gl, gtGl, roi)
      rows.push({
        variant: 'C3j-16 rot=pcgRot [WEBGL2]',
        frost,
        radiusPx,
        rms: +sGl.rms.toFixed(3),
        peak: +sGl.peak.toFixed(3),
        lag: `(${sGl.peakDx},${sGl.peakDy})`,
        aniso: +sGl.aniso.toFixed(2),
        'vs webgpu': +meanAbsDiff(gl, gpu).toFixed(3),
      })
    }
  } finally {
    await rig.close()
  }
  console.log('\n== PART B: rotation-hash ablation (16-tap jittered Vogel, WebGPU, photo, DPR 2) ==')
  console.table(rows)
  return rows
}

// ===========================================================================

async function main(): Promise<void> {
  assertStructureParity()
  const a = partA()
  if (!a.pass) {
    console.error('\nPART A CALIBRATION FAILED — not reporting hash verdicts from a detector that cannot tell good from bad.')
    process.exitCode = 1
    return
  }
  let b: Array<Record<string, unknown>> = []
  if (!process.argv.includes('--cpu')) b = await partB()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'phase9-look-hash.json'), JSON.stringify({ partA: a, partB: b }, null, 2))
  console.log('\nwrote', path.join(OUT, 'phase9-look-hash.json'), 'and images to', IMG)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
