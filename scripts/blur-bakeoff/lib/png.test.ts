import { test, run, assert } from './test-util'
import { encodePng, decodePng } from './png'
import type { Rgba8 } from './image'

function ramp(w: number, h: number): Rgba8 {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = (x * 37 + y * 11) & 0xff
      data[i + 1] = (x * 5 + y * 71) & 0xff
      data[i + 2] = (x * 97 + y * 3) & 0xff
      data[i + 3] = (x + y) % 2 === 0 ? 255 : 128
    }
  }
  return { width: w, height: h, data }
}

function bytesEqual(a: Rgba8, b: Rgba8): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  if (a.data.length !== b.data.length) return false
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false
  return true
}

test('encoded PNG starts with the 8-byte PNG signature', () => {
  const png = encodePng(ramp(4, 3))
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) assert(png[i] === sig[i], `sig byte ${i}`)
})

test('decode recovers width/height from IHDR', () => {
  const dec = decodePng(encodePng(ramp(7, 5)))
  assert(dec.width === 7 && dec.height === 5, `${dec.width}x${dec.height}`)
})

test('round-trips exact bytes with default filter', () => {
  const src = ramp(9, 6)
  assert(bytesEqual(decodePng(encodePng(src)), src), 'mismatch')
})

test('round-trips exact bytes for every PNG filter type 0..4', () => {
  const src = ramp(9, 6)
  for (const filter of [0, 1, 2, 3, 4] as const) {
    const dec = decodePng(encodePng(src, { filter }))
    assert(bytesEqual(dec, src), `filter ${filter} mismatch`)
  }
})

test('handles 1x1 image', () => {
  const src: Rgba8 = { width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 78]) }
  assert(bytesEqual(decodePng(encodePng(src)), src), '1x1 mismatch')
})

run('png')
