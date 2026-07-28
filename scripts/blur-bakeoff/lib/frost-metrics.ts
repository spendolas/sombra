// Metrics for the frost target-look study. Everything is reported in 8-bit sRGB
// CODES, additively — no ratios against a near-zero baseline, because this
// project has repeatedly been burned by ratio metrics that fire on the
// known-good reference. Every metric here is validated in phase9-target.ts
// against a synthetic known-good AND a synthetic known-bad before it is used.
//
// All metrics take an explicit ROI so edge policy (clamp vs mirror) can be
// excluded from the comparison: the callers inset by the largest blur radius.

import type { Rgba8 } from './image'

export interface Roi {
  x0: number
  y0: number
  x1: number // exclusive
  y1: number // exclusive
}

export function insetRoi(w: number, h: number, m: number): Roi {
  return { x0: m, y0: m, x1: Math.max(m + 1, w - m), y1: Math.max(m + 1, h - m) }
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722

/** Luma in 8-bit codes over the ROI, as a dense (roiW x roiH) array. */
export function lumaRoi(img: Rgba8, roi: Roi): { w: number; h: number; v: Float64Array } {
  const w = roi.x1 - roi.x0
  const h = roi.y1 - roi.y0
  const v = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((y + roi.y0) * img.width + (x + roi.x0)) * 4
      v[y * w + x] = LR * img.data[i] + LG * img.data[i + 1] + LB * img.data[i + 2]
    }
  return { w, h, v }
}

// ---------------------------------------------------------------------------
// Deviation between two images, in 8-bit codes.
// ---------------------------------------------------------------------------
export interface Deviation {
  meanAbs: number
  p99Abs: number
  maxAbs: number
  rms: number
  alphaMeanAbs: number
  alphaMaxAbs: number
  /**
   * RGB stats restricted to pixels where BOTH images have alpha >= ALPHA_FLOOR.
   * In a near-transparent pixel the straight-alpha RGB is the 0/0 of the
   * premultiplied pipeline — it is invisible on screen but can read as a
   * 255-code "error". On an opaque image these equal the unrestricted stats.
   */
  coveredMeanAbs: number
  coveredP99Abs: number
  coveredMaxAbs: number
  coveredFraction: number
}

/** 8-bit alpha below this makes straight-alpha RGB meaningless. */
export const ALPHA_FLOOR = 8

export function deviation(a: Rgba8, b: Rgba8, roi: Roi): Deviation {
  // Both operands are 8-bit, so |a-b| is an integer in [0,255]: a 256-bin
  // histogram gives an exact percentile without sorting a million floats.
  const hist = new Int32Array(256)
  const cHist = new Int32Array(256)
  let sum = 0, sq = 0, max = 0, n = 0
  let cSum = 0, cMax = 0, cN = 0, cPx = 0, px = 0
  let aSum = 0, aMax = 0, aN = 0
  for (let y = roi.y0; y < roi.y1; y++)
    for (let x = roi.x0; x < roi.x1; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      const covered = a.data[ia + 3] >= ALPHA_FLOOR && b.data[ib + 3] >= ALPHA_FLOOR
      px++
      if (covered) cPx++
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[ia + c] - b.data[ib + c])
        sum += d; sq += d * d; n++
        if (d > max) max = d
        hist[d]++
        if (covered) {
          cSum += d; cN++
          if (d > cMax) cMax = d
          cHist[d]++
        }
      }
      const da = Math.abs(a.data[ia + 3] - b.data[ib + 3])
      aSum += da; aN++
      if (da > aMax) aMax = da
    }
  return {
    meanAbs: n ? sum / n : 0,
    p99Abs: percentile(hist, n, 0.99),
    maxAbs: max,
    rms: n ? Math.sqrt(sq / n) : 0,
    alphaMeanAbs: aN ? aSum / aN : 0,
    alphaMaxAbs: aMax,
    coveredMeanAbs: cN ? cSum / cN : 0,
    coveredP99Abs: percentile(cHist, cN, 0.99),
    coveredMaxAbs: cMax,
    coveredFraction: px ? cPx / px : 0,
  }
}

function percentile(hist: Int32Array, n: number, q: number): number {
  if (!n) return 0
  const cut = Math.floor(n * q)
  let acc = 0
  for (let d = 0; d < 256; d++) { acc += hist[d]; if (acc > cut) return d }
  return 255
}

// ---------------------------------------------------------------------------
// Block-edge excess: the "pixelation" detector.
//
// mean |luma step| across a block boundary  MINUS  mean |luma step| inside a
// block, in 8-bit codes. Additive, so it reads 0 on any image with no block
// structure regardless of how much detail the image has — including a flat one,
// where both terms are 0 and the difference is exactly 0 (no division).
//
// A block-averaged image has zero internal steps and large boundary steps, so
// this goes strongly positive. Random per-pixel noise raises BOTH terms
// equally, so it stays ~0: the metric separates blockiness from graininess.
// ---------------------------------------------------------------------------
export interface BlockEdge {
  acrossMean: number
  withinMean: number
  excess: number
  block: number
}

export function blockEdgeExcess(img: Rgba8, block: number, roi: Roi, phase = 0): BlockEdge {
  const { w, h, v } = lumaRoi(img, roi)
  const b = Math.max(1, Math.round(block))
  let acrossSum = 0, acrossN = 0, withinSum = 0, withinN = 0
  // horizontal steps: the pair (x-1, x) straddles a boundary when x is the
  // first column of a block, in ABSOLUTE image coords (phase matters).
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++) {
      const abs = x + roi.x0 - phase
      const d = Math.abs(v[y * w + x] - v[y * w + x - 1])
      if (((abs % b) + b) % b === 0) { acrossSum += d; acrossN++ } else { withinSum += d; withinN++ }
    }
  for (let y = 1; y < h; y++)
    for (let x = 0; x < w; x++) {
      const abs = y + roi.y0 - phase
      const d = Math.abs(v[y * w + x] - v[(y - 1) * w + x])
      if (((abs % b) + b) % b === 0) { acrossSum += d; acrossN++ } else { withinSum += d; withinN++ }
    }
  const acrossMean = acrossN ? acrossSum / acrossN : 0
  const withinMean = withinN ? withinSum / withinN : 0
  return { acrossMean, withinMean, excess: acrossMean - withinMean, block: b }
}

// ---------------------------------------------------------------------------
// Block coherence: an independent confirmation of block structure.
//
// High-pass the luma (subtract a (2b+1)-wide box mean, so a block-sized plateau
// SURVIVES the high-pass), then take the Pearson correlation of horizontally
// adjacent residual pairs, split into pairs that lie inside one block and pairs
// that straddle a boundary. No block structure -> the two are equal. Block
// structure -> within is ~1.0 (identical values) and across collapses.
//
// Returns null for either term when its sample has no variance (a flat image),
// rather than dividing by ~0 and reporting a garbage correlation.
// ---------------------------------------------------------------------------
export interface BlockCoherence {
  within: number | null
  across: number | null
  drop: number | null
  block: number
}

export function blockCoherence(img: Rgba8, block: number, roi: Roi, phase = 0): BlockCoherence {
  const { w, h, v } = lumaRoi(img, roi)
  const b = Math.max(1, Math.round(block))
  const res = highPass(v, w, h, b) // window 2b+1
  const withinA: number[] = [], withinB: number[] = []
  const acrossA: number[] = [], acrossB: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 1; x < w; x++) {
      const abs = x + roi.x0 - phase
      const p = res[y * w + x - 1], q = res[y * w + x]
      if (((abs % b) + b) % b === 0) { acrossA.push(p); acrossB.push(q) } else { withinA.push(p); withinB.push(q) }
    }
  const within = pearson(withinA, withinB)
  const across = pearson(acrossA, acrossB)
  return { within, across, drop: within !== null && across !== null ? within - across : null, block: b }
}

function highPass(v: Float64Array, w: number, h: number, b: number): Float64Array {
  const win = 2 * b + 1
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let t = -b; t <= b; t++) s += v[y * w + clamp(x + t, w - 1)]
      tmp[y * w + x] = s / win
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let t = -b; t <= b; t++) s += tmp[clamp(y + t, h - 1) * w + x]
      out[y * w + x] = v[y * w + x] - s / win
    }
  return out
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length
  if (n < 32) return null
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb
    sab += da * db; saa += da * da; sbb += db * db
  }
  // guard: an essentially constant sample has no meaningful correlation
  if (Math.sqrt(saa / n) < 1e-4 || Math.sqrt(sbb / n) < 1e-4) return null
  return sab / Math.sqrt(saa * sbb)
}

// ---------------------------------------------------------------------------
// Speckle: RMS of the luma high-pass over a small window, in 8-bit codes.
// A converged blur has almost no energy above the kernel's cutoff, so this is
// small; a sparse-tap estimator's per-pixel variance lands squarely in this
// band. Independent of blockEdgeExcess by construction (validated).
// ---------------------------------------------------------------------------
export function speckleRms(img: Rgba8, roi: Roi, win = 5): number {
  const { w, h, v } = lumaRoi(img, roi)
  const r = Math.max(1, Math.floor(win / 2))
  const res = highPass(v, w, h, r)
  let sq = 0
  for (let i = 0; i < res.length; i++) sq += res[i] * res[i]
  return Math.sqrt(sq / res.length)
}

// ---------------------------------------------------------------------------
// Directional correlation of the fine-grain residual.
//
// A good scatter's grain should be WHITE: no preferred direction. A hash with
// structure produces oriented streaks — visible as moire — even though its
// per-pixel histogram looks fine. Lag-1 Pearson correlation of the luma
// high-pass along 0/45/90/135 degrees; `anisotropy` is max - min across the
// four, so it is 0 for white noise and for any isotropic image, and large only
// when one orientation is privileged. Additive, not a ratio.
// ---------------------------------------------------------------------------
export interface DirectionalCorr {
  c0: number | null
  c45: number | null
  c90: number | null
  c135: number | null
  anisotropy: number | null
}

export function directionalCorr(img: Rgba8, roi: Roi, win = 5): DirectionalCorr {
  const { w, h, v } = lumaRoi(img, roi)
  const r = Math.max(1, Math.floor(win / 2))
  const res = highPass(v, w, h, r)
  const dirs: Array<[number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1]]
  const out: Array<number | null> = []
  for (const [dx, dy] of dirs) {
    const a: number[] = [], b: number[] = []
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        a.push(res[y * w + x])
        b.push(res[(y + dy) * w + (x + dx)])
      }
    out.push(pearson(a, b))
  }
  const vals = out.filter((x): x is number => x !== null)
  return {
    c0: out[0], c45: out[1], c90: out[2], c135: out[3],
    anisotropy: vals.length === 4 ? Math.max(...vals) - Math.min(...vals) : null,
  }
}

function clamp(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v
}
