/**
 * Phase 14 — CPU-side metrics for the minification bake-off, and the synthetic
 * known-good / known-bad transforms that calibrate each one.
 *
 * Every metric here is paired with a transform that MUST move it and a transform
 * that MUST NOT. That pairing is the point of the file: this study has repeatedly
 * been burned by a number that improved while the image still staircased, and by
 * a reference that flattered a change. A metric with no known-bad is a metric
 * that cannot fail, and a metric that fires on the known-good is a metric that
 * lies.
 *
 * Working representation is f64 code units (0..255), not u8, because the ground
 * truth is CPU-accumulated across tile draws and its true value is fractional.
 */

import type { Rgba8 } from './lib/image.ts'

// ===========================================================================
// Float images in code units
// ===========================================================================

export interface FloatImg { width: number; height: number; data: Float64Array }

export function zerosF(w: number, h: number): FloatImg {
  return { width: w, height: h, data: new Float64Array(w * h * 4) }
}

export function fromRgba8(img: Rgba8): FloatImg {
  const f = zerosF(img.width, img.height)
  for (let i = 0; i < f.data.length; i++) f.data[i] = img.data[i]
  return f
}

export function toRgba8(f: FloatImg): Rgba8 {
  const out = new Uint8ClampedArray(f.width * f.height * 4)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(f.data[i])
  return { width: f.width, height: f.height, data: out }
}

/** Accumulate `src` into `dst` with `weight` — the tiled-GT accumulator. */
export function addInto(dst: FloatImg, src: Rgba8, weight: number): void {
  if (dst.width !== src.width || dst.height !== src.height) throw new Error('addInto: size mismatch')
  for (let i = 0; i < dst.data.length; i++) dst.data[i] += src.data[i] * weight
}

/** Rec.709 luma field in code units. */
export function lumaF(f: FloatImg): Float64Array {
  const out = new Float64Array(f.width * f.height)
  for (let i = 0; i < out.length; i++) {
    const o = i * 4
    out[i] = 0.2126 * f.data[o] + 0.7152 * f.data[o + 1] + 0.0722 * f.data[o + 2]
  }
  return out
}

// ===========================================================================
// METRIC 1 — error vs the converged ground truth
// ===========================================================================

export interface Resid {
  /** pixels counted */
  n: number
  /** mean over pixels of the max-of-RGB absolute difference, codes */
  mean: number
  /** RMS over pixels and RGB channels, codes */
  rmse: number
  p999: number
  max: number
  at: [number, number]
  fracGe1: number
  fracGe8: number
}

export const EMPTY_RESID: Resid = { n: 0, mean: 0, rmse: 0, p999: 0, max: 0, at: [0, 0], fracGe1: 0, fracGe8: 0 }

/** Per-pixel max-of-RGB absolute difference in codes, zero inside the margin. */
export function diffField(a: FloatImg, b: FloatImg, margin: number): Float64Array {
  if (a.width !== b.width || a.height !== b.height) throw new Error('diffField: size mismatch')
  const out = new Float64Array(a.width * a.height)
  for (let y = margin; y < a.height - margin; y++) {
    for (let x = margin; x < a.width - margin; x++) {
      const o = (y * a.width + x) * 4
      out[y * a.width + x] = Math.max(
        Math.abs(a.data[o] - b.data[o]),
        Math.abs(a.data[o + 1] - b.data[o + 1]),
        Math.abs(a.data[o + 2] - b.data[o + 2]),
      )
    }
  }
  return out
}

export function residual(a: FloatImg, b: FloatImg, margin: number, mask?: Uint8Array | null): Resid {
  const f = diffField(a, b, margin)
  let sum = 0
  let sq = 0
  let n = 0
  let mx = -1
  let at: [number, number] = [0, 0]
  let ge1 = 0
  let ge8 = 0
  const vals: number[] = []
  for (let y = margin; y < a.height - margin; y++) {
    for (let x = margin; x < a.width - margin; x++) {
      const i = y * a.width + x
      if (mask && !mask[i]) continue
      const d = f[i]
      sum += d
      n++
      vals.push(d)
      if (d >= 1) ge1++
      if (d >= 8) ge8++
      if (d > mx) { mx = d; at = [x, y] }
      const o = i * 4
      for (let c = 0; c < 3; c++) { const e = a.data[o + c] - b.data[o + c]; sq += e * e }
    }
  }
  if (n === 0) return { ...EMPTY_RESID }
  vals.sort((p, q) => p - q)
  return {
    n,
    mean: sum / n,
    rmse: Math.sqrt(sq / (n * 3)),
    p999: vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.999))],
    max: mx < 0 ? 0 : mx,
    at,
    fracGe1: ge1 / n,
    fracGe8: ge8 / n,
  }
}

export interface Band { mask: Uint8Array; theta: number; count: number; frac: number }

/**
 * The error-bearing band, defined from the CONTROL's own error and calibrated to
 * a target frame fraction rather than a fixed code threshold.
 *
 * A fixed 8-code threshold selects 13.5% of a high-contrast frame but only 0.09%
 * (153 px of 163 840) of the user's nearly-flat one — so a fixed threshold means
 * "average 153 pixels" on the scene that actually matters, and any candidate
 * separation drowns in that sample size. Picking theta as a percentile of the
 * control error field keeps the sample size fixed across stimuli, and theta is
 * reported so the two are never confused.
 */
export function bandFromControl(
  ctrl: FloatImg, gt: FloatImg, margin: number, fracTarget: number, minTheta: number,
): Band {
  const f = diffField(ctrl, gt, margin)
  const vals: number[] = []
  for (let y = margin; y < ctrl.height - margin; y++) {
    for (let x = margin; x < ctrl.width - margin; x++) vals.push(f[y * ctrl.width + x])
  }
  vals.sort((a, b) => a - b)
  const q = vals[Math.min(vals.length - 1, Math.floor(vals.length * (1 - fracTarget)))]
  const theta = Math.max(minTheta, q)
  const mask = new Uint8Array(ctrl.width * ctrl.height)
  let count = 0
  for (let y = margin; y < ctrl.height - margin; y++) {
    for (let x = margin; x < ctrl.width - margin; x++) {
      const i = y * ctrl.width + x
      if (f[i] >= theta) { mask[i] = 1; count++ }
    }
  }
  return { mask, theta, count, frac: count / vals.length }
}

/** A fixed-threshold band, for comparability with the phase 10/12 numbers. */
export function bandFixed(ctrl: FloatImg, gt: FloatImg, margin: number, theta: number): Band {
  const f = diffField(ctrl, gt, margin)
  const mask = new Uint8Array(ctrl.width * ctrl.height)
  let count = 0
  let tot = 0
  for (let y = margin; y < ctrl.height - margin; y++) {
    for (let x = margin; x < ctrl.width - margin; x++) {
      const i = y * ctrl.width + x
      tot++
      if (f[i] >= theta) { mask[i] = 1; count++ }
    }
  }
  return { mask, theta, count, frac: tot ? count / tot : 0 }
}

// ===========================================================================
// Gaussian blur on a scalar field — the engine of the look metric
// ===========================================================================

export function gaussBlur(src: Float64Array, w: number, h: number, sigma: number): Float64Array {
  if (sigma <= 0) return src.slice()
  const r = Math.max(1, Math.ceil(sigma * 3.5))
  const k = new Float64Array(2 * r + 1)
  let ks = 0
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; ks += v }
  for (let i = 0; i < k.length; i++) k[i] /= ks
  const tmp = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += src[y * w + Math.max(0, Math.min(w - 1, x + i))] * k[i + r]
      tmp[y * w + x] = acc
    }
  }
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let i = -r; i <= r; i++) acc += tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x] * k[i + r]
      out[y * w + x] = acc
    }
  }
  return out
}

// ===========================================================================
// METRIC 2 — LOOK PRESERVATION
// ===========================================================================

export interface LookResult {
  /** sigma used, device px */
  sigmaPx: number
  /** rms of the low-passed luma difference, codes */
  rmsCodes: number
  /** max of the low-passed luma difference, codes */
  maxCodes: number
  /** rms of the GT's own low-passed structure about its mean, codes — the scale
   *  everything is measured against */
  gtStructRms: number
  /** rmsCodes / gtStructRms — dimensionless fraction of the macroscopic signal */
  norm: number
  /** mean luma shift, codes (a pure brightness change IS a look change) */
  biasCodes: number
}

/**
 * How much of the MACROSCOPIC image changed, deliberately blind to aliasing.
 *
 * The artefact is a 2 px caustic pair; the structure the user likes is the 120 px
 * (dpr 1.5) rib period and the photo underneath it. Low-passing both images at
 * sigma = 4 device px attenuates 2-4 px structure to nothing while passing the
 * rib period essentially untouched (a sigma-4 gaussian is down 0.15% at a 120 px
 * period and ~1e-8 at a 4 px one), so what survives is exactly "did the picture
 * change" with "did the aliasing change" removed.
 *
 * Normalised by the GT's own low-passed contrast so the same threshold applies to
 * a 30-code-span frame and a 212-code one.
 *
 * REQUIRED BEHAVIOUR (calibrated in the bench, not asserted here):
 *   must NOT fire on: GT8 vs GT64; GT + white noise at the control's error rms;
 *                     a genuinely correct N-tap fix
 *   MUST fire on:     the M3 slope clamp; a global contrast scale; a 0.5 px shift
 */
export function lookDelta(cand: FloatImg, gt: FloatImg, sigmaPx: number, margin: number): LookResult {
  const w = cand.width
  const h = cand.height
  const lc = gaussBlur(lumaF(cand), w, h, sigmaPx)
  const lg = gaussBlur(lumaF(gt), w, h, sigmaPx)
  let sq = 0
  let sum = 0
  let n = 0
  let mx = 0
  let gsum = 0
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x
      const d = lc[i] - lg[i]
      sq += d * d
      sum += d
      if (Math.abs(d) > mx) mx = Math.abs(d)
      gsum += lg[i]
      n++
    }
  }
  const gmean = gsum / n
  let gsq = 0
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) { const d = lg[y * w + x] - gmean; gsq += d * d }
  }
  const gtStructRms = Math.sqrt(gsq / n)
  const rmsCodes = Math.sqrt(sq / n)
  return {
    sigmaPx,
    rmsCodes,
    maxCodes: mx,
    gtStructRms,
    norm: gtStructRms > 1e-9 ? rmsCodes / gtStructRms : 0,
    biasCodes: sum / n,
  }
}

// ===========================================================================
// METRIC 3 — GRAIN (the counterweight to every blur-based improvement)
// ===========================================================================

export interface GrainResult { candHf: number; gtHf: number; ratio: number }

/**
 * High-pass energy relative to the GT's.
 *
 * Every metric that rewards "closer to a box-filtered reference" also rewards
 * blurring everything, and every stochastic candidate trades correlated error for
 * uncorrelated error at the SAME magnitude. Neither shows up in an error mean.
 * ratio > 1 means the candidate added grain (M4 without temporal reconstruction);
 * ratio < 1 means it softened the image (M2 everywhere, M3 in the tail).
 */
export function grainRatio(cand: FloatImg, gt: FloatImg, sigmaPx: number, margin: number, mask?: Uint8Array | null): GrainResult {
  const w = cand.width
  const h = cand.height
  const hp = (f: FloatImg): number => {
    const l = lumaF(f)
    // Blur over the WHOLE frame, then measure only inside the mask: a masked blur
    // would leak the mask's own edges into the high-pass.
    const b = gaussBlur(l, w, h, sigmaPx)
    let sq = 0
    let n = 0
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = y * w + x
        if (mask && !mask[i]) continue
        const d = l[i] - b[i]
        sq += d * d
        n++
      }
    }
    return n ? Math.sqrt(sq / n) : 0
  }
  const candHf = hp(cand)
  const gtHf = hp(gt)
  return { candHf, gtHf, ratio: gtHf > 1e-9 ? candHf / gtHf : 0 }
}

// ===========================================================================
// METRIC 4 — STAIRCASE / contour jitter, and caustic contrast
// ===========================================================================

export interface SeamTrack {
  n: number
  xs: number[]
  /** largest row-to-row step of the sub-pixel contour position, px */
  jumpMax: number
  jumpP95: number
  /** mean |second difference| of the contour track, px — raggedness */
  curvature2nd: number
  flatRunP50: number
  flatRunMax: number
  /** mean peak |dLuma/dx| at the tracked contour, codes/px — the caustic's
   *  steepness. A candidate that drops this a lot is flattening a real feature. */
  meanPeakCodes: number
}

export interface SeamTrackOpts {
  /** integer x to start the tracker at on the first row. Pass the REFERENCE's
   *  seed to every candidate so they all follow the same contour. */
  seed?: number
  /** per-row search radius, px. Finite radius = a single-contour tracker. */
  radius?: number
  /** pre-smooth the luma by this sigma before tracking. A radius-3 tracker on raw
   *  luma MEASURED 3.10 px on GT64 itself — it saturated its own search radius,
   *  because the user's rib packs 8 mirror-wrap folds and several sit 1-3 px
   *  apart. Merging them with a sigma-1 blur leaves one contour to follow. */
  smoothSigma?: number
  /** frame height, required when smoothSigma > 0 */
  height?: number
}

/**
 * Track ONE contour's sub-pixel x per row and report how much it jitters.
 *
 * A global argmax per row does not work here: the user's config puts 8 mirror-wrap
 * folds in every rib, several of them 1-3 px apart, so the argmax hops between
 * competing creases and EVERY column — including the converged reference — scores
 * ~3 px of jitter. Measured: with a global argmax, GT64 reads jumpP95 2.98 px,
 * GT32 2.98, M1-N16 3.07, M0 6.21 — the reference is indistinguishable from a
 * candidate, so the metric is useless in that form.
 *
 * The fix is a constrained tracker: seed once, then search only +-`radius` px
 * around the previous row's position. The seed comes from the REFERENCE so every
 * column follows the same physical contour and the comparison is like-for-like.
 *
 * STILL only valid on locally-single-edge content — on a detailed photo the
 * tracker can be captured by image detail. The bench reports validity, it does
 * not assume it.
 */
export function seamTrack(
  l: Float64Array, w: number, x0: number, x1: number, y0: number, y1: number, opts: SeamTrackOpts = {},
): SeamTrack {

  const xs: number[] = []
  const peaks: number[] = []
  const src = opts.smoothSigma && opts.smoothSigma > 0
    ? gaussBlur(l, w, opts.height ?? Math.floor(l.length / w), opts.smoothSigma)
    : l
  const at = (x: number, y: number): number => src[y * w + x]
  const radius = opts.radius ?? Infinity
  let prev = opts.seed ?? -1
  for (let y = y0; y < y1; y++) {
    const lo = Number.isFinite(radius) && prev >= 0 ? Math.max(x0 + 1, Math.round(prev - radius)) : x0 + 1
    const hi = Number.isFinite(radius) && prev >= 0 ? Math.min(x1 - 2, Math.round(prev + radius)) : x1 - 2
    let bi = lo
    let bg = -1
    for (let x = lo; x <= hi; x++) {
      const g = Math.abs(at(x + 1, y) - at(x - 1, y)) * 0.5
      if (g > bg) { bg = g; bi = x }
    }
    prev = bi
    const gm = Math.abs(at(bi, y) - at(Math.max(x0, bi - 2), y)) * 0.5
    const gp = Math.abs(at(Math.min(x1 - 1, bi + 2), y) - at(bi, y)) * 0.5
    const den = gm - 2 * bg + gp
    const sub = Math.abs(den) > 1e-9 ? Math.max(-1, Math.min(1, 0.5 * (gm - gp) / den)) : 0
    xs.push(bi + sub)
    peaks.push(bg)
  }
  const jumps: number[] = []
  let jumpMax = 0
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - xs[i - 1])
    if (Number.isFinite(d)) { jumps.push(d); if (d > jumpMax) jumpMax = d }
  }
  jumps.sort((a, b) => a - b)
  let second = 0
  let n2 = 0
  for (let i = 2; i < xs.length; i++) {
    const d = Math.abs(xs[i] - 2 * xs[i - 1] + xs[i - 2])
    if (Number.isFinite(d)) { second += d; n2++ }
  }
  const runs: number[] = []
  let cur = 1
  for (let i = 1; i < xs.length; i++) {
    if (Math.round(xs[i]) === Math.round(xs[i - 1])) cur++
    else { runs.push(cur); cur = 1 }
  }
  runs.push(cur)
  runs.sort((a, b) => a - b)
  return {
    n: xs.length,
    xs: xs.map((v) => +v.toFixed(3)),
    jumpMax: +jumpMax.toFixed(3),
    jumpP95: +(jumps.length ? jumps[Math.floor(jumps.length * 0.95)] : 0).toFixed(3),
    curvature2nd: +(n2 ? second / n2 : 0).toFixed(4),
    flatRunP50: runs[Math.floor(runs.length / 2)],
    flatRunMax: runs[runs.length - 1],
    meanPeakCodes: +(peaks.reduce((a, b) => a + b, 0) / peaks.length).toFixed(3),
  }
}

/** The integer x of the strongest cross-rib gradient on one row — the tracker seed. */
export function trackSeed(l: Float64Array, w: number, x0: number, x1: number, y: number): number {
  let bi = x0 + 1
  let bg = -1
  for (let x = x0 + 1; x < x1 - 1; x++) {
    const g = Math.abs(l[y * w + x + 1] - l[y * w + x - 1])
    if (g > bg) { bg = g; bi = x }
  }
  return bi
}

export interface CausticContrast { median: number; mean: number; rows: number }

/**
 * The caustic's own cross-rib contrast: per row, (max - min) of the luma profile
 * across the window, after a sigma-1 smoothing to reject per-pixel noise; median
 * over rows.
 *
 * This replaces a peak-gradient ratio, which MEASURABLY did not discriminate: a
 * max-of-gradient statistic is upward-biased by noise (white noise at the control's
 * own error rms read 1.138x while a real 15% flattening read 0.850x, so the
 * known-good and known-bad ranges OVERLAPPED). Smoothing first and using a range
 * rather than a derivative removes the noise bias.
 */
export function causticContrast(l: Float64Array, w: number, h: number, x0: number, x1: number, y0: number, y1: number): CausticContrast {
  const sm = gaussBlur(l, w, h, 1.0)
  const vals: number[] = []
  for (let y = y0; y < y1; y++) {
    let mn = Infinity
    let mx = -Infinity
    for (let x = x0; x < x1; x++) {
      const v = sm[y * w + x]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    vals.push(mx - mn)
  }
  const sorted = [...vals].sort((a, b) => a - b)
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    rows: vals.length,
  }
}

// ===========================================================================
// Synthetic transforms — the known-good and known-bad controls
// ===========================================================================

/** Deterministic 32-bit hash -> [0,1). No Math.random anywhere in the bench. */
function hash01(i: number, seed: number): number {
  let x = (i * 2654435761 + seed * 1013904223) >>> 0
  x ^= x >>> 15
  x = (x * 2246822519) >>> 0
  x ^= x >>> 13
  x = (x * 3266489917) >>> 0
  x ^= x >>> 16
  return x / 4294967296
}

/**
 * KNOWN-GOOD for the look metric: zero-mean white noise at a chosen rms.
 * A pure denoise/renoise changes no macroscopic structure at all, so the look
 * metric MUST read ~0 on it while the error metric reads `rmsCodes`.
 */
export function addWhiteNoise(f: FloatImg, rmsCodes: number, seed: number): FloatImg {
  const out: FloatImg = { width: f.width, height: f.height, data: f.data.slice() }
  const n = f.width * f.height
  for (let i = 0; i < n; i++) {
    // Box-Muller from two hashes, so the noise is gaussian and genuinely
    // zero-mean rather than a uniform with a mean-shift tail.
    const u1 = Math.max(hash01(i, seed), 1e-12)
    const u2 = hash01(i, seed + 7919)
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    const d = g * rmsCodes
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = f.data[i * 4 + c] + d
  }
  return out
}

/**
 * KNOWN-BAD for the look metric: a global contrast scale about the frame mean.
 * Unambiguously a macroscopic change with no aliasing content whatsoever, so the
 * look metric MUST fire and the grain ratio must move in step.
 */
export function scaleContrast(f: FloatImg, alpha: number): FloatImg {
  const out: FloatImg = { width: f.width, height: f.height, data: f.data.slice() }
  const n = f.width * f.height
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += f.data[i * 4 + c]
  for (let c = 0; c < 3; c++) mean[c] /= n
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = mean[c] + (f.data[i * 4 + c] - mean[c]) * alpha
  }
  return out
}

/** Sub-pixel bilinear shift, edge-clamped. Doubles as the temporal pan and as a
 *  known-bad geometric change for the look metric. */
export function shiftSubpixel(f: FloatImg, dx: number, dy: number): FloatImg {
  const { width: w, height: h } = f
  const out = zerosF(w, h)
  for (let y = 0; y < h; y++) {
    const sy = y - dy
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = x - dx
      const x0 = Math.floor(sx)
      const fx = sx - x0
      const cx0 = Math.max(0, Math.min(w - 1, x0))
      const cx1 = Math.max(0, Math.min(w - 1, x0 + 1))
      const cy0 = Math.max(0, Math.min(h - 1, y0))
      const cy1 = Math.max(0, Math.min(h - 1, y0 + 1))
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = f.data[(cy0 * w + cx0) * 4 + c] * (1 - fx) + f.data[(cy0 * w + cx1) * 4 + c] * fx
        const b = f.data[(cy1 * w + cx0) * 4 + c] * (1 - fx) + f.data[(cy1 * w + cx1) * 4 + c] * fx
        out.data[o + c] = a * (1 - fy) + b * fy
      }
    }
  }
  return out
}

export function shiftRgba8(img: Rgba8, dx: number, dy: number): Rgba8 {
  return toRgba8(shiftSubpixel(fromRgba8(img), dx, dy))
}

// ===========================================================================
// METRIC 5 — TEMPORAL CRAWL
// ===========================================================================

export interface TemporalResult {
  /** mean over consecutive frame pairs and band pixels of
   *  |(C[i+1]-C[i]) - (G[i+1]-G[i])| in codes — GT scores exactly 0 */
  excessMean: number
  excessMax: number
  /** the GT's own frame-to-frame motion, for scale */
  gtMotionMean: number
  /** excessMean / gtMotionMean */
  ratio: number
  frames: number
  n: number
}

export function temporalExcess(cand: FloatImg[], gt: FloatImg[], mask: Uint8Array, margin: number): TemporalResult {
  if (cand.length !== gt.length || cand.length < 2) throw new Error('temporalExcess: need >=2 matched frames')
  const w = cand[0].width
  const h = cand[0].height
  let sum = 0
  let mx = 0
  let gsum = 0
  let n = 0
  for (let k = 1; k < cand.length; k++) {
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const i = y * w + x
        if (!mask[i]) continue
        let d = 0
        let gd = 0
        for (let c = 0; c < 3; c++) {
          const o = i * 4 + c
          const dc = (cand[k].data[o] - cand[k - 1].data[o]) - (gt[k].data[o] - gt[k - 1].data[o])
          const dg = gt[k].data[o] - gt[k - 1].data[o]
          if (Math.abs(dc) > d) d = Math.abs(dc)
          if (Math.abs(dg) > gd) gd = Math.abs(dg)
        }
        sum += d
        gsum += gd
        if (d > mx) mx = d
        n++
      }
    }
  }
  const excessMean = n ? sum / n : 0
  const gtMotionMean = n ? gsum / n : 0
  return {
    excessMean, excessMax: mx, gtMotionMean,
    ratio: gtMotionMean > 1e-9 ? excessMean / gtMotionMean : 0,
    frames: cand.length, n,
  }
}

// ===========================================================================
// The closed-form derivative — shared by the shader emitter and the CPU cost model
// ===========================================================================

/** k and A exactly as REED_LENS_BODY computes them (clamps included). */
export function lensKA(ior: number, curvature: number): { k: number; amp: number; A: number } {
  const c = Math.min(Math.max(curvature, 0.01), 1.0)
  const amp = curvature > 1.0 ? curvature : 1.0
  const k = Math.min(c, 0.99)
  return { k, amp, A: (ior - 1) * amp * k }
}

/** L'(x) = 1 - A / (1 - k^2 x^2)^{3/2}, x in [-1, 1]. */
export function lensDeriv(x: number, ior: number, curvature: number): number {
  const { k, A } = lensKA(ior, curvature)
  const s = Math.max(1 - k * k * x * x, 1e-6)
  return 1 - A / Math.pow(s, 1.5)
}

/**
 * sup |L'| over the OPEN rib, in closed form.
 *
 * |L'| = |1 - A/S^{3/2}| with S = 1 - k^2 x^2 decreasing in |x|, so A/S^{3/2}
 * increases monotonically from A to A/(1-k^2)^{3/2} and the extremes of L' are at
 * x = 0 and |x| -> 1. sup|L'| = max(|1-A|, |1 - A/(1-k^2)^{3/2}|). The |x| -> 1
 * value is a supremum, not attained — which is what makes the defaults no-op a
 * proof rather than a sampled bound.
 */
export function supLensDeriv(ior: number, curvature: number): number {
  const { k, A } = lensKA(ior, curvature)
  const edge = 1 - A / Math.pow(Math.max(1 - k * k, 1e-6), 1.5)
  return Math.max(Math.abs(1 - A), Math.abs(edge))
}

/** max |L'| over an interval of x — evaluated at both endpoints, because |L'| is
 *  V-shaped (it passes through zero at the fold) whenever A < 1. */
export function maxLensDerivOver(xc: number, halfWidth: number, ior: number, curvature: number): number {
  const lo = Math.max(-1, Math.min(1, xc - halfWidth))
  const hi = Math.max(-1, Math.min(1, xc + halfWidth))
  return Math.max(Math.abs(lensDeriv(lo, ior, curvature)), Math.abs(lensDeriv(hi, ior, curvature)))
}

/** Fraction of the rib where |L'| > 1 (minifies, therefore aliases at 1 tap). */
export function fracMinifying(ior: number, curvature: number, n = 200001): number {
  let c = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(lensDeriv(-1 + (2 * i) / (n - 1), ior, curvature)) > 1) c++
  }
  return c / n
}

/**
 * The clamp constant M3 needs so that |L'| <= C everywhere.
 *
 * REED_LENS_BODY computes slope = x*k/sqrt(max(1 - k^2 x^2, 0.001)). Raising that
 * floor from 0.001 to eps makes the slope LINEAR in x wherever 1-k^2x^2 < eps, so
 * there d(disp)/d(local) = -A/sqrt(eps) exactly. Setting that to -(1+C) gives
 * eps = (A/(1+C))^2 — one closed-form constant, one token changed in the node's
 * own line, and the profile untouched wherever it was already under the cap.
 */
export function slopeClampEps(ior: number, curvature: number, C: number): number {
  const { A } = lensKA(ior, curvature)
  return (A / (1 + C)) * (A / (1 + C))
}
