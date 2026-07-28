// Phase 9b detectors — the four questions the frost bake-off has to answer.
//
// Design rules, learned the hard way on this project:
//   * every headline number is ADDITIVE and carries a unit (8-bit codes, or a
//     correlation in [-1,1], or a mass fraction). Where a ratio is unavoidable
//     the denominator is either a CONSTANT (never data near zero) or a robust
//     statistic of the same signal, and the ratio is reported only as a
//     corroborator next to an additive headline.
//   * every metric returns an explicit `degenerate` flag instead of dividing by
//     a vanishing variance. A degenerate result is a PASS for a quality gate
//     (there is no structure left to measure) and must never read as a failure.
//   * nothing is trusted until it has been scored on a synthetic known-good AND
//     a synthetic known-bad. See phase9-frost.ts `--validate`.
//
// lib/frost-metrics.ts already carries the Phase-9a metrics (deviation,
// blockEdgeExcess, blockCoherence, speckleRms, directionalCorr) and those stay
// the corroborators; this file adds the ones Phase 9b needs.

import type { Rgba8 } from './image'
import { lumaRoi, type Roi } from './frost-metrics'

/** Residual variance below this (codes RMS) is at/under 8-bit quantisation noise
 *  (uniform quantisation RMS = 1/sqrt(12) = 0.289 codes) and carries no signal. */
export const RESIDUAL_FLOOR = 0.25

// ===========================================================================
// 1. BLOCKINESS
// ===========================================================================

export interface ResidualAcf {
  /** lags 1..maxLag, in device px */
  lags: number[]
  /** mean of the x- and y-direction Pearson autocorrelations of the high-passed residual */
  acf: number[]
  acfX: number[]
  acfY: number[]
  /** RMS of the high-passed residual, 8-bit codes */
  residRms: number
  /**
   * Width of the correlated patch: the FIRST lag at which acf drops below
   * `shoulderThreshold`, minus 1. 0 = no structure beyond a single pixel.
   *
   * Deliberately "first drop", not "last lag above threshold": a block-quantised
   * residual is PERIODIC, so acf comes back up at multiples of the block size
   * (measured: 0.90 at lag 8 for an 8-px block). "Last lag above" would report
   * 16 for every periodic case and tell you nothing about the cell size.
   */
  shoulderLag: number
  degenerate: boolean
}

/**
 * Autocorrelation of the HIGH-PASS RESIDUAL (candidate luma minus reference
 * luma, then minus a local box mean of window 2*maxLag+1).
 *
 * Why residual-vs-reference and not the image itself: content autocorrelation
 * is enormous and swamps the artefact. Why the extra high-pass: the reference
 * may be computed by a different route (CPU vs GPU), leaving a smooth
 * systematic bias that would otherwise dominate every lag. A block period of
 * <= maxLag survives a 2*maxLag+1 box high-pass essentially intact.
 *
 * Predicted signature (derived in the characterisation phase) for the shipped
 * lattice: acf(d) ~ max(0, 1 - d/w) with w = 4*u_dpr device px — i.e. a hard
 * shoulder that reaches 0 at the cell size. A per-pixel-seeded estimator gives
 * acf ~ 0 for every lag >= 1 except the small bilinear footprint.
 */
export function residualAcf(
  cand: Rgba8,
  ref: Rgba8,
  roi: Roi,
  maxLag = 16,
  shoulderThreshold = 0.15,
): ResidualAcf {
  const a = lumaRoi(cand, roi)
  const b = lumaRoi(ref, roi)
  const { w, h } = a
  const r = new Float64Array(w * h)
  for (let i = 0; i < r.length; i++) r[i] = a.v[i] - b.v[i]
  const hp = boxHighPass(r, w, h, maxLag)

  let sq = 0
  for (let i = 0; i < hp.length; i++) sq += hp[i] * hp[i]
  const residRms = Math.sqrt(sq / hp.length)

  const lags: number[] = []
  const acfX: number[] = []
  const acfY: number[] = []
  const acf: number[] = []
  const degenerate = residRms < RESIDUAL_FLOOR
  for (let d = 1; d <= maxLag; d++) {
    lags.push(d)
    const cx = degenerate ? 0 : shiftedPearson(hp, w, h, d, 0)
    const cy = degenerate ? 0 : shiftedPearson(hp, w, h, 0, d)
    acfX.push(cx)
    acfY.push(cy)
    acf.push((cx + cy) / 2)
  }
  let shoulderLag = 0
  for (let i = 0; i < acf.length; i++) {
    if (acf[i] < shoulderThreshold) break
    shoulderLag = lags[i]
  }
  return { lags, acf, acfX, acfY, residRms, shoulderLag: degenerate ? 0 : shoulderLag, degenerate }
}

export interface BlockPeriod {
  periods: number[]
  /** Fourier amplitude of the gradient profile at each period, in 8-bit codes. */
  amplitude: number[]
  dominantPeriod: number | null
  /** amplitude at the dominant period, 8-bit codes — the ADDITIVE headline. */
  dominantAmplitude: number
  /** dominantAmplitude / median(amplitude) — corroborator only. */
  prominence: number
  degenerate: boolean
}

/**
 * Direct estimate of the dominant block-edge period.
 *
 * g(x) = mean over y of |L(x,y) - L(x-1,y)| is a 1-D profile in 8-bit codes.
 * Block structure of period p puts a periodic spike train into g, so g has a
 * Fourier component at frequency 1/p whose amplitude is (roughly) the mean
 * boundary step above the interior step, divided by p. Amplitude is reported in
 * CODES and is the gate; `prominence` (against the median amplitude over all
 * probed periods) is a shape corroborator with a robust, never-zero denominator.
 *
 * The profile is detrended (mean removed, plus a wide box high-pass) so a slow
 * left-to-right change in image detail cannot masquerade as a long period.
 */
export function blockPeriodSpectrum(img: Rgba8, roi: Roi, maxPeriod = 16): BlockPeriod {
  const { w, h, v } = lumaRoi(img, roi)
  const gx = new Float64Array(w)
  const gy = new Float64Array(h)
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++) gx[x] += Math.abs(v[y * w + x] - v[y * w + x - 1]) / h
  for (let y = 1; y < h; y++)
    for (let x = 0; x < w; x++) gy[y] += Math.abs(v[y * w + x] - v[(y - 1) * w + x]) / w

  const px = detrend1d(gx.subarray(1), 2 * maxPeriod + 1)
  const py = detrend1d(gy.subarray(1), 2 * maxPeriod + 1)
  const rms = Math.sqrt(
    (px.reduce((s, t) => s + t * t, 0) + py.reduce((s, t) => s + t * t, 0)) / (px.length + py.length),
  )
  const degenerate = rms < 0.02 // codes: a flat image has no gradient profile at all

  const periods: number[] = []
  const amplitude: number[] = []
  for (let p = 2; p <= maxPeriod; p++) {
    periods.push(p)
    amplitude.push(degenerate ? 0 : (goertzelAmp(px, p) + goertzelAmp(py, p)) / 2)
  }
  // Pick the FUNDAMENTAL, not the loudest harmonic. A spike train of period p
  // has equal Fourier amplitude at p, p/2, p/3..., and detrending can leave the
  // shortest one on top (measured: an 8-px block quantiser peaked at period 2).
  // The fundamental is the LARGEST period whose amplitude is still within half
  // of the maximum. A genuine period-4 structure has no energy at period 8, so
  // this cannot promote a short period to a long one.
  let peak = 0
  for (let i = 0; i < amplitude.length; i++) if (amplitude[i] > peak) peak = amplitude[i]
  let bi = 0
  for (let i = 0; i < amplitude.length; i++) if (amplitude[i] >= 0.5 * peak) bi = i
  const sorted = [...amplitude].sort((a, b) => a - b)
  const med = sorted[Math.floor(sorted.length / 2)]
  return {
    periods,
    amplitude,
    dominantPeriod: degenerate ? null : periods[bi],
    dominantAmplitude: degenerate ? 0 : amplitude[bi],
    prominence: degenerate || med < 1e-9 ? 0 : amplitude[bi] / med,
    degenerate,
  }
}

// ===========================================================================
// 2. KERNEL SHAPE (point-spread function)
// ===========================================================================

export interface PsfStats {
  /** bin centres, in units of the nominal half-extent R */
  binR: number[]
  /** mass fraction landing in each annulus (sums to <= 1 over the measured extent) */
  binMass: number[]
  /** mass per unit area in each annulus, normalised so an ideal disc reads 1.0 inside R */
  binDensity: number[]
  /**
   * Mass-weighted mean radius in the 45-degree wedges / in the axis wedges,
   * over the WHOLE measured extent (a square's excess mass sits beyond R in the
   * diagonals — restricting to r<R makes a square and a disc indistinguishable).
   * Analytic: uniform disc 1.000, uniform square 1.199. Both denominators are
   * mean radii of order 0.7R, so the ratio is never near a zero denominator.
   * lib/detectors.ts anisotropyScore is BLIND to this (mxx == myy for both).
   */
  squareness: number
  /**
   * 1 - density(r < 0.3R) / density(0.35R < r < 0.9R), both MEASURED from the
   * same image. Shape-relative, so a square (uniform, but 4/pi denser overall)
   * reads 0 like a disc, an annulus reads 1, and a Gaussian reads negative.
   * The earlier absolute form (against the ideal disc's 0.09) charged a square
   * a spurious 0.21 deficit for merely not being a disc.
   */
  holeDeficit: number
  /** mass fraction beyond 1.05R — a square footprint leaks to 1.414R. */
  massOutsideR: number
  /** L1 distance between the measured and the ideal-disc per-bin mass fractions, in [0,2]. */
  profileL1Disc: number
  /** L1 distance to a matched Gaussian (same second moment as the ideal disc). */
  profileL1Gauss: number
  /** RMS relative deviation of density from a 3-bin running median, over r<0.9R.
   *  Stops short of the cutoff bin, which is a real step and not a ring.
   *  Catches the concentric rings of an un-jittered sunflower. */
  ringiness: number
  /** fraction of measured pixels that hit the 8-bit ceiling — must be 0. */
  clipFraction: number
  /** total captured mass relative to the emitted impulse mass; ~1 if nothing was lost. */
  massCaptured: number
  /** peak per-pixel linear value seen, as a fraction of full scale BEFORE gain.
   *  Lets the caller pick a gain that will not clip on the next attempt. */
  peakLinear: number
}

/**
 * Measure the expected kernel of a stochastic gather from an impulse field.
 *
 * For a gather out(p) = sum_i w_i * src(p + d_i(p)) with a per-pixel random
 * d_i, a single delta at c produces out(p) = sum_i w_i [p + d_i(p) ~ c]: one
 * noisy sample of the (point-reflected) kernel per output pixel. Averaging the
 * patches around many impulses and then over annuli converges quickly, and the
 * total mass is conserved exactly, so `massCaptured` is a real correctness
 * check rather than a normalisation.
 *
 * `imgs` must come from the sqrt-companded gain egress; `gain` and `dotMass`
 * undo the amplification so binMass is a true mass fraction.
 *
 * Pass SEVERAL images (the same field captured at different seed phases) for a
 * lattice-seeded candidate. Its sample set is fixed per cell, so the translated
 * cells neither tile nor cover the plane: for one realisation the estimator is
 * unbiased but noisy, and total mass came in 8.7% light for the shipped C0 at
 * one phase. Averaging over phases is the estimator fix; massCaptured is the
 * flag that says whether it worked.
 */
export function psfStats(
  imgs: Rgba8[],
  centers: Array<[number, number]>,
  R: number,
  gain: number,
  dotMass: number,
  opts?: { bins?: number; extent?: number },
): PsfStats {
  const bins = opts?.bins ?? 24
  const extent = opts?.extent ?? 1.6 // measure out to 1.6R (a square reaches 1.414R)
  const half = Math.ceil(R * extent) + 2
  const binMassAbs = new Float64Array(bins)
  const binArea = new Float64Array(bins)
  // wedge accumulators: 0 = axis (+-22.5 deg around 0/90/180/270), 1 = diagonal
  const wedgeMass = [0, 0]
  const wedgeMassR = [0, 0]
  let total = 0
  let clip = 0
  let px = 0
  let peak = 0

  for (const img of imgs)
  for (const [cx, cy] of centers) {
    for (let dy = -half; dy <= half; dy++) {
      const y = cy + dy
      if (y < 0 || y >= img.height) continue
      for (let dx = -half; dx <= half; dx++) {
        const x = cx + dx
        if (x < 0 || x >= img.width) continue
        const i = (y * img.width + x) * 4
        const g = img.data[i + 1]
        if (g >= 255) clip++
        px++
        // 8-bit SQRT-companded, gain-amplified (see frostPsfEgressPass):
        // undo the compander, then the gain, to recover linear mass per pixel.
        const e = g / 255
        const m = (e * e) / gain
        if (m > peak) peak = m
        total += m
        const rr = Math.sqrt(dx * dx + dy * dy) / R
        if (rr >= extent) continue
        const b = Math.min(bins - 1, Math.floor((rr / extent) * bins))
        binMassAbs[b] += m
        // annulus area in R^2 units
        if (binArea[b] === 0) {
          const r0 = (b / bins) * extent
          const r1 = ((b + 1) / bins) * extent
          binArea[b] = Math.PI * (r1 * r1 - r0 * r0)
        }
        if (rr > 0.05) {
          const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 90 // fold into [0,90)
          const isDiag = ang >= 22.5 && ang < 67.5
          const k = isDiag ? 1 : 0
          wedgeMass[k] += m
          wedgeMassR[k] += m * rr
        }
      }
    }
  }

  const emitted = imgs.length * centers.length * dotMass
  const massCaptured = emitted > 0 ? total / emitted : 0
  const norm = total > 0 ? 1 / total : 0
  const binMass = Array.from(binMassAbs, (m) => m * norm)
  const binR = Array.from({ length: bins }, (_, b) => ((b + 0.5) / bins) * extent)
  // ideal disc: uniform density inside r<1, so mass fraction per bin = area/pi
  const idealDisc = binR.map((_, b) => {
    const r0 = (b / bins) * extent
    const r1 = ((b + 1) / bins) * extent
    const lo = Math.min(r0, 1)
    const hi = Math.min(r1, 1)
    return hi > lo ? (hi * hi - lo * lo) / 1 : 0
  })
  // matched Gaussian: disc radius R has per-axis Var = R^2/4, sigma = R/2, so in
  // R units sigma = 0.5. Radial mass density 2r/(2 s^2) exp(-r^2/(2 s^2)).
  const s = 0.5
  const idealGauss = binR.map((_, b) => {
    const r0 = (b / bins) * extent
    const r1 = ((b + 1) / bins) * extent
    return Math.exp(-(r0 * r0) / (2 * s * s)) - Math.exp(-(r1 * r1) / (2 * s * s))
  })
  const gSum = idealGauss.reduce((a, b) => a + b, 0) || 1

  const density = binMass.map((m, b) => (binArea[b] > 0 ? (m / binArea[b]) * Math.PI : 0))
  const ringiness = relRingRms(density.filter((_, b) => binR[b] < 0.9))

  // Core vs bulk DENSITY (mass / area), both measured, so the comparison is
  // shape-relative and a uniform square scores the same as a uniform disc.
  let coreMass = 0
  let coreArea = 0
  let bulkMass = 0
  let bulkArea = 0
  for (let b = 0; b < bins; b++) {
    if (binR[b] < 0.3) {
      coreMass += binMass[b]
      coreArea += binArea[b]
    } else if (binR[b] > 0.35 && binR[b] < 0.9) {
      bulkMass += binMass[b]
      bulkArea += binArea[b]
    }
  }
  const coreDens = coreArea > 0 ? coreMass / coreArea : 0
  const bulkDens = bulkArea > 0 ? bulkMass / bulkArea : 0

  let outside = 0
  for (let b = 0; b < bins; b++) if (binR[b] > 1.05) outside += binMass[b]

  return {
    binR,
    binMass,
    binDensity: density,
    squareness: wedgeMass[0] > 0 && wedgeMass[1] > 0 ? wedgeMassR[1] / wedgeMass[1] / (wedgeMassR[0] / wedgeMass[0]) : 0,
    holeDeficit: bulkDens > 1e-12 ? 1 - coreDens / bulkDens : 0,
    massOutsideR: outside,
    profileL1Disc: l1(binMass, idealDisc),
    profileL1Gauss: l1(binMass, idealGauss.map((g) => g / gSum)),
    ringiness,
    clipFraction: px ? clip / px : 0,
    massCaptured,
    peakLinear: peak,
  }
}

function l1(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - (b[i] ?? 0))
  return s
}

function relRingRms(density: number[]): number {
  if (density.length < 5) return 0
  const mean = density.reduce((a, b) => a + b, 0) / density.length
  if (mean < 1e-9) return 0
  let sq = 0
  let n = 0
  for (let i = 1; i < density.length - 1; i++) {
    const m = median3(density[i - 1], density[i], density[i + 1])
    sq += (density[i] - m) ** 2
    n++
  }
  return n ? Math.sqrt(sq / n) / mean : 0
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

// ===========================================================================
// 3. Helpers
// ===========================================================================

/** Subtract a separable (2r+1) box mean. Preserves structure of period <= 2r. */
export function boxHighPass(v: Float64Array, w: number, h: number, r: number): Float64Array {
  const win = 2 * r + 1
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let t = -r; t <= r; t++) s += v[y * w + cl(x + t, w - 1)]
      tmp[y * w + x] = s / win
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let t = -r; t <= r; t++) s += tmp[cl(y + t, h - 1) * w + x]
      out[y * w + x] = v[y * w + x] - s / win
    }
  return out
}

function cl(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v
}

function shiftedPearson(v: Float64Array, w: number, h: number, dx: number, dy: number): number {
  let sa = 0
  let sb = 0
  let n = 0
  for (let y = 0; y + dy < h; y++)
    for (let x = 0; x + dx < w; x++) {
      sa += v[y * w + x]
      sb += v[(y + dy) * w + (x + dx)]
      n++
    }
  if (n < 64) return 0
  const ma = sa / n
  const mb = sb / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let y = 0; y + dy < h; y++)
    for (let x = 0; x + dx < w; x++) {
      const da = v[y * w + x] - ma
      const db = v[(y + dy) * w + (x + dx)] - mb
      sab += da * db
      saa += da * da
      sbb += db * db
    }
  if (saa < 1e-12 || sbb < 1e-12) return 0
  return sab / Math.sqrt(saa * sbb)
}

/** Remove the mean and a running box mean of width `win`. */
function detrend1d(v: ArrayLike<number>, win: number): Float64Array {
  const n = v.length
  const out = new Float64Array(n)
  const r = Math.max(1, Math.floor(win / 2))
  for (let i = 0; i < n; i++) {
    let s = 0
    let k = 0
    for (let t = -r; t <= r; t++) {
      const j = i + t
      if (j < 0 || j >= n) continue
      s += v[j]
      k++
    }
    out[i] = v[i] - s / k
  }
  return out
}

/** Fourier amplitude of `v` at period p, scaled so a pure cosine of amplitude A reads A. */
function goertzelAmp(v: ArrayLike<number>, p: number): number {
  const n = v.length
  if (n < 4 * p) return 0
  let c = 0
  let s = 0
  const wv = (2 * Math.PI) / p
  for (let i = 0; i < n; i++) {
    c += v[i] * Math.cos(wv * i)
    s += v[i] * Math.sin(wv * i)
  }
  return (2 / n) * Math.sqrt(c * c + s * s)
}
