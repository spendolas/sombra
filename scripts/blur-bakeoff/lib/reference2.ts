// Ground-truth references for the non-isotropic suite categories.
// Same contract as reference.ts: linear-light FloatImage in, correctness over
// speed, clamp-to-edge, optional premultiplied handling.

import { createFloat, premultiply, unpremultiply, type FloatImage } from './image'
import { gaussianKernel1D } from './reference'

interface Opts {
  premultiplied?: boolean
}

function clampInt(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v
}

/** Bilinear fetch with clamp-to-edge, matching the GPU sampler. */
function sampleBilinear(img: FloatImage, x: number, y: number, out: number[]): void {
  const { width, height, data } = img
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const x0c = clampInt(x0, width - 1)
  const x1c = clampInt(x0 + 1, width - 1)
  const y0c = clampInt(y0, height - 1)
  const y1c = clampInt(y0 + 1, height - 1)
  for (let c = 0; c < 4; c++) {
    const a = data[(y0c * width + x0c) * 4 + c]
    const b = data[(y0c * width + x1c) * 4 + c]
    const d = data[(y1c * width + x0c) * 4 + c]
    const e = data[(y1c * width + x1c) * 4 + c]
    out[c] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy
  }
}

/**
 * Directional (motion) blur: a 1D Gaussian along an arbitrary vector.
 * Cost is O(sigma) rather than O(sigma^2), which is why motion blur stays
 * affordable at full resolution where an isotropic blur would not.
 */
export function directionalBlur(img: FloatImage, sigma: number, dir: [number, number], opts?: Opts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const kernel = gaussianKernel1D(sigma)
  const r = (kernel.length - 1) / 2
  const len = Math.hypot(dir[0], dir[1]) || 1
  const dx = dir[0] / len
  const dy = dir[1] / len
  const out = createFloat(img.width, img.height)
  const tap: number[] = [0, 0, 0, 0]

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0
      for (let t = -r; t <= r; t++) {
        sampleBilinear(src, x + dx * t, y + dy * t, tap)
        const w = kernel[t + r]
        ar += tap[0] * w; ag += tap[1] * w; ab += tap[2] * w; aa += tap[3] * w
      }
      const di = (y * img.width + x) * 4
      out.data[di] = ar; out.data[di + 1] = ag; out.data[di + 2] = ab; out.data[di + 3] = aa
    }
  }
  return opts?.premultiplied ? unpremultiply(out) : out
}

/**
 * Disc (bokeh) blur: uniform average over a circular aperture. The flat top is
 * the whole point — it is what makes an out-of-focus highlight read as a lens
 * aperture instead of a soft Gaussian smudge.
 */
export function discBlur(img: FloatImage, radius: number, opts?: Opts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const R = Math.max(0.5, radius)
  const ri = Math.ceil(R)
  // Precompute the offsets inside the aperture once.
  const offsets: Array<[number, number]> = []
  for (let dy = -ri; dy <= ri; dy++)
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy <= R * R) offsets.push([dx, dy])
    }
  const w = 1 / offsets.length
  const out = createFloat(img.width, img.height)

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0
      for (const [dx, dy] of offsets) {
        const sx = clampInt(x + dx, img.width - 1)
        const sy = clampInt(y + dy, img.height - 1)
        const si = (sy * img.width + sx) * 4
        ar += src.data[si] * w
        ag += src.data[si + 1] * w
        ab += src.data[si + 2] * w
        aa += src.data[si + 3] * w
      }
      const di = (y * img.width + x) * 4
      out.data[di] = ar; out.data[di + 1] = ag; out.data[di + 2] = ab; out.data[di + 3] = aa
    }
  }
  return opts?.premultiplied ? unpremultiply(out) : out
}
