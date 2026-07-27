// Provocation stimuli — engineered worst-cases designed to trigger every known
// blur artifact. Returned as Rgba8 (sRGB 8-bit, straight alpha), the natural
// input-image form. "Passing the provocations = flawless"; a clean result on an
// easy photo proves nothing.

import type { Rgba8 } from './image'

function blank(width: number, height: number): Rgba8 {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

function setPx(img: Rgba8, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4
  img.data[i] = r
  img.data[i + 1] = g
  img.data[i + 2] = b
  img.data[i + 3] = a
}

/** Hard black|white vertical edge — exposes ringing and gamma dark-halos. */
export function stepEdge(width: number, height: number): Rgba8 {
  const img = blank(width, height)
  const mid = Math.floor(width / 2)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) setPx(img, x, y, x < mid ? 0 : 255, x < mid ? 0 : 255, x < mid ? 0 : 255)
  return img
}

/** Single bright white point on black — bokeh disc shape + ringing test. */
export function pointOnBlack(width: number, height: number): Rgba8 {
  const img = blank(width, height)
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255 // opaque black
  setPx(img, Math.floor(width / 2), Math.floor(height / 2), 255, 255, 255)
  return img
}

/** Low-contrast horizontal gradient — banding / false-contour test. */
export function smoothGradient(width: number, height: number, opt: { from: number; to: number }): Rgba8 {
  const img = blank(width, height)
  for (let x = 0; x < width; x++) {
    const t = width === 1 ? 0 : x / (width - 1)
    const v = Math.round(opt.from + (opt.to - opt.from) * t)
    for (let y = 0; y < height; y++) setPx(img, x, y, v, v, v)
  }
  return img
}

/** Deterministic high-frequency grayscale noise — shimmer/aliasing under animation. */
export function hfNoise(width: number, height: number, seed: number): Rgba8 {
  const img = blank(width, height)
  const rand = mulberry32(seed >>> 0)
  for (let p = 0; p < width * height; p++) {
    const v = Math.floor(rand() * 256)
    img.data[p * 4] = v
    img.data[p * 4 + 1] = v
    img.data[p * 4 + 2] = v
    img.data[p * 4 + 3] = 255
  }
  return img
}

/**
 * Opaque colored disc on a fully-transparent field of a DIFFERENT color.
 * The transparent color is chosen to contrast, so straight-alpha blur fringes it
 * into the disc edge while premultiplied-correct blur does not.
 */
export function transparentEdgeSprite(width: number, height: number): Rgba8 {
  const img = blank(width, height)
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const r = Math.min(width, height) * 0.3
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
      if (inside) setPx(img, x, y, 255, 40, 40, 255) // opaque red disc
      else setPx(img, x, y, 40, 255, 40, 0) // transparent green field
    }
  return img
}

/** Two saturated hues meeting at a hard vertical edge — chromatic ringing. */
export function colorEdge(width: number, height: number): Rgba8 {
  const img = blank(width, height)
  const mid = Math.floor(width / 2)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (x < mid) setPx(img, x, y, 255, 0, 0)
      else setPx(img, x, y, 0, 0, 255)
    }
  return img
}

/** Grid of bright points on black — bokeh disc field. `spacingCount` ~ points per axis. */
export function brightPointField(width: number, height: number, spacingCount: number): Rgba8 {
  const img = blank(width, height)
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255
  const step = Math.max(1, Math.floor(Math.min(width, height) / (spacingCount + 1)))
  for (let y = step; y < height; y += step)
    for (let x = step; x < width; x += step) setPx(img, x, y, 255, 255, 255)
  return img
}

/** Small fast deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
