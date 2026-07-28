/**
 * Phase 9 probe D — do the EXISTING detectors fire on the frost failure mode?
 *
 * The reported artefact is not "constant-coloured blocks". The shipped estimator
 * keeps a per-pixel sample position and adds a jitter that is constant across a
 * lattice cell, so the output is piecewise-SMOOTH with discontinuities on the
 * cell boundaries. That is a different signal from banding or from progressive
 * blur stepping, and a detector aimed at those may not see it at all.
 *
 * Known-bad  : block-constant displacement, period 8 px
 * Known-good : per-pixel displacement, same amplitude, 64 taps (converged)
 * Control    : identity (no displacement)
 *
 * Every detector below is scored on all three. A detector that does not order
 * them (bad > good ≈ control, or the reverse for smoothness metrics) is useless
 * for this bench and must not be adopted.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-detector-calibration.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Rgba8 } from './lib/image'
import { bandingScore, transitionStepping, rampSteppingScore } from './lib/detectors'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')
const N = 256
const BLOCK = 8
const AMP = 6 // jitter half-extent, px

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Photo-ish base: a few octaves of smooth sinusoid, plus a hard edge. */
function base(): Float64Array {
  const f = new Float64Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let v = 128
      v += 50 * Math.sin((x / 37) * 2 * Math.PI) * Math.cos((y / 53) * 2 * Math.PI)
      v += 25 * Math.sin((x / 13.7) * 2 * Math.PI + 1.1)
      v += 18 * Math.cos((y / 9.3) * 2 * Math.PI + 0.4)
      if (x > N * 0.62) v = Math.min(250, v + 45)
      f[y * N + x] = Math.max(0, Math.min(255, v))
    }
  return f
}

function bilinear(f: Float64Array, x: number, y: number): number {
  const cx = Math.max(0, Math.min(N - 1.001, x))
  const cy = Math.max(0, Math.min(N - 1.001, y))
  const x0 = Math.floor(cx), y0 = Math.floor(cy)
  const fx = cx - x0, fy = cy - y0
  const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1)
  const a = f[y0 * N + x0] * (1 - fx) + f[y0 * N + x1] * fx
  const b = f[y1 * N + x0] * (1 - fx) + f[y1 * N + x1] * fx
  return a * (1 - fy) + b * fy
}

function toRgba(g: Float64Array): Rgba8 {
  const img: Rgba8 = { width: N, height: N, data: new Uint8ClampedArray(N * N * 4) }
  for (let p = 0; p < N * N; p++) {
    const v = Math.round(g[p])
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v
    img.data[p * 4 + 3] = 255
  }
  return img
}

/** taps averaged; jitter constant across `period` px (period 1 = per-pixel). */
function gather(f: Float64Array, taps: number, period: number, amp: number, seed: number): Rgba8 {
  const g = new Float64Array(N * N)
  const rnd = mulberry32(seed)
  // Precompute a jitter table indexed by (cellX, cellY, tap).
  const cells = Math.ceil(N / period)
  const jit = new Float64Array(cells * cells * taps * 2)
  for (let i = 0; i < jit.length; i++) jit[i] = (rnd() * 2 - 1) * amp
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / period), cy = Math.floor(y / period)
      const b = (cy * cells + cx) * taps * 2
      let s = 0
      for (let t = 0; t < taps; t++) s += bilinear(f, x + jit[b + t * 2], y + jit[b + t * 2 + 1])
      g[y * N + x] = s / taps
    }
  return toRgba(g)
}

// ---- candidate detectors ---------------------------------------------------

function luma(img: Rgba8): Float64Array {
  const l = new Float64Array(img.width * img.height)
  for (let p = 0; p < l.length; p++)
    l[p] = 0.2126 * img.data[p * 4] + 0.7152 * img.data[p * 4 + 1] + 0.0722 * img.data[p * 4 + 2]
  return l
}

/**
 * Block-boundary ratio: mean |horizontal gradient| on columns that fall on a
 * lattice boundary, divided by the mean on all other columns. Piecewise-smooth
 * blocks concentrate their discontinuities on those columns; a converged or
 * per-pixel estimator does not, giving ~1.0. Same for rows, averaged.
 */
export function blockBoundaryRatio(img: Rgba8, period: number): number {
  const l = luma(img)
  const { width: w, height: h } = img
  let onS = 0, onN = 0, offS = 0, offN = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const gx = Math.abs(l[y * w + x] - l[y * w + x - 1])
      if (x % period === 0) { onS += gx; onN++ } else { offS += gx; offN++ }
      const gy = Math.abs(l[y * w + x] - l[(y - 1) * w + x])
      if (y % period === 0) { onS += gy; onN++ } else { offS += gy; offN++ }
    }
  const on = onN ? onS / onN : 0
  const off = offN ? offS / offN : 0
  return off > 1e-9 ? on / off : 0
}

/**
 * Speckle: median over the image of the local 3x3 standard deviation of luma,
 * in 8-bit codes. Reports per-pixel estimator variance without being dominated
 * by the content's own edges (median, not mean).
 */
export function speckle(img: Rgba8): number {
  const l = luma(img)
  const { width: w, height: h } = img
  const vals: number[] = []
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let s = 0, s2 = 0
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const v = l[(y + dy) * w + x + dx]
          s += v; s2 += v * v
        }
      vals.push(Math.sqrt(Math.max(0, s2 / 9 - (s / 9) ** 2)))
    }
  vals.sort((a, b) => a - b)
  return vals[Math.floor(vals.length / 2)]
}

/** Autocorrelation of the horizontal-gradient magnitude field at lag `k` columns. */
export function gradAutocorr(img: Rgba8, lag: number): number {
  const l = luma(img)
  const { width: w, height: h } = img
  const g: number[] = []
  for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) g.push(Math.abs(l[y * w + x] - l[y * w + x - 1]))
  const cols = w - 1
  let mu = 0
  for (const v of g) mu += v
  mu /= g.length
  let num = 0, den = 0, n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < cols - lag; x++) {
      const a = g[y * cols + x] - mu
      const b = g[y * cols + x + lag] - mu
      num += a * b; den += a * a; n++
    }
  void n
  return den > 1e-9 ? num / den : 0
}

/**
 * Footprint squareness. anisotropyScore compares mxx vs myy and is therefore
 * identically 0 for BOTH an axis-aligned square and a disc. This instead
 * compares mass-weighted mean radius in the diagonal wedges against the axis
 * wedges: a disc gives 1.0, an axis-aligned square gives >1 because its corners
 * reach sqrt(2) further. Channel R is the response magnitude, as in
 * anisotropyScore.
 */
export function squarenessScore(resp: { width: number; height: number; data: Float32Array }): number {
  const { width: w, height: h, data } = resp
  const cx = (w - 1) / 2, cy = (h - 1) / 2
  let axisS = 0, axisW = 0, diagS = 0, diagW = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = data[(y * w + x) * 4]
      if (v <= 0) continue
      const dx = x - cx, dy = y - cy
      const r = Math.hypot(dx, dy)
      if (r < 1e-6) continue
      // fold to [0,45] deg
      let a = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
      if (a > 45) a = 90 - a
      if (a <= 15) { axisS += r * v; axisW += v }
      else if (a >= 30) { diagS += r * v; diagW += v }
    }
  if (axisW <= 0 || diagW <= 0) return 0
  return diagS / diagW / (axisS / axisW)
}

async function main() {
  const f = base()
  const cases: Array<[string, Rgba8]> = [
    ['control_identity', toRgba(f)],
    ['known_good_perpixel64', gather(f, 64, 1, AMP, 11)],
    ['known_good_perpixel8', gather(f, 8, 1, AMP, 12)],
    ['known_bad_block8_taps8', gather(f, 8, BLOCK, AMP, 13)],
    ['known_bad_block4_taps8', gather(f, 8, 4, AMP, 14)],
  ]

  const rows = cases.map(([name, img]) => ({
    case: name,
    // existing detectors
    bandingScore: +bandingScore(img).toFixed(3),
    transitionStepping: +transitionStepping(img).toFixed(2),
    rampSteppingScore: +rampSteppingScore(img).toFixed(2),
    // candidates
    blockBoundaryRatio_p8: +blockBoundaryRatio(img, 8).toFixed(3),
    blockBoundaryRatio_p4: +blockBoundaryRatio(img, 4).toFixed(3),
    gradAutocorr_lag8: +gradAutocorr(img, 8).toFixed(3),
    speckle_codes: +speckle(img).toFixed(2),
  }))

  for (const r of rows) console.log(JSON.stringify(r))

  const get = (n: string) => rows.find((r) => r.case === n)!
  const ctl = get('control_identity')
  const good = get('known_good_perpixel64')
  const bad8 = get('known_bad_block8_taps8')

  const verdicts = {
    bandingScore: bad8.bandingScore > good.bandingScore * 1.5 ? 'usable' : 'DOES NOT SEPARATE — do not use',
    transitionStepping: bad8.transitionStepping > good.transitionStepping * 1.5 ? 'usable' : 'DOES NOT SEPARATE — do not use',
    rampSteppingScore: bad8.rampSteppingScore > good.rampSteppingScore * 1.5 ? 'usable' : 'DOES NOT SEPARATE — do not use',
    blockBoundaryRatio_p8:
      bad8.blockBoundaryRatio_p8 > 1.3 && Math.abs(good.blockBoundaryRatio_p8 - 1) < 0.15 && Math.abs(ctl.blockBoundaryRatio_p8 - 1) < 0.15
        ? 'usable — fires on bad, ~1.0 on good AND on the control'
        : 'MIScalibrated',
    speckle_codes: good.speckle_codes < bad8.speckle_codes ? 'orders good<bad' : 'orders bad<good (sparse taps are speckly regardless of blocking)',
  }
  console.log(JSON.stringify(verdicts, null, 2))

  // ---- squareness calibration (defect #3: square vs disc scatter footprint) --
  const psf = (kind: 'square' | 'disc' | 'gauss', n: number) => {
    const img = { width: n, height: n, data: new Float32Array(n * n * 4) }
    const c = (n - 1) / 2
    const half = n * 0.3
    const rDisc = Math.sqrt((2 * half) ** 2 / Math.PI)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x - c, dy = y - c
        let v = 0
        if (kind === 'square') v = Math.abs(dx) <= half && Math.abs(dy) <= half ? 1 : 0
        else if (kind === 'disc') v = dx * dx + dy * dy <= rDisc * rDisc ? 1 : 0
        else v = Math.exp(-(dx * dx + dy * dy) / (2 * (half / 2) ** 2))
        img.data[(y * n + x) * 4] = v
      }
    return img
  }
  const sq = { square: +squarenessScore(psf('square', 81)).toFixed(4), disc: +squarenessScore(psf('disc', 81)).toFixed(4), gauss: +squarenessScore(psf('gauss', 81)).toFixed(4) }
  console.log('squarenessScore ' + JSON.stringify(sq))

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'detector-calibration.json'), JSON.stringify({ rows, verdicts, squareness: sq }, null, 2))
}

main()
