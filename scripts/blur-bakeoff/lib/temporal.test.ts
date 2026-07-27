// Detectors for the two temporal failure modes a pyramid blur can have:
// pops when the level count changes with radius, and crawl when screen-aligned
// downsampling makes the blur depend on where content sits on the grid.

import { test, run, assert } from './test-util'
import { shiftImage, cropInterior, pairwiseDiff, sweepSpike } from './temporal'
import { hfNoise } from './corpus'
import type { Rgba8 } from './image'

// ---- shiftImage ------------------------------------------------------------
test('shiftImage moves content by whole pixels', () => {
  const src = hfNoise(32, 32, 3)
  const out = shiftImage(src, 3, 0)
  // pixel (10,5) of the source should now be at (13,5)
  const a = src.data[(5 * 32 + 10) * 4]
  const b = out.data[(5 * 32 + 13) * 4]
  assert(a === b, `expected ${a} at shifted position, got ${b}`)
})

test('shiftImage round-trips (shift then shift back)', () => {
  const src = hfNoise(32, 32, 4)
  const back = shiftImage(shiftImage(src, 5, 2), -5, -2)
  const a = cropInterior(src, 8)
  const b = cropInterior(back, 8)
  assert(pairwiseDiff([a, b]).max === 0, 'interior must be byte-identical after round-trip')
})

// ---- pairwiseDiff ----------------------------------------------------------
test('pairwiseDiff is zero for identical images and positive otherwise', () => {
  const a = hfNoise(24, 24, 9)
  const b: Rgba8 = { width: 24, height: 24, data: new Uint8ClampedArray(a.data) }
  assert(pairwiseDiff([a, b]).max === 0, 'identical -> 0')
  b.data[0] = (b.data[0] + 40) & 0xff
  assert(pairwiseDiff([a, b]).max >= 40 - 1, 'differing -> positive')
})

test('pairwiseDiff reports the worst pair across a set', () => {
  const base = hfNoise(24, 24, 11)
  const mid: Rgba8 = { width: 24, height: 24, data: new Uint8ClampedArray(base.data) }
  const far: Rgba8 = { width: 24, height: 24, data: new Uint8ClampedArray(base.data) }
  mid.data[4] = 10
  far.data[4] = 200
  const d = pairwiseDiff([base, mid, far])
  assert(d.max >= 150, `worst pair should dominate, got ${d.max}`)
})

// ---- sweepSpike ------------------------------------------------------------
test('sweepSpike is near 1 for evenly-spaced deltas', () => {
  const deltas = [2, 2.1, 1.9, 2.05, 2, 1.95, 2.02]
  const s = sweepSpike(deltas)
  assert(s.ratio < 1.5, `smooth sweep should be ~1, got ${s.ratio.toFixed(2)}`)
})

test('sweepSpike finds a single pop and reports its index', () => {
  const deltas = [2, 2.1, 1.9, 18, 2.05, 2, 1.95]
  const s = sweepSpike(deltas)
  assert(s.ratio > 5, `pop should stand out, got ${s.ratio.toFixed(2)}`)
  assert(s.index === 3, `expected index 3, got ${s.index}`)
})

test('sweepSpike tolerates a decaying trend without calling it a pop', () => {
  // deltas naturally shrink as blur saturates; that is not a discontinuity
  const deltas = Array.from({ length: 20 }, (_, i) => 10 / (i + 1))
  const s = sweepSpike(deltas)
  assert(s.ratio < 3, `monotone decay should not read as a pop, got ${s.ratio.toFixed(2)}`)
})

run('temporal')
