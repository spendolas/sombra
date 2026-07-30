/**
 * Does the pyramid blur produce a Gaussian of the RIGHT WIDTH — on a real GPU, against a
 * CPU reference — or does it just "blur"?
 *
 * The node compiles on both backends and renders a clean-looking blur, but that is not shape
 * correctness: a wrong tap offset, a missing dpr factor, or a broken intrinsic-sigma
 * subtraction all render a plausible blur of the WRONG width. This measures the width.
 *
 * Method: feed a hard vertical step edge through the ACTUAL shaders Sombra's compiler emits
 * for the pyramid, at each pass's real resolution (captureRawGlsl now honours per-pass
 * `scale`, mirroring the renderer's RenderPass.resolution, which is separately verified). Then
 *   - 10–90% RISE WIDTH of the output edge must match a Gaussian of sigma = radius/3 · dpr,
 *     within tolerance. This is the mechanism-engaged assertion: a half-width blur (the dpr
 *     bug) or a no-op fails it, where a mean-error check might not.
 *   - MEAN error vs a CPU Gaussian reference of the same sigma must be small AND far below the
 *     error of the sharp input vs that reference (proves it reproduces the reference, not a
 *     passthrough).
 *   - The dpr=2 run must be ~2× wider than dpr=1 — the proof the coarse-offset dpr scaling
 *     works.
 *
 * WebGL2 (GLSL) only: the rig's raw-capture path is GL. The WGSL half compiles identically
 * (self-validate) and the bake-off measured both backends matching; GLSL width is the port
 * correctness gate.
 *
 * Run: npx tsx scripts/verify-pyramid-blur-gpu.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { createRig, type RawGlslPass } from './blur-bakeoff/lib/gpu-rig'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './blur-bakeoff/lib/image'
import { gaussianBlur } from './blur-bakeoff/lib/reference'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()

const W = 256, H = 128
const SIGMA_PER_RADIUS = 1 / 3
/** 10–90% rise of a Gaussian edge is 2·erf⁻¹(0.8)·√2·σ ≈ 2.5631·σ. */
const RISE_PER_SIGMA = 2.5631

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

/** Opaque black→white vertical step, edge at x = W/2. Alpha 1 everywhere, so the blur's
 *  premultiply is the identity and a plain CPU Gaussian is the correct reference. */
function stepEdge(): Rgba8 {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x < W / 2 ? 0 : 255
      const i = (y * W + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { width: W, height: H, data }
}

/** The pyramid's compiled passes as RawGlslPass, skipping the checkerboard source pass:
 *  we feed our OWN step image to the blur's first pass instead. */
function blurPasses(radius: number): RawGlslPass[] {
  const plan = compileGraph(
    [n('src', 'checkerboard'), n('fx', 'blur', { radius }), n('out', 'fragment_output')],
    [e('e1', 'src', 'color', 'fx', 'source'), e('e2', 'fx', 'color', 'out', 'color')],
  )
  if (!plan.success) throw new Error('compile failed: ' + JSON.stringify(plan.errors))
  // pass 0 is the checkerboard; the rest are the blur (last one folds fragment_output).
  return plan.passes.slice(1).map((p) => ({
    fragmentShader: p.fragmentShader,
    vertexShader: p.vertexShader,
    sampler: Object.keys(p.inputTextures)[0], // the single previous-pass sampler
    scale: p.resolution ?? 1,
    // fragment_output folds into the last pass; u_out_alpha=1 is the identity alpha op.
    userUniforms: (p.userUniforms ?? [])
      .filter((u) => u.name === 'u_out_alpha')
      .map((u) => ({ name: u.name, glslType: u.glslType as 'float', value: 1 })),
  }))
}

/** sRGB code (0–255) → linear [0,1]. */
function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** 10–90% rise width (px) of the red channel along the central row of a step-edge image,
 *  measured in LINEAR light. The image is sRGB-encoded, but a Gaussian is symmetric in
 *  linear space — RISE_PER_SIGMA is the linear-space 10–90 width. Measuring in code space
 *  instead stretches the low tail (code 25.5 = linear 0.01, not 0.1) and inflates the width
 *  ~1.3×, which reads as a false "too wide" — the CPU reference inflates identically. */
function riseWidth(img: Rgba8): number {
  const y = Math.floor(H / 2)
  const row: number[] = []
  for (let x = 0; x < img.width; x++) row.push(srgbToLinear(img.data[(y * img.width + x) * 4]))
  const cross = (thresh: number): number => {
    for (let x = 1; x < row.length; x++) {
      if (row[x - 1] < thresh && row[x] >= thresh) {
        return x - 1 + (thresh - row[x - 1]) / (row[x] - row[x - 1]) // linear interp
      }
    }
    return NaN
  }
  return cross(0.9) - cross(0.1) // x@90% − x@10%, in linear light
}

/** Mean |Δ| in codes over a central crop (avoid the L/R borders, where clamp-vs-clamp
 *  edge handling legitimately differs). */
function meanErr(a: Rgba8, b: Rgba8, margin: number): number {
  let sum = 0, n2 = 0
  for (let y = 0; y < H; y++) {
    for (let x = margin; x < W - margin; x++) {
      const i = (y * W + x) * 4
      sum += Math.abs(a.data[i] - b.data[i]); n2++
    }
  }
  return sum / n2
}

const rig = await createRig()

test('WebGL2 available (a skipped run proves nothing)', () => {
  assert(rig.available.webgl2, 'WebGL2 unavailable — this gate cannot run')
})

const input = stepEdge()
const captured: Record<string, Rgba8> = {}

// Capture eagerly (test() only registers; rig closes below).
for (const [key, radius, dpr] of [['r6', 6, 1], ['r48', 48, 1], ['r96', 96, 1], ['r48d2', 48, 2]] as const) {
  try {
    captured[key] = await rig.captureRawGlsl({ width: W, height: H, input, passes: blurPasses(radius), dpr })
  } catch (err) {
    captured[key] = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) } // marks failure
    console.error(`  capture ${key} threw: ${err instanceof Error ? err.message : err}`)
  }
}
await rig.close()

for (const [key, radius, dpr] of [['r6', 6, 1], ['r48', 48, 1], ['r96', 96, 1]] as const) {
  test(`${key}: edge width matches a Gaussian of sigma=radius/3·dpr`, () => {
    const out = captured[key]
    const sigma = radius * SIGMA_PER_RADIUS * dpr
    const expected = RISE_PER_SIGMA * sigma
    const got = riseWidth(out)
    // 15% tolerance: the pyramid's dual-filter is not a perfect Gaussian, and the
    // intrinsic-sigma subtraction targets the right width but not to the pixel.
    assert(Number.isFinite(got) && Math.abs(got - expected) / expected < 0.15,
      `${key}: rise width ${got.toFixed(1)}px, expected ~${expected.toFixed(1)}px (sigma ${sigma})`)
  })

  test(`${key}: matches a CPU Gaussian reference, and is no passthrough`, () => {
    const out = captured[key]
    const sigma = radius * SIGMA_PER_RADIUS * dpr
    const ref = encodeToSrgb8(gaussianBlur(decodeToLinear(input), sigma))
    const margin = Math.min(Math.ceil(sigma * 4), 50)
    const errBlur = meanErr(out, ref, margin)
    const errNull = meanErr(input, ref, margin) // sharp input vs blurred ref
    assert(errBlur < 4, `${key}: mean error vs reference ${errBlur.toFixed(2)} codes (want < 4)`)
    assert(errBlur < errNull / 5, `${key}: not reproducing the reference — errBlur ${errBlur.toFixed(2)} vs errNull ${errNull.toFixed(2)}`)
    // Truest shape check: the pyramid's edge width matches the ground-truth Gaussian's,
    // both measured identically. Sidesteps any absolute-formula/colour-space subtlety.
    const wBlur = riseWidth(out), wRef = riseWidth(ref)
    assert(Math.abs(wBlur - wRef) / wRef < 0.1,
      `${key}: rise width ${wBlur.toFixed(1)}px vs reference ${wRef.toFixed(1)}px (>10% apart — wrong shape)`)
  })
}

test('dpr scaling: the dpr=2 blur is ~2× wider than dpr=1 (proves the coarse-offset dpr fix)', () => {
  const w1 = riseWidth(captured.r48)
  const w2 = riseWidth(captured.r48d2)
  const ratio = w2 / w1
  assert(Number.isFinite(ratio) && Math.abs(ratio - 2) < 0.3,
    `dpr2/dpr1 width ratio ${ratio.toFixed(2)}, expected ~2.0 (w1=${w1.toFixed(1)} w2=${w2.toFixed(1)})`)
})

await run('pyramid-blur-gpu')
