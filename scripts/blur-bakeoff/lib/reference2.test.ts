import { test, run, assert, assertClose } from './test-util'
import { createFloat, type FloatImage } from './image'
import { directionalBlur, discBlur } from './reference2'
import { transitionStepping } from './detectors'
import type { Rgba8 } from './image'

function impulse(n: number): FloatImage {
  const img = createFloat(n, n)
  const c = (n - 1) / 2
  const i = (c * n + c) * 4
  img.data[i] = 1
  img.data[i + 3] = 1
  return img
}

// ---- directional -----------------------------------------------------------
test('directionalBlur along x leaves a horizontal streak only', () => {
  const n = 21
  const out = directionalBlur(impulse(n), 3, [1, 0])
  const c = (n - 1) / 2
  const at = (x: number, y: number) => out.data[(y * n + x) * 4]
  assert(at(c + 3, c) > 0.001, 'spreads along x')
  assert(at(c, c + 3) < 1e-6, `does not spread along y, got ${at(c, c + 3)}`)
})

test('directionalBlur along a diagonal spreads on that diagonal', () => {
  const n = 21
  const out = directionalBlur(impulse(n), 3, [1, 1])
  const c = (n - 1) / 2
  const at = (x: number, y: number) => out.data[(y * n + x) * 4]
  assert(at(c + 2, c + 2) > at(c + 2, c - 2), 'follows the +45 direction')
})

test('directionalBlur conserves energy and is symmetric', () => {
  const n = 31
  const out = directionalBlur(impulse(n), 4, [1, 0])
  let sum = 0
  for (let i = 0; i < out.data.length; i += 4) sum += out.data[i]
  assertClose(sum, 1, 1e-3, 'energy conserved')
  const c = (n - 1) / 2
  assertClose(out.data[(c * n + c + 3) * 4], out.data[(c * n + c - 3) * 4], 1e-6, 'symmetric')
})

// ---- disc (bokeh) ----------------------------------------------------------
test('discBlur spreads an impulse into a flat-topped disc, not a bell', () => {
  const n = 41
  const R = 8
  const out = discBlur(impulse(n), R)
  const c = (n - 1) / 2
  const at = (x: number, y: number) => out.data[(y * n + x) * 4]
  // inside the disc the response is uniform (that is what makes bokeh look
  // like an aperture rather than a Gaussian)
  assertClose(at(c, c), at(c + Math.floor(R * 0.6), c), 1e-6, 'flat interior')
  assert(at(c + R + 2, c) < 1e-9, 'zero outside the radius')
  assert(at(c, c) > 0, 'non-zero inside')
})

test('discBlur is radially symmetric', () => {
  const n = 41
  const out = discBlur(impulse(n), 8)
  const c = (n - 1) / 2
  const at = (x: number, y: number) => out.data[(y * n + x) * 4]
  assertClose(at(c + 5, c), at(c, c + 5), 1e-9, 'x/y symmetry')
  assertClose(at(c + 4, c + 3), at(c - 4, c - 3), 1e-9, 'point symmetry')
})

test('discBlur conserves energy', () => {
  const n = 61
  const out = discBlur(impulse(n), 10)
  let sum = 0
  for (let i = 0; i < out.data.length; i += 4) sum += out.data[i]
  assertClose(sum, 1, 1e-3, 'energy conserved')
})

// ---- progressive transition stepping --------------------------------------
function rampImage(w: number, h: number, levels: number): Rgba8 {
  // A left-to-right ramp quantized into `levels` plateaus simulates a
  // progressive blur built from too few discrete blur levels.
  const data = new Uint8ClampedArray(w * h * 4)
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1)
    const q = levels > 0 ? Math.floor(t * levels) / Math.max(1, levels - 1) : t
    const v = Math.round(Math.min(1, q) * 255)
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

test('transitionStepping: a smooth ramp scores far lower than a 4-step one', () => {
  const smooth = rampImage(256, 8, 0)
  const stepped = rampImage(256, 8, 4)
  const s = transitionStepping(smooth)
  const b = transitionStepping(stepped)
  assert(b > s * 4, `stepped(${b.toFixed(3)}) should dwarf smooth(${s.toFixed(3)})`)
})

test('transitionStepping: more levels means less stepping', () => {
  const few = transitionStepping(rampImage(256, 8, 4))
  const many = transitionStepping(rampImage(256, 8, 32))
  assert(many < few, `32 levels (${many.toFixed(3)}) should beat 4 levels (${few.toFixed(3)})`)
})

run('reference2')
