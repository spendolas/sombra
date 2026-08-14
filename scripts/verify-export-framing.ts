import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { targetSize, computeFraming, describeResult } from '../src/export/framing'

const view = { cssW: 1280, cssH: 720, deviceDpr: 1 }

test('match = view LOGICAL size', () => {
  const t = targetSize({ kind: 'match' }, view)
  assert(t.width === 1280 && t.height === 720, 'match size == view')
  const f = computeFraming('fill', view, t.width, t.height)
  assertClose(f.uDpr, 1, 0.001, 'match+fill uDpr==1')
})

test('2x = logical size × 2', () => {
  const t = targetSize({ kind: 'mul', factor: 2 }, view)
  assert(t.width === 2560, '2x width')
  assert(computeFraming('reveal', view, t.width, t.height).uDpr === 1, 'reveal uDpr=1')
})

test('vertical fill crops (uDpr>view), fit reveals (uDpr<fill)', () => {
  const fill = computeFraming('fill', view, 1080, 1920).uDpr
  const fit = computeFraming('fit', view, 1080, 1920).uDpr
  assert(fit < fill, 'fit contains (smaller scale) < fill cover')
})

// Regression: on a retina (2×) display Match must equal the LOGICAL view size —
// NOT cssW×deviceDpr — and read as a true 1:1. (The bug multiplied by deviceDpr,
// so Match secretly exported 2× and mislabeled it 1:1.)
test('retina: match ignores deviceDpr (logical size, 1:1)', () => {
  const retina = { cssW: 1364, cssH: 583, deviceDpr: 2 }
  const t = targetSize({ kind: 'match' }, retina)
  assert(t.width === 1364 && t.height === 583, `match@2x should be logical, got ${t.width}x${t.height}`)
  const d = describeResult({ kind: 'match' }, 'reveal', retina)
  assert(d.framingHidden === true, 'match@2x → framing hidden')
  assert(d.text === 'Exporting your current view exactly, 1:1.', 'match@2x → 1:1 text')
  // 2× on retina yields the device-pixel resolution — the sharper step.
  assert(targetSize({ kind: 'mul', factor: 2 }, retina).width === 2728, '2x@retina = device px')
})

await run('export-framing')
