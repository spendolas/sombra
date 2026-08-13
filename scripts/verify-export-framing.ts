import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { targetSize, computeFraming } from '../src/export/framing'

const view = { cssW:1280, cssH:720, deviceDpr:1 }

test('match = view device px, framing preserved (uDpr=view)', () => {
  const t = targetSize({kind:'match'}, view); assert(t.width===1280 && t.height===720, 'match size')
  const f = computeFraming('fill', view, t.width, t.height); assertClose(f.uDpr, 1, 0.001, 'match+fill uDpr==deviceDpr')
})

test('2x reveal reveals (uDpr=1, not 2)', () => {
  const t = targetSize({kind:'mul',factor:2}, view); assert(t.width===2560, '2x width')
  assert(computeFraming('reveal', view, t.width, t.height).uDpr === 1, 'reveal uDpr=1')
})

test('vertical fill crops (uDpr>view), fit reveals (uDpr<fill)', () => {
  const fill = computeFraming('fill', view, 1080, 1920).uDpr, fit = computeFraming('fit', view, 1080, 1920).uDpr
  assert(fit < fill, 'fit contains (smaller scale) < fill cover')
})

await run('export-framing')
