/**
 * Phase 9 — ADVERSARIAL LOOK LENS.
 *
 * The sweep decided on numbers. This decides on appearance, and it exists to
 * attack the conclusion, not confirm it. Three things the numeric sweep cannot
 * do:
 *
 *  1. It only ever rendered frost = 1.0 (--quick). The brief calls the subtle
 *     end a separate failure regime. Nothing at frost 0.125/0.25 was ever
 *     LOOKED at. This captures it.
 *  2. Its one zoom window is (200,200)+96 on the photo — a near-black region
 *     where 8-bit quantisation crushes exactly the texture under test. This
 *     adds a bright smooth window and a boundary window.
 *  3. Its blockiness detectors are AXIS-ALIGNED (acf at lag (d,0)/(0,d),
 *     column-difference period spectrum). A DIAGONAL weave is invisible to
 *     both. This scans the full 2-D residual autocorrelation.
 *
 * The decisive image is the RESIDUAL VIEW: (candidate - C7) luma, gained and
 * biased to mid-grey. It removes the picture and leaves only the texture the
 * candidate adds over the converged disc, which is the thing being judged.
 *
 *   npx tsx scripts/blur-bakeoff/phase9-look.ts            # full, ~6 min
 *   npx tsx scripts/blur-bakeoff/phase9-look.ts --calib    # detector calibration only, no GPU
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend } from './lib/gpu-rig'
import { captureFrost, type Candidate } from './lib/frost-bench'
import { encodePng } from './lib/png'
import type { Rgba8 } from './lib/image'

// NOTE: phase9-frost.ts runs runValidate() at module scope, so importing
// CANDIDATES from it would fire a 50 s GPU validation on every run of this
// script. The definitions below are copied verbatim from its CANDIDATES table;
// assertCandidateParity() below diffs them against that file's source text on
// every run, so a drift cannot go unnoticed.
function sunflower(id: string, taps: number, opts: Partial<Candidate['kernel']> & { note?: string }): Candidate {
  const { note, ...k } = opts
  return { id, label: id, note: note ?? '', kernel: { taps, pattern: 'sunflower', seed: 'pixel', rot: 'hash', weight: 'uniform', ...k } }
}

const CANDIDATES: Candidate[] = [
  { id: 'C0', label: 'C0', note: '', kernel: { taps: 8, pattern: 'squareHash', seed: 'lattice' } },
  { id: 'C1', label: 'C1', note: '', kernel: { taps: 8, pattern: 'squareHash', seed: 'pixel' } },
  { id: 'C2', label: 'C2', note: '', kernel: { taps: 8, pattern: 'discHash', seed: 'pixel' } },
  sunflower('C3-8', 8, {}),
  sunflower('C3-16', 16, {}),
  sunflower('C3-24', 24, {}),
  sunflower('C3j-8', 8, { pattern: 'sunflowerJit' }),
  sunflower('C3j-16', 16, { pattern: 'sunflowerJit' }),
  sunflower('C3j-24', 24, { pattern: 'sunflowerJit' }),
  sunflower('C4-16', 16, { weight: 'gauss', gaussK: 2 }),
  sunflower('C4j-16', 16, { pattern: 'sunflowerJit', weight: 'gauss', gaussK: 2 }),
  sunflower('C5-16', 16, { rot: 'ign' }),
  sunflower('C5j-16', 16, { pattern: 'sunflowerJit', rot: 'ign' }),
  sunflower('C5f-16', 16, { pattern: 'sunflowerJit', rot: 'ignCss', seed: 'cssPixel' }),
  { id: 'C6', label: 'C6', note: '', kernel: { taps: 4, pattern: 'discHash', seed: 'pixel' }, pyramidDepth: 3, radiusScale: 0.6 },
  { id: 'C7', label: 'C7', note: '', kernel: { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', emit: 'procedural' }, groundTruth: true },
  { id: 'GTg', label: 'GTg', note: '', kernel: { taps: 256, pattern: 'sunflowerJit', seed: 'pixel', rot: 'hash', weight: 'gauss', gaussK: 2, emit: 'procedural' }, groundTruth: true },
]

const OUT = path.join('reports', 'blur-bakeoff', 'phase9')
const IMG = path.join(OUT, 'look')
const SIZE = 512

/**
 * The copied table above must still describe the same kernels as the sweep's.
 * Re-derive each candidate's defining tokens from phase9-frost.ts source text
 * and compare. A silent drift here would make every look verdict apply to a
 * shader the sweep never scored.
 */
function assertCandidateParity(): void {
  const src = fs.readFileSync(path.join('scripts', 'blur-bakeoff', 'phase9-frost.ts'), 'utf8')
  const body = src.slice(src.indexOf('export const CANDIDATES'))
  // Entry boundaries: every candidate starts either `id: 'X',` or `sunflower('X',`.
  const starts = [...body.matchAll(/(?:id: |sunflower\()'([A-Za-z0-9-]+)'/g)].map((m) => ({ id: m[1], at: m.index! }))
  const problems: string[] = []
  for (const c of CANDIDATES) {
    const k = starts.findIndex((s) => s.id === c.id)
    if (k < 0) {
      problems.push(`${c.id}: not found in phase9-frost.ts`)
      continue
    }
    const line = body.slice(starts[k].at, k + 1 < starts.length ? starts[k + 1].at : starts[k].at + 900)
    // sunflower(...) inherits pattern/seed/rot defaults from its helper; only
    // explicit overrides appear in the entry, so check overrides in both
    // directions rather than the resolved value.
    const isSun = body.startsWith('sunflower(', starts[k].at)
    const want: Array<[string, string | undefined, string]> = [
      ['pattern', isSun && c.kernel.pattern === 'sunflower' ? undefined : c.kernel.pattern, `pattern: '${c.kernel.pattern}'`],
      ['seed', isSun && c.kernel.seed === 'pixel' ? undefined : c.kernel.seed, `seed: '${c.kernel.seed}'`],
      ['rot', isSun && (c.kernel.rot ?? 'hash') === 'hash' ? undefined : c.kernel.rot, `rot: '${c.kernel.rot}'`],
      ['weight', isSun && (c.kernel.weight ?? 'uniform') === 'uniform' ? undefined : c.kernel.weight, `weight: '${c.kernel.weight}'`],
    ]
    for (const [k, active, token] of want) {
      if (active === undefined) {
        if (line.includes(`${k}:`)) problems.push(`${c.id}: sweep sets ${k} explicitly, local copy relies on the default`)
      } else if (!line.includes(token)) problems.push(`${c.id}: expected ${token} in sweep source, line was: ${line.trim()}`)
    }
    if (!new RegExp(`taps: ${c.kernel.taps}\\b|'${c.id}', ${c.kernel.taps},`).test(line))
      problems.push(`${c.id}: tap count ${c.kernel.taps} not confirmed by sweep source`)
  }
  if (problems.length) {
    console.error('CANDIDATE PARITY FAILED:\n  ' + problems.join('\n  '))
    throw new Error('local candidate table has drifted from phase9-frost.ts')
  }
  console.log(`candidate parity: ${CANDIDATES.length}/${CANDIDATES.length} match phase9-frost.ts source`)
}

// ===========================================================================
// image utilities
// ===========================================================================

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

function centerCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const cw = Math.min(w, img.width)
  const ch = Math.min(h, img.height)
  const x0 = ((img.width - cw) / 2) | 0
  const y0 = ((img.height - ch) / 2) | 0
  const out = blank(cw, ch)
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const s = ((y + y0) * img.width + (x + x0)) * 4
      const d = (y * cw + x) * 4
      out.data.set(img.data.subarray(s, s + 4), d)
    }
  return out
}

function cropZoom(img: Rgba8, x0: number, y0: number, w: number, h: number, z: number): Rgba8 {
  const out = blank(w * z, h * z)
  for (let y = 0; y < h * z; y++)
    for (let x = 0; x < w * z; x++) {
      const sx = Math.min(img.width - 1, x0 + ((x / z) | 0))
      const sy = Math.min(img.height - 1, y0 + ((y / z) | 0))
      const s = (sy * img.width + sx) * 4
      const d = (y * out.width + x) * 4
      out.data.set(img.data.subarray(s, s + 4), d)
    }
  return out
}

/** Horizontal montage with a 4px separator. */
function montageH(imgs: Rgba8[], gap = 4): Rgba8 {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length - 1)
  const out = blank(w, h, 20)
  let x = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++)
      for (let xx = 0; xx < im.width; xx++) {
        const s = (y * im.width + xx) * 4
        const d = (y * w + x + xx) * 4
        out.data.set(im.data.subarray(s, s + 4), d)
      }
    x += im.width + gap
  }
  return out
}

function _montageV(imgs: Rgba8[], gap = 4): Rgba8 {
  const w = Math.max(...imgs.map((i) => i.width))
  const h = imgs.reduce((s, i) => s + i.height, 0) + gap * (imgs.length - 1)
  const out = blank(w, h, 20)
  let y = 0
  for (const im of imgs) {
    for (let yy = 0; yy < im.height; yy++)
      for (let x = 0; x < im.width; x++) {
        const s = (yy * im.width + x) * 4
        const d = ((y + yy) * w + x) * 4
        out.data.set(im.data.subarray(s, s + 4), d)
      }
    y += im.height + gap
  }
  return out
}

const LUMA = (d: Uint8ClampedArray, p: number) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]

/** Float luma plane of an sRGB8 image (units: 8-bit codes). */
function lumaPlane(img: Rgba8): Float64Array {
  const out = new Float64Array(img.width * img.height)
  for (let i = 0; i < out.length; i++) out[i] = LUMA(img.data, i * 4)
  return out
}

/**
 * Residual view: (cand - ref) luma * gain + 128, as a grey image. This is the
 * texture the candidate adds over the converged reference, with the picture
 * removed. Reports the clip fraction so an over-gained (therefore lying) view
 * is never read as structure.
 */
function residualView(cand: Rgba8, ref: Rgba8, gain: number): { img: Rgba8; clip: number; rms: number } {
  const a = lumaPlane(cand)
  const b = lumaPlane(ref)
  const out = blank(cand.width, cand.height)
  let clip = 0
  let ss = 0
  for (let i = 0; i < a.length; i++) {
    const r = a[i] - b[i]
    ss += r * r
    const v = r * gain + 128
    if (v < 0 || v > 255) clip++
    const c = Math.max(0, Math.min(255, Math.round(v)))
    out.data[i * 4] = c
    out.data[i * 4 + 1] = c
    out.data[i * 4 + 2] = c
  }
  return { img: out, clip: clip / a.length, rms: Math.sqrt(ss / a.length) }
}

// ===========================================================================
// 2-D structure scan — the detector the sweep does not have
// ===========================================================================

export interface Structure2d {
  /** RMS of the high-passed residual, 8-bit codes. */
  rms: number
  /** Largest |acf| at any lag with |lag| >= minR, and where it is. */
  peak: number
  peakDx: number
  peakDy: number
  /** Largest |acf| restricted to OFF-AXIS lags (dx != 0 && dy != 0). */
  peakOffAxis: number
  offDx: number
  offDy: number
  /** Largest |acf| restricted to AXIS lags. The sweep can only see this one. */
  peakAxis: number
  /**
   * Angular anisotropy of the residual power: max/mean of energy binned into 8
   * orientations of the local gradient. 1.0 = isotropic.
   */
  aniso: number
  anisoDeg: number
}

/**
 * Full 2-D autocorrelation of a high-passed residual plane.
 *
 * High-pass first (subtract a box mean of 2*maxLag+1) for the same reason the
 * sweep's residualAcf does: a smooth systematic bias between two rendering
 * routes would otherwise dominate every lag.
 */
export function structure2d(cand: Rgba8, ref: Rgba8, roi: { x0: number; y0: number; x1: number; y1: number }, maxLag = 12, minR = 2): Structure2d {
  const W = cand.width
  const a = lumaPlane(cand)
  const b = lumaPlane(ref)
  const r = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) r[i] = a[i] - b[i]

  // box high-pass
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

  // variance
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

  // orientation energy of the high-passed residual: project the local gradient
  // into 8 orientation bins (period pi), then max/mean.
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

// ===========================================================================
// CALIBRATION — every number above must pass a known-good and fail a known-bad
// ===========================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Band-limited isotropic random field: white noise convolved with a circular
 * Gaussian, rescaled to a usable contrast around mid-grey. Stationary and
 * orientation-free (a circular Gaussian has no preferred direction), but with
 * a correlation length of a few pixels, so a gather that shares tap offsets
 * across a neighbourhood still produces correlated outputs there.
 */
function isoSmoothField(n: number, seed: number, sigma: number): Rgba8 {
  const rnd = mulberry32(seed)
  const a = new Float64Array(n * n)
  for (let i = 0; i < a.length; i++) a[i] = rnd() - 0.5
  const rad = Math.ceil(3 * sigma)
  const k = new Float64Array(2 * rad + 1)
  let ks = 0
  for (let i = -rad; i <= rad; i++) {
    k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma))
    ks += k[i + rad]
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks
  const t = new Float64Array(n * n)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0
      for (let i = -rad; i <= rad; i++) s += k[i + rad] * a[y * n + Math.min(n - 1, Math.max(0, x + i))]
      t[y * n + x] = s
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let s = 0
      for (let i = -rad; i <= rad; i++) s += k[i + rad] * t[Math.min(n - 1, Math.max(0, y + i)) * n + x]
      a[y * n + x] = s
    }
  let mn = Infinity
  let mx = -Infinity
  for (const v of a) {
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const img = blank(n, n)
  for (let i = 0; i < a.length; i++) {
    const v = Math.round(40 + 175 * ((a[i] - mn) / (mx - mn)))
    img.data[i * 4] = v
    img.data[i * 4 + 1] = v
    img.data[i * 4 + 2] = v
  }
  return img
}

function synth(w: number, h: number, f: (x: number, y: number) => number): Rgba8 {
  const img = blank(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y))))
      const p = (y * w + x) * 4
      img.data[p] = v
      img.data[p + 1] = v
      img.data[p + 2] = v
    }
  return img
}

function calibrate(): { rows: Array<Record<string, unknown>>; pass: boolean } {
  const W = 256
  const roi = { x0: 16, y0: 16, x1: W - 16, y1: W - 16 }
  const rnd = mulberry32(7)
  // A smooth "converged" base both members of every pair share.
  const base = synth(W, W, (x, y) => 128 + 40 * Math.sin(x / 37) * Math.cos(y / 51))

  const rows: Array<Record<string, unknown>> = []
  const add = (name: string, img: Rgba8) => {
    const s = structure2d(img, base, roi)
    rows.push({
      case: name,
      rms: +s.rms.toFixed(3),
      peak: +s.peak.toFixed(3),
      peakLag: `(${s.peakDx},${s.peakDy})`,
      peakOffAxis: +s.peakOffAxis.toFixed(3),
      offLag: `(${s.offDx},${s.offDy})`,
      peakAxis: +s.peakAxis.toFixed(3),
      aniso: +s.aniso.toFixed(2),
      anisoDeg: s.anisoDeg,
    })
    return s
  }

  // KNOWN-GOOD 1: base + iid noise (what a converged stochastic estimator's
  // residual actually is). Must show no lag structure and no orientation.
  const good = add(
    'good: iid noise 6 codes',
    synth(W, W, (x, y) => {
      const p = (y * W + x) * 4
      return LUMA(base.data, p) + (rnd() - 0.5) * 12
    }),
  )
  // KNOWN-GOOD 2: identical. Degenerate guard.
  const same = add('good: identical', base)

  // KNOWN-BAD 1: 8px block quantisation (the shipped lattice's signature).
  // Axis peak at lag 8, and the axis-only detector CAN see this one.
  const bq = synth(W, W, (x, y) => {
    const bx = (x >> 3) << 3
    const by = (y >> 3) << 3
    const p = (by * W + bx) * 4
    const q = (Math.floor(bx / 8) * 7919 + Math.floor(by / 8) * 104729) % 1000
    return LUMA(base.data, p) + (q / 1000 - 0.5) * 14
  })
  const bad1 = add('bad: 8px block quant', bq)

  // KNOWN-BAD 2: DIAGONAL weave at 45 deg, period ~3px. Exactly the artefact an
  // axis-aligned detector is blind to.
  const bad2 = add(
    'bad: 45deg weave p3',
    synth(W, W, (x, y) => {
      const p = (y * W + x) * 4
      return LUMA(base.data, p) + 5 * Math.cos((2 * Math.PI * (x + y)) / 3)
    }),
  )
  // KNOWN-BAD 3: directional (horizontal-only) streaking. Orientation gate.
  const bad3 = add(
    'bad: horizontal streak',
    synth(W, W, (x, y) => {
      const p = (y * W + x) * 4
      return LUMA(base.data, p) + 6 * Math.cos((2 * Math.PI * y) / 4)
    }),
  )

  const checks: Array<[string, boolean, string]> = [
    ['good iid: peak < 0.15', good.peak < 0.15, `peak ${good.peak.toFixed(3)}`],
    ['good iid: aniso < 1.6', good.aniso < 1.6, `aniso ${good.aniso.toFixed(2)}`],
    ['good identical: rms 0, no NaN', same.rms === 0 && Number.isFinite(same.peak), `rms ${same.rms}`],
    ['bad block: peakAxis > 0.4', bad1.peakAxis > 0.4, `peakAxis ${bad1.peakAxis.toFixed(3)}`],
    ['bad 45deg weave: peakOffAxis > 0.5', bad2.peakOffAxis > 0.5, `off ${bad2.peakOffAxis.toFixed(3)} at (${bad2.offDx},${bad2.offDy})`],
    ['bad 45deg weave: aniso > 2', bad2.aniso > 2, `aniso ${bad2.aniso.toFixed(2)} @ ${bad2.anisoDeg}deg`],
    ['bad streak: aniso > 2', bad3.aniso > 2, `aniso ${bad3.aniso.toFixed(2)} @ ${bad3.anisoDeg}deg`],
    ['separation: bad45 off-axis >> good off-axis', bad2.peakOffAxis > 4 * Math.max(good.peakOffAxis, 0.02), `${bad2.peakOffAxis.toFixed(3)} vs ${good.peakOffAxis.toFixed(3)}`],
  ]
  let pass = true
  console.log('\n== structure2d calibration ==')
  console.table(rows)
  for (const [n, ok, d] of checks) {
    if (!ok) pass = false
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}   [${d}]`)
  }
  return { rows, pass }
}

// ===========================================================================
// main
// ===========================================================================

const CANDS = ['C0', 'C1', 'C2', 'C3-16', 'C3j-8', 'C3j-16', 'C3j-24', 'C5j-16', 'C4j-16', 'C6']
const FROSTS = [0.125, 0.25, 1.0]
const DPRS = [2, 1]

// windows chosen on the photo: bright+smooth, boundary, and the sweep's own
// near-black window (kept for comparability).
const WINDOWS: Array<[string, number, number]> = [
  ['bright', 384, 24],
  ['edge', 120, 90],
  ['dark', 200, 200],
]
const WIN = 96

async function main(): Promise<void> {
  assertCandidateParity()
  const calib = calibrate()
  if (process.argv.includes('--calib')) {
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, 'phase9-look.json'), JSON.stringify({ calibration: calib }, null, 2))
    if (!calib.pass) process.exitCode = 1
    return
  }
  if (!calib.pass) {
    console.error('\nCALIBRATION FAILED — refusing to report look numbers from a detector that cannot tell good from bad.')
    process.exitCode = 1
    return
  }

  const t0 = Date.now()
  const rig = await createRig()
  const backend: Backend = 'webgpu'
  const findings: Array<Record<string, unknown>> = []
  try {
    const bytes = new Uint8Array(fs.readFileSync('stuff/2013-03-12 00.48.07.jpg'))
    const photo = centerCrop(await rig.decodeImage(bytes, 'image/jpeg', 1024), SIZE, SIZE)

    for (const dpr of DPRS) {
      for (const frost of FROSTS) {
        const radiusPx = frost * 24 * dpr
        const inset = Math.ceil(1.5 * radiusPx) + 8
        const roi = { x0: inset, y0: inset, x1: SIZE - inset, y1: SIZE - inset }
        const tag = `dpr${dpr}-f${String(Math.round(frost * 1000)).padStart(4, '0')}`

        const gtC = CANDIDATES.find((c) => c.id === 'C7')!
        const gt = await captureFrost({ rig, backend, input: photo, candidate: gtC, radiusPx, frost, dpr })
        const gt2 = await captureFrost({ rig, backend, input: photo, candidate: gtC, radiusPx, frost, dpr, seedPhase: 977 })
        if (dpr === 2) save(`gt-${tag}-C7`, gt)

        // The C7-vs-C7 floor for the LOOK detector: any candidate at or under
        // this is inside the ground truth's own noise.
        const floor = structure2d(gt2, gt, roi)
        if (dpr === 2) {
          // CONTROL TILES, rendered exactly like the candidate tiles.
          //  - C7 re-roll: the residual texture of a CONVERGED estimator on this
          //    very content. The look target.
          //  - iid: synthetic white noise at the same displayed contrast. What
          //    "structureless" looks like through a 5x nearest zoom, so a
          //    zoom-induced pattern cannot be mistaken for a shader artefact.
          const fv = residualView(gt2, gt, 40 / Math.max(floor.rms, 0.01))
          save(`tile-resid-${tag}-CTRL-c7reroll`, cropZoom(fv.img, 176, 176, 112, 112, 5))
          const rnd = mulberry32(4242)
          const iid = blank(SIZE, SIZE)
          for (let i = 0; i < SIZE * SIZE; i++) {
            const v = Math.max(0, Math.min(255, Math.round(128 + (rnd() - 0.5) * 40 * Math.sqrt(12))))
            iid.data[i * 4] = v
            iid.data[i * 4 + 1] = v
            iid.data[i * 4 + 2] = v
          }
          save(`tile-resid-${tag}-CTRL-iid`, cropZoom(iid, 176, 176, 112, 112, 5))
        }
        findings.push({ cand: 'C7floor', dpr, frost, ...num(floor) })
        console.log(`\n-- ${tag}  R=${radiusPx}px  C7 floor: rms ${floor.rms.toFixed(2)} peak ${floor.peak.toFixed(3)} off ${floor.peakOffAxis.toFixed(3)} aniso ${floor.aniso.toFixed(2)}`)

        const residStrips: Rgba8[] = []
        const zoomStrips: Record<string, Rgba8[]> = { bright: [], edge: [], dark: [] }
        // C7 first in every strip, as the anchor.
        for (const id of ['C7', ...CANDS]) {
          const c = CANDIDATES.find((x) => x.id === id)!
          const img = id === 'C7' ? gt : await captureFrost({ rig, backend, input: photo, candidate: c, radiusPx, frost, dpr })
          const s = structure2d(img, gt, roi)
          const rv = residualView(img, gt, 8)
          findings.push({ cand: id, dpr, frost, radiusPx, ...num(s), residRms: +rv.rms.toFixed(2), residClipAt8x: +rv.clip.toFixed(4) })
          console.log(
            `   ${id.padEnd(7)} rms ${s.rms.toFixed(2).padStart(5)}  peak ${s.peak.toFixed(3)} @(${s.peakDx},${s.peakDy})  off ${s.peakOffAxis.toFixed(3)} @(${s.offDx},${s.offDy})  axis ${s.peakAxis.toFixed(3)}  aniso ${s.aniso.toFixed(2)}@${s.anisoDeg}  residRms ${rv.rms.toFixed(2)}`,
          )

          if (dpr === 2) {
            residStrips.push(cropZoom(rv.img, 160, 160, 128, 128, 2))
            for (const [wname, wx, wy] of WINDOWS) zoomStrips[wname].push(cropZoom(img, wx, wy, WIN, WIN, 4))
            if (['C0', 'C3j-16', 'C7'].includes(id)) save(`full-${tag}-${id}`, img)
            // Individually readable tiles. A 2856px-wide montage is downscaled
            // to unreadability by any viewer; the whole point of this pass is
            // that the texture must survive being looked at.
            // Fixed gain 8: amplitudes comparable across candidates (but C0/C1/C2
            // clip — see residClipAt8x).
            save(`tile-resid-${tag}-${id}`, cropZoom(rv.img, 176, 176, 112, 112, 5))
            // Contrast-NORMALISED: gain set so every candidate's residual is
            // displayed at the same RMS. Amplitude information is destroyed on
            // purpose, so the eye compares STRUCTURE only and a loud-but-
            // structureless residual cannot be mistaken for a patterned one.
            if (s.rms > 0) save(`tilen-resid-${tag}-${id}`, cropZoom(residualView(img, gt, 40 / s.rms).img, 176, 176, 112, 112, 5))
            save(`tile-bright-${tag}-${id}`, cropZoom(img, 384, 24, 112, 112, 5))
            save(`tile-edge-${tag}-${id}`, cropZoom(img, 120, 90, 112, 112, 5))
          }
        }
        if (dpr === 2) {
          save(`resid-${tag}`, montageH(residStrips))
          for (const [wname] of WINDOWS) save(`zoom-${wname}-${tag}`, montageH(zoomStrips[wname]))
        }
      }
    }

    // -------------------------------------------------------------------
    // CONTENT CONFOUND CONTROL.
    //
    // On a photograph the residual amplitude is modulated by the picture:
    // var(cand - C7) scales with the variance of the SOURCE inside the gather
    // radius, so a fringe that follows the dog's fur is the dog, not the
    // sampler. White noise is stationary and isotropic by construction, so on
    // it any orientation or lag structure in the residual belongs to the tap
    // pattern and to nothing else. This is the load-bearing measurement for
    // every "visible weave / streak" claim.
    // -------------------------------------------------------------------
    // WHY NOT WHITE NOISE. Measured, not assumed: on hfNoise the shipped
    // lattice C0 reads peak 0.014 / aniso 1.03 at R=48 — indistinguishable from
    // every other candidate. White noise is the wrong control because the
    // lattice artefact needs a locally SMOOTH source: cells share tap OFFSETS,
    // not tap positions, so neighbouring pixels only agree when the source is
    // smooth over the offset. A control on which the known-bad passes proves
    // nothing. This is band-limited isotropic noise instead: stationary and
    // orientation-free like white noise, but smooth, so the mechanism survives.
    const noise = isoSmoothField(SIZE, 20260728, 5)
    save('stim-iso-smooth', noise)
    for (const frost of [1.0, 0.25]) {
      const dpr = 2
      const radiusPx = frost * 24 * dpr
      const inset = Math.ceil(1.5 * radiusPx) + 8
      const roi = { x0: inset, y0: inset, x1: SIZE - inset, y1: SIZE - inset }
      const tag = `noise-dpr2-f${String(Math.round(frost * 1000)).padStart(4, '0')}`
      const gtC = CANDIDATES.find((c) => c.id === 'C7')!
      const gt = await captureFrost({ rig, backend, input: noise, candidate: gtC, radiusPx, frost, dpr })
      const gt2 = await captureFrost({ rig, backend, input: noise, candidate: gtC, radiusPx, frost, dpr, seedPhase: 977 })
      const floor = structure2d(gt2, gt, roi)
      findings.push({ cand: 'C7floor', stim: 'hf-noise', dpr, frost, ...num(floor) })
      console.log(`\n-- ${tag}  R=${radiusPx}px  C7 floor: rms ${floor.rms.toFixed(2)} peak ${floor.peak.toFixed(3)} off ${floor.peakOffAxis.toFixed(3)} aniso ${floor.aniso.toFixed(2)}`)
      save(`tilen-resid-${tag}-CTRL-c7reroll`, cropZoom(residualView(gt2, gt, 40 / Math.max(floor.rms, 0.01)).img, 176, 176, 112, 112, 5))
      const seen: Record<string, Structure2d> = {}
      for (const id of CANDS) {
        const c = CANDIDATES.find((x) => x.id === id)!
        const img = await captureFrost({ rig, backend, input: noise, candidate: c, radiusPx, frost, dpr })
        const s = structure2d(img, gt, roi)
        seen[id] = s
        findings.push({ cand: id, stim: 'iso-smooth', dpr, frost, radiusPx, ...num(s) })
        console.log(
          `   ${id.padEnd(7)} rms ${s.rms.toFixed(2).padStart(5)}  peak ${s.peak.toFixed(3)} @(${s.peakDx},${s.peakDy})  off ${s.peakOffAxis.toFixed(3)} @(${s.offDx},${s.offDy})  axis ${s.peakAxis.toFixed(3)}  aniso ${s.aniso.toFixed(2)}@${s.anisoDeg}`,
        )
        if (s.rms > 0) save(`tilen-resid-${tag}-${id}`, cropZoom(residualView(img, gt, 40 / s.rms).img, 176, 176, 112, 112, 5))
      }
      // The control must reproduce the DEFECT, or it proves nothing about the
      // candidates. C0 is the user's complaint; on this stimulus it has to show
      // the 4*dpr = 8 device-px cell as strong axis correlation out to lag 7.
      const c0ok = seen['C0'].peakAxis > 0.4
      findings.push({ check: 'iso-smooth control reproduces the known-bad', stim: 'iso-smooth', frost, c0PeakAxis: +seen['C0'].peakAxis.toFixed(3), pass: c0ok })
      console.log(`   [control validity] C0 peakAxis ${seen['C0'].peakAxis.toFixed(3)} — ${c0ok ? 'PASS (known-bad reproduces)' : 'FAIL — control is blind, ignore its verdicts'}`)
    }

    console.log('\nwrote look images to', IMG)
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(
    path.join(OUT, 'phase9-look.json'),
    JSON.stringify({ calibration: calib, order: ['C7', ...CANDS], findings, elapsedSec: Math.round((Date.now() - t0) / 1000) }, null, 2),
  )
  console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)}s`)
}

function num(s: Structure2d): Record<string, number | string> {
  return {
    rms: +s.rms.toFixed(3),
    peak: +s.peak.toFixed(3),
    peakLag: `(${s.peakDx},${s.peakDy})`,
    peakOffAxis: +s.peakOffAxis.toFixed(3),
    offLag: `(${s.offDx},${s.offDy})`,
    peakAxis: +s.peakAxis.toFixed(3),
    aniso: +s.aniso.toFixed(2),
    anisoDeg: s.anisoDeg,
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
