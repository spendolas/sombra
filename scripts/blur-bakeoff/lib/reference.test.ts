import { test, run, assert, assertClose } from './test-util'
import { createFloat, type FloatImage } from './image'
import { gaussianKernel1D, gaussianBlur } from './reference'

function fill(img: FloatImage, r: number, g: number, b: number, a: number): FloatImage {
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r
    img.data[i + 1] = g
    img.data[i + 2] = b
    img.data[i + 3] = a
  }
  return img
}

test('gaussianKernel1D is normalized and symmetric', () => {
  const k = gaussianKernel1D(2.5)
  const sum = k.reduce((s, v) => s + v, 0)
  assertClose(sum, 1, 1e-6, 'sum to 1')
  assert(k.length % 2 === 1, 'odd length (centered)')
  const mid = (k.length - 1) / 2
  for (let i = 0; i < mid; i++) assertClose(k[mid - i], k[mid + i], 1e-9, `symmetry ${i}`)
})

test('blurring a constant image preserves it (DC preservation, clamped edges)', () => {
  const src = fill(createFloat(16, 16), 0.4, 0.2, 0.7, 1)
  const out = gaussianBlur(src, 3)
  for (let i = 0; i < out.data.length; i += 4) {
    assertClose(out.data[i], 0.4, 1e-5, 'R')
    assertClose(out.data[i + 1], 0.2, 1e-5, 'G')
    assertClose(out.data[i + 2], 0.7, 1e-5, 'B')
    assertClose(out.data[i + 3], 1, 1e-5, 'A')
  }
})

test('impulse response is symmetric and conserves energy', () => {
  const n = 21
  const src = createFloat(n, n) // all zero, alpha 0
  const c = (n - 1) / 2
  const ci = (c * n + c) * 4
  src.data[ci] = 1 // white-ish point, R=1
  src.data[ci + 3] = 1 // opaque point
  const out = gaussianBlur(src, 2.0)

  // Peak at center, radial symmetry across the 4 cardinal neighbours.
  const at = (x: number, y: number) => out.data[(y * n + x) * 4]
  assert(at(c, c) > at(c + 1, c), 'peak at center')
  assertClose(at(c + 1, c), at(c - 1, c), 1e-6, 'L/R symmetry')
  assertClose(at(c, c + 1), at(c, c - 1), 1e-6, 'U/D symmetry')
  assertClose(at(c + 1, c), at(c, c + 1), 1e-6, 'isotropy')

  // Energy of the R channel is conserved (kernel normalized, point far from edges).
  let sum = 0
  for (let i = 0; i < out.data.length; i += 4) sum += out.data[i]
  assertClose(sum, 1, 1e-4, 'R energy conserved')
})

test('separable blur equals a brute-force 2D convolution', () => {
  const n = 7
  const src = createFloat(n, n)
  // deterministic varied content
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      src.data[i] = ((x * 13 + y * 7) % 100) / 100
      src.data[i + 3] = 1
    }
  const sigma = 1.7
  const sep = gaussianBlur(src, sigma)

  // brute force with the outer-product 2D kernel, clamped edges
  const k = gaussianKernel1D(sigma)
  const r = (k.length - 1) / 2
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let acc = 0
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const sx = clamp(x + dx, n - 1)
          const sy = clamp(y + dy, n - 1)
          acc += src.data[(sy * n + sx) * 4] * k[dy + r] * k[dx + r]
        }
      assertClose(sep.data[(y * n + x) * 4], acc, 1e-4, `px ${x},${y}`)
    }
})

test('premultiplied-alpha blur does not leak transparent color across an edge', () => {
  // Left column: opaque RED. Rest: fully-transparent GREEN.
  // Straight-alpha blur would drag green into the blurred red edge (fringing).
  // Premultiplied-correct blur must keep green ~0 where the red dominates.
  const w = 16
  const h = 4
  const src = createFloat(w, h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (x === 0) {
        src.data[i] = 1; src.data[i + 1] = 0; src.data[i + 2] = 0; src.data[i + 3] = 1
      } else {
        src.data[i] = 0; src.data[i + 1] = 1; src.data[i + 2] = 0; src.data[i + 3] = 0
      }
    }
  const out = gaussianBlur(src, 2.0, { premultiplied: true })
  // Column 1 (next to the red edge) must not have acquired green.
  const i1 = (0 * w + 1) * 4
  assert(out.data[i1 + 1] < 0.02, `green leaked: ${out.data[i1 + 1]}`)
  assert(out.data[i1] > out.data[i1 + 1], 'red dominates near edge')
})

run('reference')
