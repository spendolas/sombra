import { test, run, assertClose } from './test-util'
import { srgbToLinear, linearToSrgb } from './color'

// Anchors of the standard sRGB transfer function.
test('srgbToLinear maps endpoints exactly', () => {
  assertClose(srgbToLinear(0), 0, 1e-9)
  assertClose(srgbToLinear(1), 1, 1e-9)
})

test('srgbToLinear(0.5) ≈ 0.2140 (known midpoint)', () => {
  // sRGB 0.5 is perceptual middle-grey but only ~21.4% linear light —
  // the exact reason naive-sRGB blur looks too dark.
  assertClose(srgbToLinear(0.5), 0.21404, 1e-4)
})

test('linearToSrgb is the inverse of srgbToLinear', () => {
  for (const x of [0, 0.01, 0.04, 0.1, 0.25, 0.5, 0.75, 0.999, 1]) {
    assertClose(linearToSrgb(srgbToLinear(x)), x, 1e-5, `round-trip at ${x}`)
  }
})

test('linear encode of 0.2140 ≈ 0.5', () => {
  assertClose(linearToSrgb(0.21404), 0.5, 1e-4)
})

run('color')
