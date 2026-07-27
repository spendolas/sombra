// Temporal-stability measurement.
//
// Animation cannot be captured directly by the rig, so both temporal risks are
// measured through equivalent static experiments:
//
//   crawl  — a blur commutes with translation, so shift -> blur -> unshift must
//            give the same image for every shift. A screen-aligned pyramid is not
//            translation invariant, and that residual IS the shimmer that appears
//            when content moves under the blur.
//   pops   — sweeping the radius in fine steps, the frame-to-frame change should
//            vary smoothly. A discontinuity (e.g. a pyramid changing level count)
//            shows up as a single spike against the local trend.

import type { Rgba8 } from './image'

/** Translate by whole pixels, clamping at the edges. */
export function shiftImage(img: Rgba8, dx: number, dy: number): Rgba8 {
  const { width, height, data } = img
  const out: Rgba8 = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  for (let y = 0; y < height; y++) {
    const sy = Math.min(height - 1, Math.max(0, y - dy))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x - dx))
      const si = (sy * width + sx) * 4
      const di = (y * width + x) * 4
      out.data[di] = data[si]
      out.data[di + 1] = data[si + 1]
      out.data[di + 2] = data[si + 2]
      out.data[di + 3] = data[si + 3]
    }
  }
  return out
}

/** Crop `margin` pixels off every side, so clamped edges are excluded. */
export function cropInterior(img: Rgba8, margin: number): Rgba8 {
  const w = Math.max(1, img.width - margin * 2)
  const h = Math.max(1, img.height - margin * 2)
  const out: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + margin) * img.width + (x + margin)) * 4
      const di = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c]
    }
  }
  return out
}

/** Worst and mean RGB difference over every pair in the set. */
export function pairwiseDiff(images: Rgba8[]): { mean: number; max: number } {
  let max = 0
  let sum = 0
  let n = 0
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const a = images[i]
      const b = images[j]
      const px = Math.min(a.width * a.height, b.width * b.height)
      for (let p = 0; p < px; p++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])
          if (d > max) max = d
          sum += d
          n++
        }
      }
    }
  }
  return { mean: n ? sum / n : 0, max }
}

/**
 * Find a discontinuity in a sequence of consecutive-frame deltas.
 *
 * Each delta is compared against the mean of its two immediate neighbours, which
 * is second-order accurate on any smooth curve. That matters because deltas
 * legitimately decay as blur saturates (roughly 1/sigma); a wider window median
 * biases high on a steep decay and reports the decay itself as a pop.
 *
 * This detects a SPIKE — one frame out of line — which is the signature of a
 * discrete structural change such as a pyramid gaining a level. A permanent step
 * up in delta would not be flagged.
 */
export function sweepSpike(deltas: number[]): { ratio: number; index: number } {
  if (deltas.length < 3) return { ratio: 0, index: -1 }
  let worst = 0
  let worstIdx = -1
  for (let i = 1; i < deltas.length - 1; i++) {
    const expected = (deltas[i - 1] + deltas[i + 1]) / 2
    const ratio = deltas[i] / Math.max(expected, 1e-6)
    if (ratio > worst) {
      worst = ratio
      worstIdx = i
    }
  }
  return { ratio: worst, index: worstIdx }
}
