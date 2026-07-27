// Ground-truth reference blur. Correctness over speed: this defines "ideal" that
// GPU candidates are judged against. Operates on linear-light FloatImage, uses a
// wide (4-sigma) normalized Gaussian, clamp-to-edge (matching the GPU sampler),
// and — when premultiplied:true — premultiply -> blur -> unpremultiply so
// transparent color never fringes across alpha edges.

import { createFloat, premultiply, unpremultiply, type FloatImage } from './image'

/** Normalized, centered (odd-length) 1D Gaussian kernel, truncated at 4 sigma. */
export function gaussianKernel1D(sigma: number): Float64Array {
  const s = Math.max(sigma, 1e-6)
  const radius = Math.max(1, Math.ceil(s * 4))
  const k = new Float64Array(radius * 2 + 1)
  const twoSigma2 = 2 * s * s
  let sum = 0
  for (let x = -radius; x <= radius; x++) {
    const v = Math.exp(-(x * x) / twoSigma2)
    k[x + radius] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return k
}

interface BlurOpts {
  premultiplied?: boolean
}

export function gaussianBlur(img: FloatImage, sigma: number, opts?: BlurOpts): FloatImage {
  const src = opts?.premultiplied ? premultiply(img) : img
  const k = gaussianKernel1D(sigma)
  const tmp = convolve1D(src, k, 'h')
  const blurred = convolve1D(tmp, k, 'v')
  return opts?.premultiplied ? unpremultiply(blurred) : blurred
}

type Axis = 'h' | 'v'

/** Separable 1D convolution along one axis, clamp-to-edge, all four channels. */
function convolve1D(img: FloatImage, kernel: Float64Array, axis: Axis): FloatImage {
  const { width, height, data } = img
  const out = createFloat(width, height)
  const r = (kernel.length - 1) / 2
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0
      for (let t = -r; t <= r; t++) {
        let sx = x
        let sy = y
        if (axis === 'h') sx = clampInt(x + t, width - 1)
        else sy = clampInt(y + t, height - 1)
        const si = (sy * width + sx) * 4
        const w = kernel[t + r]
        ar += data[si] * w
        ag += data[si + 1] * w
        ab += data[si + 2] * w
        aa += data[si + 3] * w
      }
      const di = (y * width + x) * 4
      out.data[di] = ar
      out.data[di + 1] = ag
      out.data[di + 2] = ab
      out.data[di + 3] = aa
    }
  }
  return out
}

function clampInt(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v
}
