import { test, run, assert } from './test-util'
import { createFloat, type FloatImage, type Rgba8 } from './image'
import { gaussianKernel1D, gaussianBlur } from './reference'
import { smoothGradient, stepEdge } from './corpus'
import { bandingScore, ringingScore, boxinessKurtosis, anisotropyScore } from './detectors'

function toFloatLuma(img: Rgba8): FloatImage {
  // trivial straight copy into float (no color mgmt) — detectors work on whatever space they're given
  const out = createFloat(img.width, img.height)
  for (let i = 0; i < img.data.length; i++) out.data[i] = img.data[i] / 255
  return out
}

// ---- banding ---------------------------------------------------------------
test('bandingScore: smooth ramp scores low, posterized ramp scores high', () => {
  const smooth = smoothGradient(128, 4, { from: 80, to: 176 }) // ~0.75 code/px
  const posterized: Rgba8 = { width: 128, height: 4, data: new Uint8ClampedArray(smooth.data) }
  for (let i = 0; i < posterized.data.length; i++) posterized.data[i] = Math.round(posterized.data[i] / 16) * 16
  const good = bandingScore(smooth)
  const bad = bandingScore(posterized)
  assert(bad > good * 2, `bad(${bad.toFixed(2)}) should dwarf good(${good.toFixed(2)})`)
})

// ---- ringing / overshoot ---------------------------------------------------
test('ringingScore: Gaussian blur of a step never overshoots (score 0)', () => {
  const src = toFloatLuma(stepEdge(64, 4))
  const blurred = gaussianBlur(src, 3)
  assert(ringingScore(blurred, src) < 1e-6, 'no overshoot for non-negative kernel')
})

test('ringingScore: an over/undershooting result scores > 0', () => {
  const src = toFloatLuma(stepEdge(64, 4))
  const bad = gaussianBlur(src, 3)
  // inject a ripple that exceeds the source [0,1] range near the edge
  const i = (0 * 64 + 30) * 4
  bad.data[i] = 1.4
  bad.data[i + 4] = -0.2
  assert(ringingScore(bad, src) > 0.1, 'overshoot detected')
})

// ---- boxiness (kurtosis of impulse response) -------------------------------
test('boxinessKurtosis: Gaussian ≈ 3, box ≈ 1.8 (box is boxier)', () => {
  const gauss = gaussianKernel1D(3) // ~Gaussian distribution
  const n = gauss.length
  const box = new Float64Array(n).fill(1 / n) // uniform
  const kg = boxinessKurtosis(gauss)
  const kb = boxinessKurtosis(box)
  assert(Math.abs(kg - 3) < 0.3, `gaussian kurtosis ~3, got ${kg.toFixed(3)}`)
  assert(kb < 2.2, `box kurtosis <2.2, got ${kb.toFixed(3)}`)
  assert(kg > kb, 'gaussian less boxy than box')
})

// ---- anisotropy ------------------------------------------------------------
test('anisotropyScore: isotropic blur ≈ 0, stretched blur > 0', () => {
  const n = 31
  const impulse = () => {
    const img = createFloat(n, n)
    const c = (n - 1) / 2
    img.data[((c * n + c) * 4)] = 1
    return img
  }
  const iso = gaussianBlur(impulse(), 3)
  // anisotropic: blur horizontally much more than vertically via two different-sigma passes
  const aniso = gaussianBlur(gaussianBlur(impulse(), 5), 0.8) // not axis-split, but let's build a real one below
  const isoScore = anisotropyScore(iso)
  assert(isoScore < 0.05, `isotropic near 0, got ${isoScore.toFixed(3)}`)
  // Build a genuinely elliptical response: wide horizontally, narrow vertically.
  const ellip = createFloat(n, n)
  const c = (n - 1) / 2
  const kx = gaussianKernel1D(5)
  const ky = gaussianKernel1D(1.2)
  const rx = (kx.length - 1) / 2
  const ry = (ky.length - 1) / 2
  for (let dy = -ry; dy <= ry; dy++)
    for (let dx = -rx; dx <= rx; dx++) {
      const x = c + dx, y = c + dy
      if (x >= 0 && x < n && y >= 0 && y < n) ellip.data[((y * n + x) * 4)] = kx[dx + rx] * ky[dy + ry]
    }
  const ellipScore = anisotropyScore(ellip)
  assert(ellipScore > 0.2, `elliptical clearly anisotropic, got ${ellipScore.toFixed(3)}`)
  void aniso
})

run('detectors')
