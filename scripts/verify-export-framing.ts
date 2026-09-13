/**
 * Export Size + Framing maths: does Reveal hold the composition, does Fill
 * cover and Fit contain, and do the two scale axes stay independent?
 *
 * READS `frameScale` AND `dpr` SEPARATELY, ON PURPOSE. a732a36 split the single
 * overloaded `uDpr` into composition (`frameScale` → `u_frame_scale`) and device
 * density (`dpr` → `u_dpr`). This gate went on reading `uDpr` for three weeks
 * afterwards, so `fit < fill` was comparing `undefined < undefined` and passing
 * nothing — a correct, deliberate refactor made a test silently vacuous because
 * no npm script ran it. Every assertion below therefore names the axis it means,
 * and the independence of the two is asserted directly: collapsing them back
 * together must fail this file.
 *
 * Run: npm run verify:export-framing
 */
import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { targetSize, computeFraming, describeResult } from '../src/export/framing'

const view = { cssW: 1280, cssH: 720, deviceDpr: 1 }

test('match = view LOGICAL size', () => {
  const t = targetSize({ kind: 'match' }, view)
  assert(t.width === 1280 && t.height === 720, 'match size == view')
  const f = computeFraming('fill', view, t.width, t.height)
  assertClose(f.frameScale, 1, 0.001, 'match+fill leaves the composition alone (frameScale==1)')
  assertClose(f.dpr, 1, 0.001, 'export is 1:1 density (dpr==1)')
})

test('2x = logical size × 2, and Reveal does not rescale the composition', () => {
  const t = targetSize({ kind: 'mul', factor: 2 }, view)
  assert(t.width === 2560, '2x width')
  const f = computeFraming('reveal', view, t.width, t.height)
  // Reveal shows MORE scene at the same scale, so the composition scale stays 1
  // however much bigger the frame is — that is what distinguishes it from Fill.
  assert(f.frameScale === 1, 'reveal holds frameScale at 1')
  assert(f.dpr === 1, 'reveal holds dpr at 1')
})

test('into a vertical frame, Fill covers and Fit contains', () => {
  // A 1280x720 view into a 1080x1920 frame: the axis scales are 0.84 and 2.67.
  // Fill must take the LARGER (cover, cropping the sides); Fit the SMALLER
  // (contain, leaving margins). Asserting both against the axis scales, not just
  // against each other — `fit < fill` alone is satisfied by any two wrong values
  // in the right order, which is how this assertion survived reading undefined.
  const scaleX = 1080 / 1280
  const scaleY = 1920 / 720
  const fill = computeFraming('fill', view, 1080, 1920)
  const fit = computeFraming('fit', view, 1080, 1920)
  assertClose(fill.frameScale, Math.max(scaleX, scaleY), 1e-9, 'fill covers = max axis scale')
  assertClose(fit.frameScale, Math.min(scaleX, scaleY), 1e-9, 'fit contains = min axis scale')
  assert(fit.frameScale < fill.frameScale, 'fit contains (smaller scale) < fill covers')
})

test('composition and density are independent axes', () => {
  // The whole point of a732a36: framing may scale the composition hard while
  // export density stays 1:1. If the two are ever collapsed back onto one
  // number, dpr follows frameScale away from 1 and this fails.
  for (const mode of ['reveal', 'fill', 'fit'] as const) {
    const f = computeFraming(mode, view, 1080, 1920)
    assert(f.dpr === 1, `${mode}: export density must stay 1:1, got dpr=${f.dpr}`)
  }
  const fill = computeFraming('fill', view, 1080, 1920)
  assert(fill.frameScale !== 1, 'this fixture must actually move the composition, or the check above proves nothing')
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
