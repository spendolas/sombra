/**
 * The per-pass sizing contract. Pure maths, no GPU — this is where the claim
 * "anchor pinning survives a scaled pass" becomes executable rather than a
 * paragraph in a spec.
 *
 * Run: npx tsx scripts/verify-pass-size.ts
 */
import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { passTargetSize, normalisePassScale, PASS_SCALE_MAX } from '../src/renderer/pass-size'

const REF = 512
const MAXTEX = 8192

/** auto_uv on one axis, exactly as the generator emits it. */
const autoUv = (frag: number, res: number, dpr: number, anchor: number) =>
  (frag - res * anchor) / (dpr * REF) + anchor

/** auto_uv on the Y axis, including the u_resolution.y flip. */
const autoUvY = (frag: number, res: number, dpr: number, anchor: number) =>
  (res - frag - res * anchor) / (dpr * REF) + anchor

test('absent scale is the identity', () => {
  const s = passTargetSize(undefined, 1024, 768, 2, MAXTEX)
  assert(s.width === 1024 && s.height === 768, `got ${s.width}x${s.height}`)
  assert(s.dpr === 2, `dpr ${s.dpr}`)
})

test('half scale halves the target and the dpr', () => {
  const s = passTargetSize(0.5, 1024, 768, 2, MAXTEX)
  assert(s.width === 512 && s.height === 384, `got ${s.width}x${s.height}`)
  assertClose(s.dpr, 1, 1e-12, 'dpr must halve with the pass')
})

test('supersampling above 1.0 is allowed', () => {
  const s = passTargetSize(2, 800, 600, 1, MAXTEX)
  assert(s.width === 1600 && s.height === 1200, `got ${s.width}x${s.height}`)
  assertClose(s.dpr, 2, 1e-12, 'dpr must grow with the pass')
})

test('auto_uv is invariant across scale — X axis', () => {
  const W = 1024, H = 768, D = 2, a = 0.5
  for (const scale of [0.25, 0.5, 1, 2, 3]) {
    const s = passTargetSize(scale, W, H, D, MAXTEX)
    for (const p of [0, 0.1, 0.37, 0.5, 0.75, 1]) {
      const full = autoUv(p * W, W, D, a)
      const scaled = autoUv(p * s.width, s.width, s.dpr, a)
      assertClose(scaled, full, 1e-9, `scale ${scale} at p=${p}`)
    }
  }
})

test('auto_uv is invariant across scale — Y axis, including the flip', () => {
  const W = 1024, H = 768, D = 2
  for (const scale of [0.25, 0.5, 2]) {
    for (const a of [0, 0.5, 1]) {
      const s = passTargetSize(scale, W, H, D, MAXTEX)
      for (const p of [0, 0.37, 1]) {
        const full = autoUvY(p * H, H, D, a)
        const scaled = autoUvY(p * s.height, s.height, s.dpr, a)
        assertClose(scaled, full, 1e-9, `scale ${scale} anchor ${a} at p=${p}`)
      }
    }
  }
})

test('a px-authored param keeps its cell index', () => {
  // pixelate: size = floor(pixelSize * u_dpr + 0.5); cell = floor(centred / size)
  const W = 1024, H = 1024, D = 2, a = 0.5, pixelSize = 8
  const cellAt = (res: number, dpr: number, p: number) => {
    const size = Math.max(1, Math.floor(pixelSize * dpr + 0.5))
    return Math.floor((p * res - res * a) / size)
  }
  const s = passTargetSize(0.5, W, H, D, MAXTEX)
  for (const p of [0.1, 0.3, 0.5, 0.9]) {
    assert(cellAt(s.width, s.dpr, p) === cellAt(W, D, p),
      `cell index moved at p=${p}: ${cellAt(s.width, s.dpr, p)} vs ${cellAt(W, D, p)}`)
  }
})

test('dpr comes from the integer width, not the requested float', () => {
  // 1001 * 0.5 = 500.5 -> rounds to 501, so dpr must be 501/1001, not 0.5.
  const s = passTargetSize(0.5, 1001, 1001, 1, MAXTEX)
  assert(s.width === 501, `width ${s.width}`)
  assertClose(s.dpr, 501 / 1001, 1e-12, 'dpr must track the actual texture width')
  assert(s.dpr !== 0.5, 'dpr must not be the requested float')
})

test('maxTexture clamp must not desync the axes — 5K canvas @ dpr2 vs an 8192 texture limit', () => {
  // 5K display at dpr 2 is 10240x5760; WebGPU's default maxTextureDimension2D
  // is 8192. Only X needs clamping (10240 > 8192); Y (5760) does not. If width
  // and height were clamped independently, dpr — derived from X — would be
  // silently wrong for Y: a 25% error, not the sub-percent rounding footnote
  // the design doc originally anticipated. (Finding 1, 2026-07-29 review.)
  const W = 10240, H = 5760, D = 2
  const s = passTargetSize(1, W, H, D, MAXTEX)
  const ratioX = s.width / W
  const ratioY = s.height / H
  assert(s.width === 8192, `X should clamp to maxTexture: got ${s.width}`)
  assert(s.height === 4608, `Y must scale by the SAME effective ratio as X: got ${s.height}`)
  assertClose(ratioX, ratioY, 1e-9, `axis ratios diverged: X=${ratioX} Y=${ratioY}`)
  // Note on what this pair can and can't prove: 10240 and 5760 both scale to
  // clean integers at sEff=0.8 (8192 and 4608 exactly), so ratioX and ratioY
  // come out EXACTLY equal for this input. That makes these two assertions a
  // solid check that the axes stayed in sync — the desync bug this test
  // targets — but NOT a check of which axis dpr is actually derived from: a
  // width/height mixup in the dpr formula would produce the identical number
  // either way and pass here regardless. The "non-square canvas whose axes
  // round differently" test below is the one built to catch that mixup,
  // using inputs where ratioX and ratioY differ.
  assertClose(s.dpr, D * ratioX, 1e-12, 'dpr must match the X ratio (true by definition)')
  assertClose(s.dpr, D * ratioY, 1e-9, 'dpr must ALSO match the Y ratio — this is the actual bug')

  // The failure mode in concrete terms: Y-axis auto_uv must stay invariant
  // too, not just X (existing suite only ever checked X for a clamped pass).
  for (const a of [0, 0.5, 1]) {
    for (const p of [0, 0.37, 1]) {
      const full = autoUvY(p * H, H, D, a)
      const scaled = autoUvY(p * s.height, s.height, s.dpr, a)
      assertClose(scaled, full, 1e-9, `anchor ${a} at p=${p}`)
    }
  }
})

test('maxTexture clamp on a non-square canvas whose axes round differently', () => {
  // 1001x999 is deliberately not square: canvasWidth*scale and
  // canvasHeight*scale land on different sides of a .5 boundary, so even the
  // FIXED implementation's two axis ratios only agree up to integer rounding,
  // not exactly — unlike the clean 4/5 case above. maxTexture=4000 sits
  // between the axes' natural scaled sizes (4004 and 3996), so only X clamps.
  // Every non-square case in the original suite picked numbers where both
  // axes rounded to the SAME ratio, so neither an independent per-axis clamp
  // nor a width/height mixup in the dpr formula was ever exercised for a
  // canvas that rounds unevenly. (Finding 2, 2026-07-29 review. Note: the
  // review's own illustrative call — passTargetSize(0.5, 1001, 999, 1, 8192)
  // — never reaches either clamp bound at that scale/maxTexture, so it cannot
  // distinguish pre-fix from post-fix; scale and maxTexture are changed here
  // so the clamp actually engages asymmetrically. Verified empirically below.)
  const W = 1001, H = 999, D = 1, TIGHT_MAXTEX = 4000
  const s = passTargetSize(4, W, H, D, TIGHT_MAXTEX)
  const ratioX = s.width / W
  const ratioY = s.height / H
  assert(s.width === 4000, `X should clamp to maxTexture: got ${s.width}`)
  assert(s.height > 3990 && s.height < 4000, `Y should be unclamped, near but under 4000: got ${s.height}`)
  assertClose(ratioX, ratioY, 1e-4, `axis ratios diverged beyond rounding: X=${ratioX} Y=${ratioY}`)
  // dpr is DEFINED as baseDpr * (width / canvasWidth) = D * ratioX, so this
  // must hold to float precision, not just "closely" — a tight tolerance
  // here is a real check, not a formality.
  assertClose(s.dpr, D * ratioX, 1e-12, 'dpr must equal D * ratioX exactly — that is its definition')
  // Fix 2 (2026-07-29 review pass 2): the assertion this replaced compared
  // dpr to D * ratioY at 1e-4 tolerance, which a height-derived dpr also
  // satisfies trivially (exact match, diff 0) — it could never fail for the
  // width/height mixup it was meant to catch. These inputs are deliberately
  // chosen so the two candidates differ by ~8e-6 (width-derived
  // 3.996003996003996 vs height-derived 3.995995995995996), which is what
  // gives this assertion its discriminating power.
  assert(Math.abs(s.dpr - D * ratioY) > 1e-9,
    `dpr must NOT equal the height-derived D * ratioY: dpr=${s.dpr}, D*ratioY=${D * ratioY}`)
})

test('degenerate scales fall back to 1.0', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert(normalisePassScale(bad) === 1, `${bad} should normalise to 1`)
  }
})

test('scale is clamped to PASS_SCALE_MAX and to maxTexture', () => {
  assert(normalisePassScale(1000) === PASS_SCALE_MAX, 'scale must clamp')
  const s = passTargetSize(4, 4096, 4096, 1, 8192)
  assert(s.width === 8192, `width ${s.width}`)
  const capped = passTargetSize(4, 4096, 4096, 1, 4096)
  assert(capped.width === 4096, `maxTexture must cap: ${capped.width}`)
})

test('minPx floor applies (preview renderers use 4)', () => {
  const s = passTargetSize(0.01, 80, 80, 1, MAXTEX, 4)
  assert(s.width === 4 && s.height === 4, `got ${s.width}x${s.height}`)
})

await run('pass-size')
