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
