// Frost candidate shaders + capture scaffolding for the Phase 9 bake-off.
//
// Every candidate is a REAL GPU pass, emitted for BOTH backends, reproducing the
// arithmetic of src/nodes/transform/reeded-glass.ts exactly where it matters:
//
//   * half-extent  = frost * 24 * u_dpr DEVICE px, isotropic, converted to UV by
//                    dividing by the target resolution (the node divides by
//                    u_viewport, which equals u_resolution in the engine).
//   * mirror fold  `tap = 1 - abs(fract(tap*0.5)*2 - 1)` on the tap UV, because
//                    the engine's pass textures are clamp-to-edge and the node
//                    folds by hand. The rig's samplers are clamp-only too.
//   * premultiplied accumulation `acc += s.rgb*s.a; aacc += s.a`, output
//                    `vec4(acc/max(aacc,1e-5), aacc/W)`. Alpha is MEASURED, never
//                    invented (repo rule).
//   * the frost branch is made genuinely NON-UNIFORM (see nonUniformFrost below)
//                    so WGSL's "textureSample only from uniform control flow"
//                    rule is exercised, exactly as it is when `frost` is wired.
//                    Every tap therefore uses textureSampleLevel(..., 0.0) — the
//                    only level available, since pass textures have no mips.
//
// Deliberate departures from the node, all of them confounder removal:
//   * no lens displacement. The user says the placement is right; the estimator
//     is what is on trial. sampleUV = uv.
//   * the gather runs in LINEAR light on a float16 intermediate, bracketed by an
//     ingest/egress pair. Two reasons: (a) gpu-rig silently ignores
//     filter:'linear' on pass 0 for WebGL2 (see phase9-webgl-filter-bug.ts), so
//     the gather must never BE pass 0, and (b) rgba8 intermediates put a 2-code
//     floor on dark content, which is a large slice of a speckle budget quoted
//     in codes. The node's own gamma-space averaging is a separate, already
//     documented defect; measuring it here would contaminate every candidate
//     equally and hide the sampling differences under test.
//   * alpha stays STRAIGHT through the intermediate, so the hardware bilinear
//     interpolates straight-alpha texels and the shader premultiplies by the
//     interpolated alpha — which is precisely what the node's sampler does.
//     (shaders.ts ingestPass premultiplies; that would be a different filter.)

import type { Backend, PassSpec, Rig, CaptureSpec } from './gpu-rig'
import type { Rgba8 } from './image'

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)) // 2.39996323 rad

// ---------------------------------------------------------------------------
// Per-backend syntax. Only declarations, casts and loop headers actually differ;
// the rig's WGSL preamble aliases float/vec2/vec3/vec4 so expressions are shared.
// ---------------------------------------------------------------------------
interface Sx {
  wg: boolean
  decl(type: string, name: string, init: string): string
  declVar(type: string, name: string): string
  loop(name: string, n: number): string
  f(expr: string): string
}

function sx(backend: Backend): Sx {
  const wg = backend === 'webgpu'
  return {
    wg,
    decl: (t, n, i) => (wg ? `var ${n}: ${t} = ${i};` : `${t} ${n} = ${i};`),
    declVar: (t, n) => (wg ? `var ${n}: ${t};` : `${t} ${n};`),
    loop: (n, k) =>
      wg ? `for (var ${n}: i32 = 0; ${n} < ${k}; ${n} = ${n} + 1) {` : `for (int ${n} = 0; ${n} < ${k}; ${n}++) {`,
    f: (e) => (wg ? `f32(${e})` : `float(${e})`),
  }
}

/** Literal with a guaranteed decimal point (GLSL ES rejects `5` where a float is wanted). */
function lit(v: number): string {
  const s = v.toPrecision(9)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

// ---------------------------------------------------------------------------
// Shared prelude: LOD-0 sampler, the node's exact reedHash, and IGN.
// ---------------------------------------------------------------------------
export function frostPrelude(backend: Backend): string {
  if (backend === 'webgpu') {
    return `
// LOD 0 explicitly: legal under non-uniform control flow, and the only level
// that exists (rig targets and engine pass textures are both single-mip).
fn S(p: vec2f) -> vec4f { return textureSampleLevel(srcTex, srcSamp, p, 0.0); }

// NOTE vs the node's WGSL: the node writes vec2<u32>, which is correct in the
// engine. It cannot be used here — the rig preamble does \`alias vec2 = vec2f\`,
// so \`vec2<u32>\` parses as \`vec2f<u32>\` and Tint rejects the module with
// "type 'vec2' does not take template arguments". vec2u is the same type.
fn reedHash(p: vec2f) -> vec2f {
  var q: vec2u = vec2u(bitcast<u32>(p.x), bitcast<u32>(p.y));
  q = q * vec2u(1103515245u) + vec2u(12345u);
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> vec2u(16u));
  return vec2f(q) / f32(0xFFFFFFFFu) * 2.0 - 1.0;
}

// Jimenez 2014 interleaved gradient noise. Constants are hand-tuned; do not
// perturb them. Wants integer pixel coordinates.
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
`
  }
  return `
vec4 S(vec2 p) { return texture(u_src, p); }

vec2 reedHash(vec2 p) {
  uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
`
}

/** Exact piecewise sRGB transfer, per backend (same maths as lib/color.ts). */
function srgbFns(backend: Backend): string {
  return backend === 'webgpu'
    ? `
fn toLin(c: vec3) -> vec3 {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
fn toSrgb(c: vec3) -> vec3 {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`
    : `
vec3 toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`
}

/** sRGB straight -> linear STRAIGHT (alpha untouched). Never pass 0's job to filter. */
export function frostIngestPass(backend: Backend): PassSpec {
  const s = sx(backend)
  return {
    prelude: srgbFns(backend),
    body: [s.decl('vec4', 'c', 'sampleSrc(uv)'), `  return vec4(toLin(c.rgb), c.a);`].join('\n  '),
    filter: 'nearest',
    float16: true,
  }
}

/** linear straight -> sRGB straight. */
export function frostEgressPass(backend: Backend): PassSpec {
  const s = sx(backend)
  return {
    prelude: srgbFns(backend),
    body: [s.decl('vec4', 'c', 'sampleSrc(uv)'), `  return vec4(toSrgb(c.rgb), c.a);`].join('\n  '),
    filter: 'nearest',
  }
}

/**
 * Point-spread egress: gain, then a SQRT compander, into 8-bit.
 *
 * A PSF at radius 48 spreads one impulse over ~7200 px, i.e. 0.03 of an 8-bit
 * code — unmeasurable without amplification, and sRGB encoding would destroy
 * proportionality. Plain linear 8-bit is not enough either: a peaky kernel (the
 * shipped lattice deposits 8 discrete ghosts, ~100x the density of a converged
 * disc) forces the gain down until the tail quantises to zero, and mass goes
 * missing — measured, 8.7% lost for C0 before this change. sqrt companding
 * gives ~16x finer steps near zero at the same peak, which recovers it, and the
 * rig cannot help here because its final pass is always rgba8.
 *
 * CPU side: value = (code/255)^2 / gain. See psfStats.
 */
export function frostPsfEgressPass(backend: Backend, gain: number): PassSpec {
  const s = sx(backend)
  return {
    body: [
      s.decl('vec4', 'c', 'sampleSrc(uv)'),
      `  return vec4(sqrt(clamp(c.rgb * ${lit(gain)}, vec3(0.0), vec3(1.0))), c.a);`,
    ].join('\n  '),
    filter: 'nearest',
  }
}

// ---------------------------------------------------------------------------
// Candidate description
// ---------------------------------------------------------------------------

/** Where the per-fragment random seed comes from. All are reachable by the node. */
export type SeedMode =
  /** floor(rg_coords * u_ref_size*0.25) — the shipped 4*u_dpr device-px lattice. */
  | 'lattice'
  /** floor(gl_FragCoord.xy) / floor(in.position.xy) — one seed per device pixel. */
  | 'pixel'
  /** floor(fragCoord / u_dpr) — one seed per CSS pixel; DPR-tier invariant. */
  | 'cssPixel'

export type Pattern =
  /** reedHash vec2 in [-1,1]^2 scaled by the half-extent: a SQUARE footprint. */
  | 'squareHash'
  /** same hash, mapped to a uniform disc: r = R*sqrt(u), theta = 2*pi*v. */
  | 'discHash'
  /** Vogel/sunflower: r_i = R*sqrt((i+0.5)/N), theta_i = rot + i*goldenAngle. */
  | 'sunflower'
  /** sunflower with the radius jittered inside its own annulus: r_i = R*sqrt((i+u_i)/N). */
  | 'sunflowerJit'

export type RotMode = 'none' | 'hash' | 'ign' | 'ignCss'
export type WeightMode = 'uniform' | 'gauss'

export interface FrostKernel {
  taps: number
  pattern: Pattern
  seed: SeedMode
  /** Only meaningful for the sunflower patterns. */
  rot?: RotMode
  weight?: WeightMode
  /** exp(-k*r^2) radial weight; only with weight:'gauss'. */
  gaussK?: number
  /**
   * 'baked' unrolls with literal offsets (what node codegen would emit);
   * 'procedural' keeps a literal-bound loop and computes offsets (used for the
   * 256-tap ground truth so the shader stays small). Both are numerically the
   * same pattern; only the ALU cost differs, which is why cost is also reported
   * as a tap count.
   */
  emit?: 'baked' | 'procedural'
}

export interface Candidate {
  id: string
  label: string
  kernel: FrostKernel
  /** true for the ground-truth anchor: too expensive to ship, scored against. */
  groundTruth?: boolean
  /** Pyramid prefilter depth; 0 = single-pass gather (all candidates but C6). */
  pyramidDepth?: number
  /** Gather half-extent multiplier, only used by the pyramid candidate. */
  radiusScale?: number
  note: string
}

/** Sunflower unit-disc offsets and weights, shared by the emitter and the CPU side. */
export function sunflowerOffsets(taps: number, weight: WeightMode, gaussK: number): Array<{ x: number; y: number; r: number; w: number }> {
  const out: Array<{ x: number; y: number; r: number; w: number }> = []
  for (let i = 0; i < taps; i++) {
    const r = Math.sqrt((i + 0.5) / taps)
    const th = i * GOLDEN_ANGLE
    const w = weight === 'gauss' ? Math.exp(-gaussK * r * r) : 1
    out.push({ x: Math.cos(th) * r, y: Math.sin(th) * r, r, w })
  }
  return out
}

// ---------------------------------------------------------------------------
// The gather pass.
//
// Uniform contract (set by captureFrost):
//   U.u_radius   half-extent in DEVICE px  (= frost * 24 * dpr)
//   U.u_params.x frost 0..1                (drives the branch, nothing else)
//   U.u_params.y seed phase                (integer; the re-roll knob)
//   U.u_params.z u_dpr
// ---------------------------------------------------------------------------
export function frostGatherPass(backend: Backend, k: FrostKernel): PassSpec {
  const s = sx(backend)
  const N = k.taps
  const weight: WeightMode = k.weight ?? 'uniform'
  const gaussK = k.gaussK ?? 2
  const rot: RotMode = k.rot ?? 'none'
  const emit: 'baked' | 'procedural' = k.emit ?? (N <= 32 ? 'baked' : 'procedural')
  const L: string[] = []
  const P = (x: string) => L.push('  ' + x)

  P(s.decl('vec2', 'res', 'U.u_resolution'))
  P(s.decl('vec2', 'fpx', 'uv * res'))
  P(s.decl('vec2', 'fup', 'vec2(fpx.x, res.y - fpx.y)')) // node's y-up frag coord
  P(s.decl('float', 'dpr', 'max(U.u_params.z, 1e-3)'))
  P(s.decl('float', 'phase', 'U.u_params.y'))
  // nonUniformFrost: alpha is in [0,1] for every possible texel, so
  // min(1, a+1) == 1 exactly, and `frost` is bit-identical to U.u_params.x.
  // But it is a texture-derived value, so the compiler must treat the branch
  // below as non-uniform — which is the situation a wired `frost` input creates
  // in the real node, and the reason every tap must be textureSampleLevel.
  P(s.decl('float', 'frost', 'U.u_params.x * min(1.0, S(uv).a + 1.0)'))
  // Radius is a LENGTH: it belongs in px. Dividing an isotropic px radius by the
  // per-axis resolution yields the correct anisotropic UV radius.
  P(s.decl('vec2', 'frad', 'vec2(U.u_radius) / res'))

  // --- seed ---------------------------------------------------------------
  if (k.seed === 'lattice') {
    // floor(rg_coords * u_ref_size*0.25) with rg_coords =
    // (fragXY_up - res*u_anchor)/(u_dpr*512) + u_anchor, u_anchor = 0.5.
    // => floor((fup - res*0.5)/(dpr*4) + 64)   [one cell = 4*u_dpr device px]
    P(s.decl('vec2', 'gc', 'floor((fup - res * 0.5) / (dpr * 4.0) + vec2(64.0)) + vec2(phase)'))
  } else if (k.seed === 'pixel') {
    P(s.decl('vec2', 'gc', 'floor(fpx) + vec2(phase)'))
  } else {
    P(s.decl('vec2', 'gc', 'floor(fup / dpr) + vec2(phase)'))
  }

  P(s.decl('vec3', 'acc', 'vec3(0.0)'))
  P(s.decl('float', 'aacc', '0.0'))
  P(s.decl('float', 'wsum', '0.0'))
  P(s.declVar('vec4', 'outc'))
  P(`if (frost > 0.001) {`)

  // --- rotation -----------------------------------------------------------
  const TAU = '6.28318530718'
  if (rot !== 'none') {
    const e =
      rot === 'hash'
        ? `(reedHash(gc + vec2(11.7, -23.9)).x * 0.5 + 0.5) * ${TAU}`
        : rot === 'ign'
          ? `ign(floor(fpx) + vec2(phase)) * ${TAU}`
          : `ign(floor(fup / dpr) + vec2(phase)) * ${TAU}`
    P(`  ${s.decl('float', 'rot', e)}`)
    P(`  ${s.decl('float', 'cr', 'cos(rot)')}`)
    P(`  ${s.decl('float', 'sr', 'sin(rot)')}`)
  }

  const tapBody = (jitExpr: string, wExpr: string, sfx: string) => {
    P(`    ${s.decl('vec2', `tp${sfx}`, `uv + (${jitExpr})`)}`)
    P(`    tp${sfx} = vec2(1.0) - abs(fract(tp${sfx} * vec2(0.5)) * vec2(2.0) - vec2(1.0));`)
    P(`    ${s.decl('vec4', `sm${sfx}`, `S(tp${sfx})`)}`)
    P(`    acc = acc + sm${sfx}.rgb * sm${sfx}.a * (${wExpr});`)
    P(`    aacc = aacc + sm${sfx}.a * (${wExpr});`)
    P(`    wsum = wsum + (${wExpr});`)
  }

  if (k.pattern === 'squareHash' || k.pattern === 'discHash') {
    // Loop with a literal bound, exactly as the node writes it.
    P(`  ${s.loop('i', N)}`)
    P(`    ${s.decl('float', 'fi', s.f('i'))}`)
    P(`    ${s.decl('vec2', 'h', 'reedHash(gc + vec2(fi * 7.31, fi * -11.13))')}`)
    if (k.pattern === 'squareHash') {
      tapBody('h * frad', '1.0', '')
    } else {
      P(`    ${s.decl('float', 'rr', 'sqrt(h.x * 0.5 + 0.5)')}`)
      P(`    ${s.decl('float', 'th', `${TAU} * (h.y * 0.5 + 0.5)`)}`)
      tapBody('vec2(cos(th), sin(th)) * rr * frad', '1.0', '')
    }
    P(`  }`)
  } else if (emit === 'procedural') {
    const jitR =
      k.pattern === 'sunflowerJit'
        ? 'reedHash(gc + vec2(fi * 3.17 + 0.5, fi * -5.41 - 0.5)).y * 0.5 + 0.5'
        : '0.5'
    P(`  ${s.loop('i', N)}`)
    P(`    ${s.decl('float', 'fi', s.f('i'))}`)
    P(`    ${s.decl('float', 'jr', jitR)}`)
    P(`    ${s.decl('float', 'ri', `sqrt((fi + jr) * ${lit(1 / N)})`)}`)
    P(`    ${s.decl('float', 'th', `${rot === 'none' ? '0.0' : 'rot'} + fi * ${lit(GOLDEN_ANGLE)}`)}`)
    const w = weight === 'gauss' ? `exp(${lit(-gaussK)} * ri * ri)` : '1.0'
    P(`    ${s.decl('float', 'wt', w)}`)
    tapBody('vec2(cos(th), sin(th)) * ri * frad', 'wt', '')
    P(`  }`)
  } else {
    // Baked: literal unit-disc offsets, rotated by the per-fragment angle.
    // This is what node codegen emits, and it costs one sincos per fragment
    // rather than one per tap.
    const offs = sunflowerOffsets(N, weight, gaussK)
    for (let i = 0; i < N; i++) {
      const o = offs[i]
      if (k.pattern === 'sunflowerJit') {
        // radius must be re-derived per fragment because it is jittered
        P(`    ${s.decl('float', `jr${i}`, `reedHash(gc + vec2(${lit(i * 3.17 + 0.5)}, ${lit(i * -5.41 - 0.5)})).y * 0.5 + 0.5`)}`)
        P(`    ${s.decl('float', `ri${i}`, `sqrt((${lit(i)} + jr${i}) * ${lit(1 / N)})`)}`)
        const th = `${rot === 'none' ? '0.0' : 'rot'} + ${lit(i * GOLDEN_ANGLE)}`
        P(`    ${s.decl('float', `th${i}`, th)}`)
        const w = weight === 'gauss' ? `exp(${lit(-gaussK)} * ri${i} * ri${i})` : '1.0'
        tapBody(`vec2(cos(th${i}), sin(th${i})) * ri${i} * frad`, w, `${i}`)
      } else {
        const dx = lit(o.x)
        const dy = lit(o.y)
        const jit =
          rot === 'none'
            ? `vec2(${dx}, ${dy}) * frad`
            : `vec2(cr * ${dx} - sr * ${dy}, sr * ${dx} + cr * ${dy}) * frad`
        tapBody(jit, lit(o.w), `${i}`)
      }
    }
  }

  P(`  outc = vec4(acc / vec3(max(aacc, 1e-5)), aacc / max(wsum, 1e-5));`)
  P(`} else {`)
  P(`  outc = S(uv);`)
  P(`}`)
  P(`return outc;`)

  return { prelude: frostPrelude(backend), body: L.join('\n'), filter: 'linear', float16: true }
}

// ---------------------------------------------------------------------------
// Pyramid prefilter (candidate C6). Bjorge dual-filter down/up at reduced
// resolution, then a small per-pixel gather. Cost becomes independent of the
// frost radius, which is the only thing that is affordable at frost = 1 —
// but it needs a compiler concept Sombra does not have (a node owning
// auxiliary internal passes), so it is priced here, not shipped.
// ---------------------------------------------------------------------------
function dualDown(backend: Backend, scale: number): PassSpec {
  const s = sx(backend)
  return {
    body: [
      s.decl('vec4', 'sum', 'sampleSrc(uv) * 4.0'),
      `  sum = sum + sampleSrc(uv + vec2(-1.0, -1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2( 1.0,  1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2( 1.0, -1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2(-1.0,  1.0) * U.u_texel);`,
      `  return sum / 8.0;`,
    ].join('\n'),
    filter: 'linear',
    float16: true,
    scale,
  }
}

function dualUp(backend: Backend, scale: number): PassSpec {
  const s = sx(backend)
  return {
    body: [
      s.decl('vec4', 'sum', 'vec4(0.0)'),
      `  sum = sum + sampleSrc(uv + vec2(-1.0,  0.0) * U.u_texel) * 2.0;`,
      `  sum = sum + sampleSrc(uv + vec2( 1.0,  0.0) * U.u_texel) * 2.0;`,
      `  sum = sum + sampleSrc(uv + vec2( 0.0, -1.0) * U.u_texel) * 2.0;`,
      `  sum = sum + sampleSrc(uv + vec2( 0.0,  1.0) * U.u_texel) * 2.0;`,
      `  sum = sum + sampleSrc(uv + vec2(-1.0, -1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2( 1.0, -1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2(-1.0,  1.0) * U.u_texel);`,
      `  sum = sum + sampleSrc(uv + vec2( 1.0,  1.0) * U.u_texel);`,
      `  return sum / 12.0;`,
    ].join('\n'),
    filter: 'linear',
    float16: true,
    scale,
  }
}

/** Fetch count actually issued per output pixel, pyramid amortised over full res. */
export function fetchesPerPixel(c: Candidate): number {
  const gather = c.kernel.taps
  if (!c.pyramidDepth) return gather
  let pyr = 0
  for (let d = 1; d <= c.pyramidDepth; d++) pyr += 5 / 4 ** d // down: 5 taps at 1/4^d px
  for (let d = c.pyramidDepth; d >= 1; d--) pyr += 8 / 4 ** (d - 1) // up: 8 taps
  return gather + pyr
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
export interface FrostCaptureOpts {
  rig: Rig
  backend: Backend
  input: Rgba8
  candidate: Candidate
  /** half-extent in DEVICE px = frost * 24 * dpr. */
  radiusPx: number
  frost: number
  dpr: number
  seedPhase?: number
  /** PSF mode: skip the sRGB egress, amplify linearly by this gain instead. */
  psfGain?: number
}

export function frostPasses(o: Omit<FrostCaptureOpts, 'rig' | 'input'>): PassSpec[] {
  const { backend, candidate: c } = o
  const passes: PassSpec[] = [frostIngestPass(backend)]
  if (c.pyramidDepth) {
    for (let d = 1; d <= c.pyramidDepth; d++) passes.push(dualDown(backend, 1 / 2 ** d))
    for (let d = c.pyramidDepth - 1; d >= 0; d--) passes.push(dualUp(backend, 1 / 2 ** d))
  }
  passes.push(frostGatherPass(backend, c.kernel))
  passes.push(o.psfGain ? frostPsfEgressPass(backend, o.psfGain) : frostEgressPass(backend))
  return passes
}

/**
 * Run a candidate. Asserts the frame is neither black nor constant — an
 * out-of-memory or internal WebGPU error is unscoped by the rig and would come
 * back as a plausible, perfectly smooth, entirely wrong image.
 */
export async function captureFrost(o: FrostCaptureOpts): Promise<Rgba8> {
  const c = o.candidate
  const radius = c.pyramidDepth ? o.radiusPx * (c.radiusScale ?? 1) : o.radiusPx
  const spec: CaptureSpec = {
    backend: o.backend,
    width: o.input.width,
    height: o.input.height,
    input: o.input,
    radius,
    params: [o.frost, o.seedPhase ?? 0, o.dpr, 0],
    passes: frostPasses({
      backend: o.backend,
      candidate: c,
      radiusPx: o.radiusPx,
      frost: o.frost,
      dpr: o.dpr,
      seedPhase: o.seedPhase,
      psfGain: o.psfGain,
    }),
  }
  const out = await o.rig.capture(spec)
  assertLive(out, `${c.id}/${o.backend}/r${o.radiusPx}`)
  return out
}

/** Non-black, non-constant. Cheap insurance against a silently dropped draw. */
export function assertLive(img: Rgba8, what: string): void {
  let sum = 0
  let min = 255
  let max = 0
  for (let p = 0; p < img.width * img.height; p++) {
    const v = img.data[p * 4] + img.data[p * 4 + 1] + img.data[p * 4 + 2]
    sum += v
    const l = img.data[p * 4 + 1]
    if (l < min) min = l
    if (l > max) max = l
  }
  if (sum === 0) throw new Error(`capture ${what}: frame is entirely black`)
  if (max - min < 1) throw new Error(`capture ${what}: frame is constant (green ${min}) — draw likely dropped`)
}

// ---------------------------------------------------------------------------
// Stimuli that the corpus does not provide
// ---------------------------------------------------------------------------

/**
 * A sparse grid of small opaque white squares on opaque black, for PSF
 * measurement. Spacing must exceed 2*R plus the patch half-width so the
 * responses never overlap.
 */
export function impulseField(
  size: number,
  spacing: number,
  dot: number,
): { img: Rgba8; centers: Array<[number, number]>; dotMass: number } {
  const img: Rgba8 = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
  for (let p = 0; p < size * size; p++) img.data[p * 4 + 3] = 255 // opaque black
  const centers: Array<[number, number]> = []
  const half = Math.floor(dot / 2)
  for (let cy = spacing; cy <= size - spacing; cy += spacing)
    for (let cx = spacing; cx <= size - spacing; cx += spacing) {
      centers.push([cx, cy])
      for (let y = cy - half; y <= cy - half + dot - 1; y++)
        for (let x = cx - half; x <= cx - half + dot - 1; x++) {
          const i = (y * size + x) * 4
          img.data[i] = 255
          img.data[i + 1] = 255
          img.data[i + 2] = 255
        }
    }
  return { img, centers, dotMass: dot * dot }
}

/** Deterministic per-pixel iid noise added to an image, in 8-bit codes. */
export function addNoise(img: Rgba8, amp: number, seed: number): Rgba8 {
  const out: Rgba8 = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  const rnd = mulberry32(seed)
  for (let p = 0; p < img.width * img.height; p++) {
    const n = (rnd() * 2 - 1) * amp
    for (let c = 0; c < 3; c++) out.data[p * 4 + c] = Math.round(img.data[p * 4 + c] + n)
  }
  return out
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Force an image onto a block x block grid of constant values (the known-bad). */
export function forceBlocks(img: Rgba8, block: number): Rgba8 {
  const { width: W, height: H } = img
  const out: Rgba8 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }
  for (let by = 0; by < H; by += block)
    for (let bx = 0; bx < W; bx += block) {
      const y1 = Math.min(by + block, H)
      const x1 = Math.min(bx + block, W)
      const acc = [0, 0, 0, 0]
      let n = 0
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const i = (y * W + x) * 4
          for (let c = 0; c < 4; c++) acc[c] += img.data[i + c]
          n++
        }
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const i = (y * W + x) * 4
          for (let c = 0; c < 4; c++) out.data[i + c] = Math.round(acc[c] / n)
        }
    }
  return out
}

// ---------------------------------------------------------------------------
// Resampling, for the DPR-flip proxy
// ---------------------------------------------------------------------------
export function resampleBilinear(img: Rgba8, w: number, h: number): Rgba8 {
  const out: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  const sxr = img.width / w
  const syr = img.height / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * syr - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(img.height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * sxr - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(img.width - 1, x0 + 1)
      const tx = fx - x0
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c]
        const b = img.data[(y0 * img.width + x1) * 4 + c]
        const d = img.data[(y1 * img.width + x0) * 4 + c]
        const e = img.data[(y1 * img.width + x1) * 4 + c]
        out.data[(y * w + x) * 4 + c] =
          a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + d * (1 - tx) * ty + e * tx * ty
      }
    }
  }
  return out
}

/** Nearest-neighbour up-scale of a CSS-space stimulus onto a device grid. */
export function rasterizeAtDpr(cssImg: Rgba8, dpr: number): Rgba8 {
  const w = Math.floor(cssImg.width * dpr)
  const h = Math.floor(cssImg.height * dpr)
  return resampleBilinear(cssImg, w, h)
}

// ---------------------------------------------------------------------------
// Cost: wall-clock timing. Only trustworthy if it scales with tap count — the
// caller must run costCalibration() and honour its verdict.
// ---------------------------------------------------------------------------
export async function timeCapture(rig: Rig, spec: CaptureSpec, reps: number): Promise<{ medianMs: number; minMs: number }> {
  const ts: number[] = []
  await rig.capture(spec) // warm the pipeline cache / shader compile
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now()
    await rig.capture(spec)
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  return { medianMs: ts[Math.floor(ts.length / 2)], minMs: ts[0] }
}
