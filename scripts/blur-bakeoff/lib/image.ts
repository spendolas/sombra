// Image types and conversions for the blur-bakeoff harness.
//
// Two canonical representations:
//   Rgba8      — 8-bit sRGB-encoded, straight (non-premultiplied) alpha. What PNGs
//                and the GPU canvas store; what the human eye ultimately judges.
//   FloatImage — linear-light float RGBA, straight alpha. The working space for
//                reference blur and any correct averaging (blur MUST average in
//                linear light, not sRGB — see color.ts).
//
// Alpha is a plain [0,1] coverage ratio in both spaces: never gamma-decoded.

import { srgbToLinear, linearToSrgb } from './color'

export interface Rgba8 {
  width: number
  height: number
  data: Uint8ClampedArray // length w*h*4, RGBA
}

export interface FloatImage {
  width: number
  height: number
  data: Float32Array // length w*h*4, RGBA, linear-light, straight alpha
}

export function createFloat(width: number, height: number): FloatImage {
  return { width, height, data: new Float32Array(width * height * 4) }
}

/** 8-bit sRGB (straight alpha) -> linear-light float (straight alpha). */
export function decodeToLinear(img: Rgba8): FloatImage {
  const out = createFloat(img.width, img.height)
  const s = img.data
  const d = out.data
  for (let i = 0; i < s.length; i += 4) {
    d[i] = srgbToLinear(s[i] / 255)
    d[i + 1] = srgbToLinear(s[i + 1] / 255)
    d[i + 2] = srgbToLinear(s[i + 2] / 255)
    d[i + 3] = s[i + 3] / 255
  }
  return out
}

/** linear-light float (straight alpha) -> 8-bit sRGB (straight alpha). */
export function encodeToSrgb8(img: FloatImage): Rgba8 {
  const out: Rgba8 = {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.width * img.height * 4),
  }
  const s = img.data
  const d = out.data
  for (let i = 0; i < s.length; i += 4) {
    d[i] = Math.round(linearToSrgb(clamp01(s[i])) * 255)
    d[i + 1] = Math.round(linearToSrgb(clamp01(s[i + 1])) * 255)
    d[i + 2] = Math.round(linearToSrgb(clamp01(s[i + 2])) * 255)
    d[i + 3] = Math.round(clamp01(s[i + 3]) * 255)
  }
  return out
}

/** straight alpha -> premultiplied (rgb *= a), in whatever space the image holds. */
export function premultiply(img: FloatImage): FloatImage {
  const out = createFloat(img.width, img.height)
  const s = img.data
  const d = out.data
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3]
    d[i] = s[i] * a
    d[i + 1] = s[i + 1] * a
    d[i + 2] = s[i + 2] * a
    d[i + 3] = a
  }
  return out
}

/** premultiplied -> straight alpha (rgb /= a); alpha 0 yields 0 rgb, no NaN. */
export function unpremultiply(img: FloatImage): FloatImage {
  const out = createFloat(img.width, img.height)
  const s = img.data
  const d = out.data
  for (let i = 0; i < s.length; i += 4) {
    const a = s[i + 3]
    const inv = a > 0 ? 1 / a : 0
    d[i] = s[i] * inv
    d[i + 1] = s[i + 1] * inv
    d[i + 2] = s[i + 2] * inv
    d[i + 3] = a
  }
  return out
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
