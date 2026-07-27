// Validates the progressive-blur stepping detector against synthetic ramps whose
// BLUR AMOUNT varies across x. The signal is per-column detail energy, so the
// fixtures modulate noise amplitude per column rather than luminance.

import { test, run, assert } from './test-util'
import { blurRampProfile, rampSteppingScore } from './detectors'
import type { Rgba8 } from './image'

/** Noise whose amplitude decays across x, either smoothly or in `steps` plateaus. */
function detailRamp(w: number, h: number, steps: number, seed = 7): Rgba8 {
  const data = new Uint8ClampedArray(w * h * 4)
  let s = seed
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1)
      // amplitude falls from 1 to 0 across x; quantized when steps > 0
      const q = steps > 0 ? Math.floor(t * steps) / steps : t
      const amp = (1 - q) * 110
      const v = 128 + (rand() - 0.5) * 2 * amp
      const i = (y * w + x) * 4
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, Math.round(v)))
      data[i + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

test('blurRampProfile decreases across a decaying-detail ramp', () => {
  const prof = blurRampProfile(detailRamp(256, 64, 0))
  const left = prof.slice(0, 32).reduce((a, b) => a + b, 0) / 32
  const right = prof.slice(-32).reduce((a, b) => a + b, 0) / 32
  assert(left > right * 3, `detail should fall left->right, got ${left.toFixed(1)} vs ${right.toFixed(1)}`)
})

test('rampSteppingScore: a smooth detail ramp scores low', () => {
  const s = rampSteppingScore(detailRamp(256, 64, 0))
  assert(s < 12, `smooth ramp should score low, got ${s.toFixed(2)}`)
})

test('rampSteppingScore: a 4-plateau ramp scores clearly higher than smooth', () => {
  const smooth = rampSteppingScore(detailRamp(256, 64, 0))
  const stepped = rampSteppingScore(detailRamp(256, 64, 4))
  assert(stepped > smooth * 2, `stepped(${stepped.toFixed(2)}) should exceed smooth(${smooth.toFixed(2)})`)
})

test('rampSteppingScore: more plateaus means less visible stepping', () => {
  const few = rampSteppingScore(detailRamp(256, 64, 3))
  const many = rampSteppingScore(detailRamp(256, 64, 24))
  assert(many < few, `24 plateaus (${many.toFixed(2)}) should beat 3 (${few.toFixed(2)})`)
})

run('ramp')
