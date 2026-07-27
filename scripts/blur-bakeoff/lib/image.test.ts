import { test, run, assert, assertClose } from './test-util'
import {
  createFloat,
  decodeToLinear,
  encodeToSrgb8,
  premultiply,
  unpremultiply,
  type Rgba8,
} from './image'

function solidRgba8(w: number, h: number, r: number, g: number, b: number, a: number): Rgba8 {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  }
  return { width: w, height: h, data }
}

test('createFloat allocates zeroed RGBA float image', () => {
  const img = createFloat(3, 2)
  assert(img.width === 3 && img.height === 2, 'dims')
  assert(img.data.length === 3 * 2 * 4, 'length')
  assert(img.data.every((v) => v === 0), 'zeroed')
})

test('decodeToLinear: sRGB mid-grey byte 128 -> ~0.2140 linear, alpha normalized', () => {
  const lin = decodeToLinear(solidRgba8(1, 1, 128, 128, 128, 255))
  assertClose(lin.data[0], 0.21586, 2e-3, 'R linear') // srgbToLinear(128/255)
  assertClose(lin.data[3], 1, 1e-9, 'A normalized')
})

test('alpha is linearized as a plain ratio, not gamma-decoded', () => {
  const lin = decodeToLinear(solidRgba8(1, 1, 255, 255, 255, 128))
  assertClose(lin.data[3], 128 / 255, 1e-6, 'alpha is byte/255')
})

test('encode/decode round-trips every byte value within ±1', () => {
  for (let b = 0; b <= 255; b++) {
    const out = encodeToSrgb8(decodeToLinear(solidRgba8(1, 1, b, b, b, 255)))
    assert(Math.abs(out.data[0] - b) <= 1, `byte ${b} -> ${out.data[0]}`)
  }
})

test('premultiply scales rgb by alpha, leaves alpha', () => {
  const img = createFloat(1, 1)
  img.data.set([0.8, 0.6, 0.4, 0.5])
  const pm = premultiply(img)
  // eps at float32 storage precision, not float64.
  assertClose(pm.data[0], 0.4, 1e-6)
  assertClose(pm.data[1], 0.3, 1e-6)
  assertClose(pm.data[2], 0.2, 1e-6)
  assertClose(pm.data[3], 0.5, 1e-6)
})

test('unpremultiply inverts premultiply for non-zero alpha', () => {
  const img = createFloat(1, 1)
  img.data.set([0.8, 0.6, 0.4, 0.5])
  const back = unpremultiply(premultiply(img))
  for (let i = 0; i < 4; i++) assertClose(back.data[i], img.data[i], 1e-6, `ch ${i}`)
})

test('unpremultiply is safe at alpha 0 (no divide-by-zero)', () => {
  const img = createFloat(1, 1)
  img.data.set([0.3, 0.3, 0.3, 0])
  const back = unpremultiply(img)
  assert(back.data.every((v) => Number.isFinite(v)), 'finite')
  assertClose(back.data[3], 0, 1e-9, 'alpha stays 0')
})

run('image')
