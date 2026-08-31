/**
 * Is the Kawase blur (a) actually ANIMATABLE — radius driven by a uniform, no recompile —
 * and (b) a blur of roughly the right width that varies smoothly with radius?
 *
 * The animatability check is the load-bearing one, and the reason this node exists: the
 * pyramid bakes radius into pass count/resolution at compile time, so a radius change
 * recompiles and can pop. Kawase must NOT. So:
 *   1. ANIMATABLE (mechanism-engaged): the compiled shader text is byte-identical across
 *      two very different radii — proving radius is read from a uniform, not baked. If it
 *      were baked, the texts would differ and this fails.
 *   2. SMOOTH SWEEP: driving ONLY the uniform value across a fine radius ramp gives a
 *      monotonically increasing edge width with no jump — the continuous, pop-free
 *      behaviour a uniform buys.
 *   3. SHAPE: static-radius edge width tracks a Gaussian of σ = radius/3 (looser tol —
 *      Kawase is a 5-pass approximation, not an exact Gaussian), measured in LINEAR light
 *      and against the CPU Gaussian reference.
 *
 * Method mirrors verify-pyramid-blur-gpu.ts: feed a hard step edge through the ACTUAL
 * compiled GLSL passes. Radius is a uniform, so a given radius is rendered by compiling
 * at that value (shader identical; only the baked uniform VALUE differs) and letting the
 * rig set it — exactly the runtime uniform fast-path.
 *
 * Run: npx tsx scripts/verify-kawase-blur-gpu.ts
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
const RISE_PER_SIGMA = 2.5631 // linear-space 10–90 rise of a Gaussian edge = 2.5631·σ

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

function stepEdge(): Rgba8 {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = x < W / 2 ? 0 : 255
    const i = (y * W + x) * 4
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
  }
  return { width: W, height: H, data }
}

interface CompiledPass { fragmentShader: string; pass: RawGlslPass }

/** Compile the kawase chain at a radius, returning the blur sub-passes (skipping the
 *  checkerboard source pass 0). The radius rides as per-sub-pass uniforms; the compiled
 *  VALUE is `radius`, which the rig then sets — the runtime uniform path. */
function blurPasses(radius: number): CompiledPass[] {
  const plan = compileGraph(
    [n('src', 'checkerboard'), n('fx', 'kawase_blur', { radius }), n('out', 'fragment_output')],
    [e('e1', 'src', 'color', 'fx', 'source'), e('e2', 'fx', 'color', 'out', 'color')],
  )
  if (!plan.success) throw new Error('compile failed: ' + JSON.stringify(plan.errors))
  return plan.passes.slice(1).map((p) => ({
    fragmentShader: p.fragmentShader,
    pass: {
      fragmentShader: p.fragmentShader,
      vertexShader: p.vertexShader,
      sampler: Object.keys(p.inputTextures)[0],
      scale: p.resolution ?? 1,
      // Pass all user uniforms at their compiled values: the per-pass radius uniform
      // (value = radius) and u_out_alpha=1 on the last pass.
      userUniforms: (p.userUniforms ?? []).map((u) => ({
        name: u.name, glslType: u.glslType as 'float', value: Array.isArray(u.value) ? u.value[0] : u.value,
      })),
    },
  }))
}

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** 10–90% rise width (px) of the red channel along the central row, in LINEAR light. */
function riseWidth(img: Rgba8): number {
  const y = Math.floor(H / 2)
  const row: number[] = []
  for (let x = 0; x < img.width; x++) row.push(srgbToLinear(img.data[(y * img.width + x) * 4]))
  const cross = (t: number): number => {
    for (let x = 1; x < row.length; x++) {
      if (row[x - 1] < t && row[x] >= t) return x - 1 + (t - row[x - 1]) / (row[x] - row[x - 1])
    }
    return NaN
  }
  return cross(0.9) - cross(0.1)
}

function meanErr(a: Rgba8, b: Rgba8, margin: number): number {
  let sum = 0, n2 = 0
  for (let y = 0; y < H; y++) for (let x = margin; x < W - margin; x++) {
    const i = (y * W + x) * 4
    sum += Math.abs(a.data[i] - b.data[i]); n2++
  }
  return sum / n2
}

const rig = await createRig()
const input = stepEdge()

test('WebGL2 available (a skipped run proves nothing)', () => {
  assert(rig.available.webgl2, 'WebGL2 unavailable — this gate cannot run')
})

// (1) ANIMATABLE: shader text identical across radii → radius is uniform-driven.
test('animatable: compiled shader is byte-identical across radii (uniform-driven, no recompile)', () => {
  const lo = blurPasses(12), hi = blurPasses(200)
  assert(lo.length === hi.length && lo.length === 5, `expected 5 blur passes, got ${lo.length}/${hi.length}`)
  for (let i = 0; i < lo.length; i++) {
    assert(lo[i].fragmentShader === hi[i].fragmentShader,
      `pass ${i} shader text DIFFERS between radius 12 and 200 — radius is baked, not a uniform`)
  }
  // And prove the radius really is present as a uniform (not silently dropped).
  const hasRadiusUniform = blurPasses(12).every((p) => p.pass.userUniforms!.some((u) => /radius/.test(u.name)))
  assert(hasRadiusUniform, 'no per-pass radius uniform found — cannot be animated')
})

// Capture a radius sweep eagerly (rig closes below).
const RADII = [8, 16, 24, 32, 48, 64, 96, 128, 192]
const capByRadius = new Map<number, Rgba8>()
for (const r of RADII) {
  try {
    capByRadius.set(r, await rig.captureRawGlsl({ width: W, height: H, input, passes: blurPasses(r).map((c) => c.pass), dpr: 1, faithfulResolution: true }))
  } catch (err) {
    capByRadius.set(r, { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) })
    console.error(`  capture r${r} threw: ${err instanceof Error ? err.message : err}`)
  }
}
await rig.close()

// (2) SMOOTH SWEEP: width increases monotonically with radius, no pop.
test('smooth sweep: edge width rises monotonically with radius (no pop, uniform-driven)', () => {
  const widths = RADII.map((r) => ({ r, w: riseWidth(capByRadius.get(r)!) }))
  for (const { r, w } of widths) assert(Number.isFinite(w) && w > 0, `r${r}: bad width ${w}`)
  for (let i = 1; i < widths.length; i++) {
    assert(widths[i].w >= widths[i - 1].w - 0.5,
      `width not monotonic: r${widths[i - 1].r}→${widths[i - 1].w.toFixed(1)}px then r${widths[i].r}→${widths[i].w.toFixed(1)}px`)
  }
})

// (3) SHAPE: width tracks σ = radius/3, and matches the CPU Gaussian reference.
// With the intrinsic-tent subtraction the whole r≥8 range holds within 12% of a true
// Gaussian (r<3.2 snaps to sharp — sub-pixel blur is unrepresentable past the tent floor,
// so it is deliberately excluded here; the sweep test still covers continuity from r=8).
for (const r of [8, 16, 24, 48, 96, 128, 192]) {
  test(`r${r}: edge width ≈ Gaussian σ=radius/3 (Kawase approximation)`, () => {
    const sigma = r * SIGMA_PER_RADIUS
    const expected = RISE_PER_SIGMA * sigma
    const got = riseWidth(capByRadius.get(r)!)
    assert(Number.isFinite(got) && Math.abs(got - expected) / expected < 0.12,
      `r${r}: rise width ${got.toFixed(1)}px, expected ~${expected.toFixed(1)}px (σ ${sigma.toFixed(1)})`)
  })
  test(`r${r}: matches a CPU Gaussian reference, and is no passthrough`, () => {
    const sigma = r * SIGMA_PER_RADIUS
    const ref = encodeToSrgb8(gaussianBlur(decodeToLinear(input), sigma))
    const margin = Math.min(Math.ceil(sigma * 4), 50)
    const errBlur = meanErr(capByRadius.get(r)!, ref, margin)
    const errNull = meanErr(input, ref, margin)
    assert(errBlur < errNull / 4, `r${r}: not reproducing a blur — errBlur ${errBlur.toFixed(2)} vs errNull ${errNull.toFixed(2)}`)
  })
}

await run('kawase-blur-gpu')
