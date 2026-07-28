/**
 * Edge-quality metrics for the Phase 10 reeded-glass antialiasing bake-off.
 *
 * Everything here is pure CPU and deterministic. Each metric ships with the
 * synthetic known-good / known-bad fixture that calibrates it (bottom of the
 * file) — the bench refuses to report a number from a metric whose controls
 * have not separated, because this project has repeatedly been burned by gates
 * that fired on the reference.
 *
 * Units: every error is reported in 8-BIT CODES (0..255) unless the name says
 * `Px`, in which case it is DEVICE PIXELS. No linearisation is applied: the
 * engine's intermediates are rgba8unorm and its own averaging happens in that
 * space, so ground truth is defined in that space too.
 *
 * Per-pixel error is the WORST channel: max(|dR|, |dG|, |dB|). Alpha is
 * excluded (every candidate is opaque-in/opaque-out here and a premultiplied
 * alpha diff would double-count the colour error).
 */

import type { Rgba8 } from './image'

// ---------------------------------------------------------------------------
// Basic fields
// ---------------------------------------------------------------------------

/** Rec.709 luma of the 8-bit codes, no linearisation. */
export function lumaField(img: Rgba8): Float32Array {
  const n = img.width * img.height
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    out[i] = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
  }
  return out
}

export interface DiffStats {
  /** mean worst-channel |delta|, in codes */
  mean: number
  /** 95th percentile worst-channel |delta|, in codes (integer) */
  p95: number
  /** 99th percentile, in codes (integer) */
  p99: number
  /** max worst-channel |delta|, in codes */
  max: number
  /** number of pixels the statistic was taken over */
  n: number
}

const EMPTY_DIFF: DiffStats = { mean: 0, p95: 0, p99: 0, max: 0, n: 0 }

/**
 * Worst-channel absolute difference, optionally restricted to a mask.
 * Percentiles come from an exact 0..255 histogram (errors are integers).
 */
export function maskedDiff(a: Rgba8, b: Rgba8, mask?: Uint8Array | null): DiffStats {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`maskedDiff: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  const np = a.width * a.height
  const hist = new Uint32Array(256)
  let n = 0
  let sum = 0
  let max = 0
  for (let i = 0; i < np; i++) {
    if (mask && !mask[i]) continue
    const o = i * 4
    let e = Math.abs(a.data[o] - b.data[o])
    const g = Math.abs(a.data[o + 1] - b.data[o + 1])
    if (g > e) e = g
    const bl = Math.abs(a.data[o + 2] - b.data[o + 2])
    if (bl > e) e = bl
    hist[e]++
    sum += e
    n++
    if (e > max) max = e
  }
  if (n === 0) return { ...EMPTY_DIFF }
  const pct = (q: number): number => {
    const target = q * n
    let cum = 0
    for (let v = 0; v < 256; v++) {
      cum += hist[v]
      if (cum >= target) return v
    }
    return 255
  }
  return { mean: sum / n, p95: pct(0.95), p99: pct(0.99), max, n }
}

/** Mean |4-neighbour Laplacian| of luma over the interior — a high-frequency energy proxy. */
export function hfEnergy(img: Rgba8, margin = 2): number {
  const { width: w, height: h } = img
  const L = lumaField(img)
  let sum = 0
  let n = 0
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x
      sum += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w])
      n++
    }
  }
  return n === 0 ? 0 : sum / n
}

export interface GlobalFidelity extends DiffStats {
  /** 1 - hf(candidate)/hf(groundTruth). >0 = blurrier than ground truth. */
  hfLoss: number
  hfCandidate: number
  hfGroundTruth: number
}

/**
 * Whole-frame deviation from ground truth plus a blur penalty. The blur
 * penalty is what catches a candidate that "fixes" the seam by softening the
 * entire image: its whole-frame error may look modest while hfLoss goes large.
 */
export function globalFidelity(cand: Rgba8, gt: Rgba8): GlobalFidelity {
  const d = maskedDiff(cand, gt, null)
  const hc = hfEnergy(cand)
  const hg = hfEnergy(gt)
  return { ...d, hfCandidate: hc, hfGroundTruth: hg, hfLoss: hg === 0 ? 0 : 1 - hc / hg }
}

// ---------------------------------------------------------------------------
// Seam geometry, recovered from the GPU probe pass
// ---------------------------------------------------------------------------

export interface SeamField {
  width: number
  height: number
  /** signed distance from the pixel centre to the nearest seam, in device px */
  dist: Float32Array
  /** unit seam normal (direction of increasing rib index), fragCoord space */
  nx: Float32Array
  ny: Float32Array
}

/**
 * Decode the probe pass: R = signed distance mapped from [-range, +range],
 * G/B = the seam normal mapped from [-1, 1].
 */
export function decodeSeamField(img: Rgba8, rangePx: number): SeamField {
  const n = img.width * img.height
  const dist = new Float32Array(n)
  const nx = new Float32Array(n)
  const ny = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    dist[i] = (img.data[o] / 255 - 0.5) * 2 * rangePx
    nx[i] = (img.data[o + 1] / 255) * 2 - 1
    ny[i] = (img.data[o + 2] / 255) * 2 - 1
  }
  return { width: img.width, height: img.height, dist, nx, ny }
}

/** 1 where |signed distance| <= bandPx and the pixel is `margin` px inside the frame. */
export function seamBand(f: SeamField, bandPx: number, margin = 8): Uint8Array {
  const { width: w, height: h, dist } = f
  const mask = new Uint8Array(w * h)
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const i = y * w + x
      if (Math.abs(dist[i]) <= bandPx) mask[i] = 1
    }
  }
  return mask
}

export function maskFraction(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n / mask.length
}

export function maskCount(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++
  return n
}

/**
 * The axis along which the signed distance changes fastest — i.e. the axis a
 * scanline must run on to cross the seams.
 */
export function seamScanAxis(f: SeamField, margin = 12): 'x' | 'y' {
  const { width: w, height: h, dist } = f
  let sx = 0
  let sy = 0
  for (let y = margin; y < h - margin; y += 3) {
    for (let x = margin; x < w - margin; x += 3) {
      const i = y * w + x
      if (Math.abs(dist[i]) > 3) continue
      sx += Math.abs(dist[i + 1] - dist[i - 1])
      sy += Math.abs(dist[i + w] - dist[i - w])
    }
  }
  return sx >= sy ? 'x' : 'y'
}

/**
 * Sub-pixel positions where the signed distance crosses zero on one scanline.
 * Sign flips at the +-clamp of the probe (mid-way between two seams) are
 * rejected — they are the wrap of `floor(phi + 0.5)`, not a seam.
 */
export function seamCrossingsOnLine(
  f: SeamField, axis: 'x' | 'y', outer: number, margin: number, skip = 0,
): number[] {
  const { width: w, height: h, dist } = f
  const inner = axis === 'x' ? w : h
  const idx = (t: number): number => (axis === 'x' ? outer * w + t : t * w + outer)
  void h
  const out: number[] = []
  for (let t = margin; t < inner - margin - 1; t++) {
    const d0 = dist[idx(t)]
    const d1 = dist[idx(t + 1)]
    if (d0 === d1) continue
    if ((d0 > 0) === (d1 > 0)) continue
    if (Math.abs(d0) > 4 || Math.abs(d1) > 4) continue
    out.push(t + d0 / (d0 - d1))
    t += skip
  }
  return out
}

export interface SeamSpacing {
  /** mean distance between consecutive seams along the scan axis, px */
  meanPeriodPx: number
  /** mean number of seams crossed per scanline */
  crossingsPerScan: number
  /** number of scanlines sampled */
  scans: number
  scanAxis: 'x' | 'y'
}

/**
 * Measure the on-screen rib period straight from the probe. Used to gate the
 * analytic period formula (which the taper candidate and the adaptive
 * fetch-count prediction both depend on) against the GPU.
 */
export function seamSpacing(f: SeamField, margin = 12): SeamSpacing {
  const axis = seamScanAxis(f, margin)
  const outerN = axis === 'x' ? f.height : f.width
  let gapSum = 0
  let gapN = 0
  let crossSum = 0
  let scans = 0
  for (let o = margin; o < outerN - margin; o++) {
    const cs = seamCrossingsOnLine(f, axis, o, margin)
    crossSum += cs.length
    scans++
    for (let i = 1; i < cs.length; i++) { gapSum += cs[i] - cs[i - 1]; gapN++ }
  }
  return {
    meanPeriodPx: gapN === 0 ? 0 : gapSum / gapN,
    crossingsPerScan: scans === 0 ? 0 : crossSum / scans,
    scans,
    scanAxis: axis,
  }
}

// ---------------------------------------------------------------------------
// STAIRCASE
// ---------------------------------------------------------------------------

export interface StaircaseResult {
  /**
   * Standard deviation, in device px, of the residual between the sub-pixel
   * seam position recovered from the image and the analytic seam position.
   *
   * A hard but perfectly straight edge scores ~0 (the residual is a constant
   * offset, which the std removes) — by design, because a straight hard edge
   * needs a different fix from a jagged one. A staircased edge scores ~0.29
   * (the std of a uniform quantisation error over one pixel).
   */
  rmsPx: number
  /** mean residual, px — the systematic profile bias, reported for context */
  biasPx: number
  /** number of scanline crossings that carried enough contrast to measure */
  n: number
  /** number of crossings rejected because the window was content-dominated */
  rejected: number
  scanAxis: 'x' | 'y'
  /**
   * Median over accepted crossings of (seam gradient peak) / (median background
   * gradient in the same window). Reported for context only — measured NOT to
   * discriminate usable from unusable content (see `minPeakToBackground`).
   */
  peakToBackground: number
  /**
   * False when the measurement is not about the seam.
   *
   * On a detailed photo the strongest luma gradient inside a +-3 px window is
   * usually photo detail, not the rib seam, and the centroid then wanders by
   * ~0.5 px for EVERY candidate including ground truth — a plausible-looking
   * number that means nothing. When this is false the caller must report N/A,
   * not the number. Gate M2c holds this behaviour in place.
   */
  valid: boolean
}

export interface StaircaseOpts {
  /** half-width of the gradient window, px */
  halfWindow?: number
  /** minimum summed gradient weight (codes) for a crossing to count */
  minContrast?: number
  /** frame margin to avoid clamp-to-edge effects */
  margin?: number
  /**
   * Reject a crossing whose peak-to-background gradient ratio is below this.
   * Default 0 = off.
   *
   * MEASURED, and the reason it is off: ratio does NOT separate usable from
   * unusable content (ramp 40-56, blurred photo 25-47, raw photo 14-26 — fully
   * overlapping). What actually limits the estimator is background ASYMMETRY
   * across the window, not background magnitude. The bench therefore measures
   * the estimator's noise floor directly (same config with the seam forced
   * axis-aligned, where a staircase is geometrically impossible) and subtracts
   * it in quadrature, instead of gating on a ratio that does not discriminate.
   */
  minPeakToBackground?: number
}

/**
 * Recover the sub-pixel seam position per scanline by gradient centroid, and
 * report how much it wobbles relative to the analytically-known seam position.
 *
 * Scanning direction is chosen from the seam field itself: the axis along which
 * the signed distance changes fastest is the axis the seam is crossed on.
 */
export function staircase(img: Rgba8, f: SeamField, opts: StaircaseOpts = {}): StaircaseResult {
  const halfWindow = opts.halfWindow ?? 3
  const minContrast = opts.minContrast ?? 6
  const margin = opts.margin ?? 12
  const minP2B = opts.minPeakToBackground ?? 0
  const { width: w, height: h, dist } = f
  if (img.width !== w || img.height !== h) throw new Error('staircase: seam field size mismatch')
  const L = lumaField(img)
  const scanAxis = seamScanAxis(f, margin)

  // Walk perpendicular to the seam, locate crossings sub-pixel from `dist`,
  // and compare with the gradient centroid of the image there.
  const residuals: number[] = []
  const p2bs: number[] = []
  let rejected = 0

  const outer = scanAxis === 'x' ? h : w
  const inner = scanAxis === 'x' ? w : h
  const idx = (o: number, t: number): number => (scanAxis === 'x' ? o * w + t : t * w + o)
  void dist

  for (let o = margin; o < outer - margin; o++) {
    for (const tTrue of seamCrossingsOnLine(f, scanAxis, o, margin, halfWindow)) {
      // gradient magnitudes at half-integer positions inside the window
      const lo = Math.round(tTrue) - halfWindow
      const hi = Math.round(tTrue) + halfWindow
      if (lo < 1 || hi + 1 >= inner - 1) continue
      let base = Infinity
      const gs: number[] = []
      for (let k = lo; k <= hi; k++) {
        const g = Math.abs(L[idx(o, k + 1)] - L[idx(o, k)])
        gs.push(g)
        if (g < base) base = g
      }
      // Is the seam actually the dominant feature in this window? If the
      // strongest gradient is somewhere else, or is not clear of the local
      // background, the centroid is measuring content and not the edge.
      let peak = -Infinity
      let peakAt = 0
      for (let k = 0; k < gs.length; k++) if (gs[k] > peak) { peak = gs[k]; peakAt = lo + k + 0.5 }
      const med = [...gs].sort((a, b) => a - b)[gs.length >> 1]
      if (peak - base < minContrast || peak < 3 * med || Math.abs(peakAt - tTrue) > 1.5) {
        rejected++
        continue
      }
      let wsum = 0
      let psum = 0
      for (let k = lo; k <= hi; k++) {
        const wgt = gs[k - lo] - base
        wsum += wgt
        psum += (k + 0.5) * wgt
      }
      if (wsum < minContrast) { rejected++; continue }
      p2bs.push((peak - base) / Math.max(med - base, 0.25))
      residuals.push(psum / wsum - tTrue)
    }
  }

  const total = residuals.length + rejected
  const p2b = p2bs.length === 0 ? 0 : [...p2bs].sort((a, b) => a - b)[p2bs.length >> 1]
  const valid = residuals.length >= 64 && total > 0 && rejected / total < 0.4 && p2b >= minP2B
  if (residuals.length < 8) {
    return { rmsPx: 0, biasPx: 0, n: residuals.length, rejected, scanAxis, peakToBackground: p2b, valid: false }
  }
  let mean = 0
  for (const r of residuals) mean += r
  mean /= residuals.length
  let varSum = 0
  for (const r of residuals) varSum += (r - mean) * (r - mean)
  return {
    rmsPx: Math.sqrt(varSum / residuals.length),
    biasPx: mean,
    n: residuals.length,
    rejected,
    scanAxis,
    peakToBackground: p2b,
    valid,
  }
}

// ---------------------------------------------------------------------------
// TEMPORAL (edge crawl)
// ---------------------------------------------------------------------------

export interface TemporalResult {
  /**
   * Mean over consecutive frame pairs, over seam-band pixels, of
   * |(C[i+1]-C[i]) - (G[i+1]-G[i])| in codes. Ground truth scores exactly 0 by
   * construction; a candidate whose seam snaps between pixels while the true
   * seam slides smoothly scores high.
   */
  crawl: number
  crawlP95: number
  /** raw frame-to-frame energy of the candidate in the band, codes */
  rawCandidate: number
  /** raw frame-to-frame energy of ground truth in the band, codes — the floor */
  rawGroundTruth: number
  frames: number
}

export function temporalCrawl(cand: Rgba8[], gt: Rgba8[], masks: Uint8Array[]): TemporalResult {
  if (cand.length !== gt.length) throw new Error('temporalCrawl: frame count mismatch')
  if (cand.length < 2) throw new Error('temporalCrawl: need >= 2 frames')
  const hist = new Uint32Array(1024)
  let n = 0
  let sum = 0
  let rawC = 0
  let rawG = 0
  for (let fI = 0; fI + 1 < cand.length; fI++) {
    const a0 = cand[fI], a1 = cand[fI + 1]
    const b0 = gt[fI], b1 = gt[fI + 1]
    // Union of the two frames' bands: the seam moves between them.
    const m0 = masks[fI], m1 = masks[fI + 1]
    const np = a0.width * a0.height
    for (let i = 0; i < np; i++) {
      if (!m0[i] && !m1[i]) continue
      const o = i * 4
      let e = 0
      let rc = 0
      let rg = 0
      for (let c = 0; c < 3; c++) {
        const dc = a1.data[o + c] - a0.data[o + c]
        const dg = b1.data[o + c] - b0.data[o + c]
        const d = Math.abs(dc - dg)
        if (d > e) e = d
        if (Math.abs(dc) > rc) rc = Math.abs(dc)
        if (Math.abs(dg) > rg) rg = Math.abs(dg)
      }
      hist[Math.min(1023, e)]++
      sum += e
      rawC += rc
      rawG += rg
      n++
    }
  }
  if (n === 0) return { crawl: 0, crawlP95: 0, rawCandidate: 0, rawGroundTruth: 0, frames: cand.length }
  let cum = 0
  let p95 = 0
  for (let v = 0; v < 1024; v++) {
    cum += hist[v]
    if (cum >= 0.95 * n) { p95 = v; break }
  }
  return {
    crawl: sum / n,
    crawlP95: p95,
    rawCandidate: rawC / n,
    rawGroundTruth: rawG / n,
    frames: cand.length,
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixtures — the known-good / known-bad every metric is gated on
// ---------------------------------------------------------------------------

export interface SyntheticEdge {
  img: Rgba8
  field: SeamField
}

/**
 * An oblique step edge at x = x0 + slope*y.
 *
 *  mode 'coverage' — exact 1-D box coverage along the edge normal. This is the
 *                    KNOWN-GOOD: the gradient centroid lands on the true
 *                    sub-pixel position on every scanline.
 *  mode 'binary'   — 1-bit rasterised at pixel centres. This is the KNOWN-BAD:
 *                    the centroid is pinned to pixel boundaries, so the
 *                    residual is the quantisation error (std -> 1/sqrt(12)).
 */
export function syntheticObliqueEdge(
  width: number,
  height: number,
  o: { x0: number; slope: number; lo?: number; hi?: number; mode: 'coverage' | 'binary' },
): SyntheticEdge {
  const lo = o.lo ?? 60
  const hi = o.hi ?? 200
  const data = new Uint8ClampedArray(width * height * 4)
  const dist = new Float32Array(width * height)
  const nxA = new Float32Array(width * height)
  const nyA = new Float32Array(width * height)
  // line: x - slope*y - x0 = 0 ; normal (1, -slope)/norm
  const norm = Math.hypot(1, o.slope)
  const nx = 1 / norm
  const ny = -o.slope / norm
  // support of a unit square projected on the normal
  const wsup = Math.abs(nx) + Math.abs(ny)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const d = (x - o.slope * y - o.x0) / norm
      dist[i] = Math.max(-8, Math.min(8, d))
      nxA[i] = nx
      nyA[i] = ny
      let v: number
      if (o.mode === 'binary') {
        v = d > 0 ? hi : lo
      } else {
        const cov = Math.max(0, Math.min(1, 0.5 + d / wsup))
        v = lo + (hi - lo) * cov
      }
      const q = Math.round(v)
      const off = i * 4
      data[off] = q; data[off + 1] = q; data[off + 2] = q; data[off + 3] = 255
    }
  }
  return {
    img: { width, height, data },
    field: { width, height, dist, nx: nxA, ny: nyA },
  }
}

/** Uniformly offset every RGB code by `codes` — calibrates the code scale. */
export function offsetCodes(img: Rgba8, codes: number): Rgba8 {
  const data = new Uint8ClampedArray(img.data)
  for (let i = 0; i < data.length; i += 4) {
    data[i] += codes; data[i + 1] += codes; data[i + 2] += codes
  }
  return { width: img.width, height: img.height, data }
}

/** 3x3 box blur — the known-bad for the blur penalty in globalFidelity. */
export function boxBlur3(img: Rgba8): Rgba8 {
  const { width: w, height: h } = img
  const data = new Uint8ClampedArray(img.data)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) s += img.data[((y + dy) * w + (x + dx)) * 4 + c]
        }
        data[(y * w + x) * 4 + c] = Math.round(s / 9)
      }
    }
  }
  return { width: w, height: h, data }
}
