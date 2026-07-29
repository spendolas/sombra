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
