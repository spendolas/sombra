// Artifact detectors. Each turns a suspected visible flaw into a reproducible
// number so "flawless" is not just an opinion. They are a SCREEN, not the final
// verdict (the human perceptual gate is) — their job is to catch a flaw the eye
// might miss on a single still, and to make elimination reproducible.
//
// Every detector is validated in detectors.test.ts against a known-good input
// (the reference blur) and a known-bad input (a synthetic flaw).

import type { FloatImage, Rgba8 } from './image'

// ---------------------------------------------------------------------------
// Banding / false contour.
// On content that should vary smoothly, banding shows as staircase plateaus:
// runs of identical value punctuated by jumps. Score = mean plateau run-length
// along a horizontal scan of the middle row (luminance). Smooth ramp -> short
// plateaus; posterized/quantized ramp -> long plateaus.
// ---------------------------------------------------------------------------
export function bandingScore(img: Rgba8, opts?: { row?: number }): number {
  const row = opts?.row ?? Math.floor(img.height / 2)
  const w = img.width
  const luma = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    const i = (row * w + x) * 4
    luma[x] = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
  }
  // measure plateau lengths (runs of equal value)
  const plateaus: number[] = []
  let runLen = 1
  for (let x = 1; x < w; x++) {
    if (luma[x] === luma[x - 1]) runLen++
    else {
      plateaus.push(runLen)
      runLen = 1
    }
  }
  plateaus.push(runLen)
  const total = plateaus.reduce((s, v) => s + v, 0)
  return total / plateaus.length // mean plateau length
}

// ---------------------------------------------------------------------------
// Ringing / overshoot.
// A non-negative blur kernel can never produce a value outside the source's
// range. Any excursion beyond [srcMin, srcMax] per channel is ringing.
// Score = max normalized excursion over all pixels/channels.
// ---------------------------------------------------------------------------
export function ringingScore(blurred: FloatImage, source: FloatImage): number {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < source.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const v = source.data[i + c]
      if (v < min[c]) min[c] = v
      if (v > max[c]) max[c] = v
    }
  let worst = 0
  for (let i = 0; i < blurred.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const v = blurred.data[i + c]
      const over = v > max[c] ? v - max[c] : v < min[c] ? min[c] - v : 0
      const range = Math.max(1e-6, max[c] - min[c])
      const norm = over / range
      if (norm > worst) worst = norm
    }
  return worst
}

// ---------------------------------------------------------------------------
// Boxiness — kurtosis of a 1D impulse response treated as a distribution over
// its sample positions. Gaussian kurtosis ≈ 3; a flat box ≈ 1.8. Lower = boxier.
// ---------------------------------------------------------------------------
export function boxinessKurtosis(response: ArrayLike<number>): number {
  const n = response.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += response[i]
  if (sum <= 0) return 0
  let mean = 0
  for (let i = 0; i < n; i++) mean += i * (response[i] / sum)
  let m2 = 0
  let m4 = 0
  for (let i = 0; i < n; i++) {
    const p = response[i] / sum
    const d = i - mean
    m2 += d * d * p
    m4 += d * d * d * d * p
  }
  if (m2 <= 0) return 0
  return m4 / (m2 * m2)
}

// ---------------------------------------------------------------------------
// Transition stepping — the failure mode of a progressive/spatially-varying
// blur built by interpolating between a few discrete blur levels: instead of a
// smooth ramp you see the boundaries where one level hands over to the next.
//
// Along the ramp axis, a smooth transition has a slowly-varying first derivative;
// discrete hand-offs put spikes in the SECOND derivative at the seams. Score is
// the peak-to-typical ratio of |d2/dx2| — scale free, so it does not care how
// strong the underlying ramp is, only how abruptly it changes.
// ---------------------------------------------------------------------------
export function transitionStepping(img: Rgba8, opts?: { row?: number }): number {
  const row = opts?.row ?? Math.floor(img.height / 2)
  const w = img.width
  if (w < 5) return 0
  const luma = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    const i = (row * w + x) * 4
    luma[x] = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]
  }
  const d2: number[] = []
  for (let x = 1; x < w - 1; x++) d2.push(Math.abs(luma[x + 1] - 2 * luma[x] + luma[x - 1]))
  if (!d2.length) return 0
  const sorted = [...d2].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const peak = sorted[sorted.length - 1]
  // A perfectly smooth ramp has near-zero curvature everywhere; guard the ratio.
  return peak / Math.max(median, 0.05)
}

// ---------------------------------------------------------------------------
// Blur-ramp profile — for a progressive / spatially varying blur, how blurred is
// each column? Measured as mean VERTICAL neighbour difference per column: that
// is high-frequency energy along an axis the horizontal mask does not touch, so
// it reports blur amount without being contaminated by the ramp itself.
//
// (Measuring row curvature directly does not work: on detailed content the
// image's own curvature dwarfs the hand-off between blur levels.)
// ---------------------------------------------------------------------------
export function blurRampProfile(img: Rgba8): Float64Array {
  const { width, height, data } = img
  const prof = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    let sum = 0
    for (let y = 0; y < height - 1; y++) {
      const i = (y * width + x) * 4
      const j = ((y + 1) * width + x) * 4
      const a = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      const b = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2]
      sum += Math.abs(a - b)
    }
    prof[x] = sum / Math.max(1, height - 1)
  }
  return prof
}

/**
 * Stepping in a progressive blur, measured as slope uniformity of the
 * blur-amount profile: score = max|slope| / mean|slope|.
 *
 * A smooth ramp changes at a near-constant rate, so max and mean agree and the
 * score sits near 1-3. Discrete level hand-offs make the slope bimodal — flat
 * plateaus (slope ~0, dragging the mean down) punctuated by jumps (a large max) —
 * so the ratio climbs, and it falls again as levels are added. Scale free.
 *
 * A peak/median CURVATURE ratio was tried first and does not work: once enough
 * levels are stacked, most of the profile is saturated flat, the median goes to
 * ~0 and the score explodes instead of improving.
 */
export function rampSteppingScore(img: Rgba8): number {
  const prof = blurRampProfile(img)
  if (prof.length < 8) return 0
  // Smooth over +/-5 columns before differentiating. Per-column detail energy is
  // itself noisy even after averaging down every row, and a raw max would report
  // that noise as a hand-off; a narrower window left smooth and stepped ramps
  // barely distinguishable.
  const R = 5
  const sm = new Float64Array(prof.length)
  for (let x = 0; x < prof.length; x++) {
    let s = 0, n = 0
    for (let d = -R; d <= R; d++) {
      const k = x + d
      if (k >= 0 && k < prof.length) { s += prof[k]; n++ }
    }
    sm[x] = s / n
  }
  // Compare the profile against a heavy moving-average trend. A plateau sits
  // above or below the trend by roughly half a step, so the peak deviation as a
  // percentage of the profile's range reads directly as "how visible is the
  // hand-off". Differentiating instead was too noise-sensitive: column detail
  // energy fluctuates enough that slope noise rivalled a real step.
  const W = Math.max(9, Math.floor(prof.length / 6))
  const trend = new Float64Array(prof.length)
  for (let x = 0; x < prof.length; x++) {
    let s = 0, n = 0
    for (let d = -W; d <= W; d++) {
      const k = x + d
      if (k >= 0 && k < prof.length) { s += sm[k]; n++ }
    }
    trend[x] = s / n
  }
  let lo = Infinity
  let hi = -Infinity
  for (let x = R; x < sm.length - R; x++) { if (sm[x] < lo) lo = sm[x]; if (sm[x] > hi) hi = sm[x] }
  const range = hi - lo
  if (!(range > 1e-9)) return 0
  let peak = 0
  // Ignore a full window at each end: a truncated moving average bends away from
  // the data there, which would otherwise read as a step on a perfectly smooth ramp.
  const skip = Math.min(W, Math.floor(prof.length * 0.4))
  for (let x = skip; x < prof.length - skip; x++) {
    const dev = Math.abs(sm[x] - trend[x])
    if (dev > peak) peak = dev
  }
  return (peak / range) * 100
}

// ---------------------------------------------------------------------------
// Anisotropy — for a centered impulse response, compare the second moment along
// x vs along y. Isotropic (round) -> 0; elliptical -> up to 1.
// Uses the R channel as the response magnitude.
// ---------------------------------------------------------------------------
export function anisotropyScore(resp: FloatImage): number {
  const { width, height, data } = resp
  let sum = 0
  let cx = 0
  let cy = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = data[(y * width + x) * 4]
      sum += v
      cx += x * v
      cy += y * v
    }
  if (sum <= 0) return 0
  cx /= sum
  cy /= sum
  let mxx = 0
  let myy = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = data[(y * width + x) * 4]
      mxx += (x - cx) ** 2 * v
      myy += (y - cy) ** 2 * v
    }
  mxx /= sum
  myy /= sum
  const denom = mxx + myy
  return denom <= 0 ? 0 : Math.abs(mxx - myy) / denom
}
