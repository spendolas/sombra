/**
 * Reeded Glass — cylindrical lens distortion through ribbed glass.
 * Each rib is a cylindrical lens. The deviation is a *linearised thin-prism*
 * model, not Snell's law: displacement is taken proportional to the surface
 * slope, which is only valid for small slopes. Real refraction self-limits as
 * the slope grows; this does not, so the profile is capped instead (see
 * registerLensFn). The surface normal varies across the rib — flat at center,
 * steep at edges — producing magnification at centers and compression at seams.
 *
 * Two-level hierarchy:
 *   ribType: Straight | Wave | Circular | Noise
 *     Wave    → waveShape sub-select (Sine, Triangle, Square, Sawtooth, Chevron)
 *     Noise   → noiseType sub-select (Simplex, Value, Worley)
 *     Circular / Straight → no sub-select
 */

import type { NodeDefinition, GLSLContext } from '../types'
import { addFunction, getSpatialParams } from '../types'
import { registerNoiseType, resolveNoiseFn, getIRNoiseFunctions } from '../noise/noise-functions'
import { COLOR_GLSL_HELPERS, COLOR_IR_HELPERS } from '../shared/color-space'
import type { IRContext, IRFunction, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, declare, binary, raw } from '../../compiler/ir/types'

const RIB_TYPE_OPTIONS = [
  { value: 'straight', label: 'Straight' },
  { value: 'wave', label: 'Wave' },
  { value: 'circular', label: 'Circular' },
  { value: 'noise', label: 'Noise' },
]

const WAVE_SHAPE_OPTIONS = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'chevron', label: 'Chevron' },
  { value: 'u_shape', label: 'U-Shape' },
]

const NOISE_TYPE_OPTIONS = [
  { value: 'simplex', label: 'Simplex' },
  { value: 'value', label: 'Value' },
  { value: 'worley', label: 'Worley' },
]

const DIRECTION_OPTIONS = [
  { value: 'vertical', label: 'Vertical' },
  { value: 'horizontal', label: 'Horizontal' },
]

/**
 * The rib profile. Returns both quantities a rib can move a ray with:
 *
 *   .x — the remapped main-axis coordinate (cross-rib refraction)
 *   .y — the rib's glass thickness, already scaled by (ior-1) × amp
 *
 * Cross-rib refraction comes from the surface *slope*, which rises from zero at
 * the rib centre to steep at the edges, producing magnification at centres,
 * compression and caustics at seams, and image inversion near the edges (at
 * every setting, including the defaults — not only at high ior × curvature).
 *
 * Thickness is the arc's *height* (sagitta) and is the reason the `.y` term
 * exists at all. An ideal cylinder has zero optical power along its own axis:
 * the refraction term (ηc₁−c₂)·n vanishes in y for a normal n = (nx, 0, nz), so
 * cross-rib refraction alone can never bend a line running parallel to the ribs.
 * What does bend one is crossing a slab of *varying* thickness off-axis — the
 * lateral shift is path-length × tanθ × (1 − 1/n), and the path length through a
 * rib is its height profile. That is a function of the cross-rib coordinate, so
 * it scallops parallel lines: bowed at rib centres, pinned at seams. See `bow`.
 *
 * Parameters:
 *   coord     — main-axis UV coordinate
 *   ribW      — rib width in UV space
 *   ior       — index of refraction (1.0 = no effect, 1.5 = glass, 2.0 = heavy)
 *   curvature — arc shape. 0-1 rounds the profile out (capped at 0.99, so 1 is
 *               not a true semicircle); above 1 the arc stays put and the
 *               refraction is amplified instead.
 */
const REED_LENS_BODY = `float local = mod(coord, ribW) / ribW;
  float x = (local - 0.5) * 2.0;  // -1 to 1

  // Circular arc surface slope: dh/dx = -x / sqrt(R² - x²)
  float c = clamp(curvature, 0.01, 1.0);
  float amp = curvature > 1.0 ? curvature : 1.0;
  float c2 = min(c, 0.99);
  float x2 = x * x * c2 * c2;
  float slope = x * c2 / sqrt(max(1.0 - x2, 0.001));

  // Refraction displacement: proportional to slope × (ior - 1) × amplifier
  // Negative sign: convex lens pushes rays toward center
  float disp = -slope * (ior - 1.0) * 0.5 * amp;

  // Mirror-fold rather than clamp. clamp() saturates a *position*, so the whole
  // saturated band samples one identical source column — d(sample)/d(screen) is
  // exactly zero and it reads as a hard straight line at the rib edge. The fold
  // is the identity on [0,1] (so it changes nothing that was not already
  // clamping), stays inside the rib so the floor() containment holds, and
  // preserves |derivative| so it adds no new flat regions of its own.
  float lensed = local + disp;
  lensed = 1.0 - abs(fract(lensed * 0.5) * 2.0 - 1.0);

  // Arc height above the chord, in rib half-widths: 0 at the seams, max at the
  // rib centre. Pre-scaled by the same (ior-1) × amp the refraction uses.
  float sag = (sqrt(max(1.0 - x2, 0.0)) - sqrt(max(1.0 - c2 * c2, 0.0))) / c2;

  // Cross-rib derivative d(sampled)/d(screen), in closed form:
  //   d(slope)/d(local) = 2·c2/(1-x²c2²)^{3/2}, so L' = 1 - A/(1-x2)^{3/2}
  //   with A = (ior-1)·amp·c2.
  // |L'| < 1 is magnification and harmless. |L'| > 1 is MINIFICATION: one screen
  // pixel spans |L'| source pixels, which a single bilinear tap cannot represent
  // — that is the ragged/sparkling rib edge. Onset is curvature 0.8095 at ior
  // 1.5 (the default is 0.80, one slider step below), and |L'| reaches 175 at
  // curvature 1.0 and 352 at 2.0. Returned so the caller can size its filter.
  float lp = 1.0 - (ior - 1.0) * amp * c2 / pow(max(1.0 - x2, 1e-6), 1.5);

  return vec3((floor(coord / ribW) + lensed) * ribW, sag * (ior - 1.0) * amp, lp);`

function registerLensFn(ctx: GLSLContext): void {
  addFunction(ctx, 'reedLens', `vec3 reedLens(float coord, float ribW, float ior, float curvature) {
  ${REED_LENS_BODY}
}`)
}

/**
 * The rib field w(p) in screen space, as a function of a point in the SRT'd
 * pattern basis.
 *
 * Templated on the point rather than emitted once because the delta transform
 * below needs w at p±ε to recover the rib gradient by finite difference, and
 * three copies of one expression must not be able to drift apart.
 */
interface ScreenWave {
  expr: (p: string) => string
  /** False for shapes with a jump discontinuity — a finite difference across
   *  the jump measures the jump, not the slope. */
  differentiable: boolean
  /** False when w depends on the perp axis alone, which lets us skip two
   *  evaluations per fragment (two *noise* fetches, for noise ribs). */
  dependsOnMain: boolean
}

/**
 * The coordinate space a lens evaluation happens in.
 *
 * The node produces two outputs from the same optics — `color` (a filtered image,
 * in screen space) and `coords` (a remapped UV, in frozen-ref space). Those used to
 * be two hand-written implementations, and they drifted: different chevron
 * formulas, opposite y handedness, and only one of them ever learned about the rib
 * gradient, srt_rotate or srt_scale. Describing the space as data instead lets ONE
 * set of emitters serve both, so they cannot disagree again.
 *
 * The two spaces differ in exactly four ways:
 *
 *   screen  point = SRT'd v_uv       per-axis, so resMain != resPerp
 *                                    aspect conjugation needed to rotate rigidly
 *   ref     point = SRT'd auto_uv    isotropic: one unit is u_dpr*u_ref_size device
 *                                    px on BOTH axes, so no conjugation (applying
 *                                    one, as the old ref path did, made the
 *                                    rotation non-rigid and skewed the rib angle)
 */
interface Basis {
  /** vec2 expression: the SRT'd point the rib pattern is evaluated at. */
  point: string
  /** Device px per 1 unit of the main / perp axis. */
  resMain: string
  resPerp: string
  /** Rib width expressed in this basis. */
  ribUV: string
  /** Convert a vec2 in this basis to device px (for isotropic noise/circular). */
  toPx: (p: string) => string
  /** Aspect conjugation for the delta rotate — '1.0' where the space is already
   *  isotropic. */
  asp: string
  rad: string
  scale: string
  /** Amplitude / wavelength expressed in this basis. */
  amp: string
  wl: string
  /** Wavelength in device px. */
  wlPx: string
}

function screenWave(o: {
  ribType: string
  waveShape: string
  noiseType: string
  isVert: boolean
  basis: Basis
}): ScreenWave | null {
  const { isVert, basis } = o
  const ampScr = basis.amp
  const wlScr = basis.wl
  const wlPx = basis.wlPx
  const resMain = basis.resMain
  const resPerp = basis.resPerp
  const perp = (p: string) => (isVert ? `(${p}).y` : `(${p}).x`)
  const main = (p: string) => (isVert ? `(${p}).x` : `(${p}).y`)
  const perpOnly = (expr: (p: string) => string, differentiable = true): ScreenWave =>
    ({ expr, differentiable, dependsOnMain: false })

  if (o.ribType === 'wave') {
    switch (o.waveShape) {
      case 'sine':
        return perpOnly((p) => `sin(${perp(p)} / ${wlScr} * 6.28318) * ${ampScr}`)
      case 'triangle':
        return perpOnly((p) => `(abs(fract(${perp(p)} / ${wlScr}) - 0.5) * 4.0 - 1.0) * ${ampScr}`)
      case 'square':
        // Piecewise constant: the true gradient is zero almost everywhere and a
        // finite difference only ever sees the jump rows. Refract cross-rib only.
        return perpOnly((p) => `(step(0.5, fract(${perp(p)} / ${wlScr})) * 2.0 - 1.0) * ${ampScr}`, false)
      case 'sawtooth':
        return perpOnly((p) => `(fract(${perp(p)} / ${wlScr}) * 2.0 - 1.0) * ${ampScr}`, false)
      case 'chevron':
        return perpOnly((p) => `abs(${perp(p)} * ${resPerp} / ${wlPx}) * ${ampScr} * sin(${perp(p)} / ${wlScr} * 6.28318)`)
      case 'u_shape':
        return perpOnly((p) => `(pow(abs(fract(${perp(p)} / ${wlScr}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampScr}`)
    }
    return null
  }
  if (o.ribType === 'circular') {
    // Rings are built from the SRT'd point, so scale/translate move them — the
    // frozen-ref path has always done this and the screen path used to read raw
    // v_uv, which left the two disagreeing under any SRT.
    return { expr: (p) => `sin(length(${basis.toPx(p)}) / ${wlPx} * 6.28318) * ${ampScr}`, differentiable: true, dependsOnMain: true }
  }
  if (o.ribType === 'noise') {
    const fn = resolveNoiseFn(o.noiseType)
    return {
      expr: (p) => `(${fn}(vec3(${perp(p)} * ${resPerp} / ${wlPx}, ${main(p)} * ${resMain} / ${wlPx}, 0.0)) * 2.0 - 1.0) * ${ampScr}`,
      differentiable: true,
      dependsOnMain: true,
    }
  }
  return null
}

/**
 * Map the lens result from the SRT'd pattern basis back to a screen-UV offset.
 *
 * `disp` is a scalar measured along the pattern main axis, which is only the
 * on-screen cross-rib direction when the ribs are straight and unrotated.
 * Everything else puts a perpendicular component into the offset, and each one
 * used to be dropped on the floor:
 *
 *  - a wave/circular/noise rib tilts the field, so refraction runs along ∇φ,
 *    not along the main axis. The first-order inverse of φ = main + w is
 *    disp·∇φ/|∇φ|², which collapses to (disp, 0) at ∇w = 0 — straight ribs are
 *    unchanged by construction.
 *  - `bow` displaces along the perp axis (rib thickness, see reedLens).
 *  - `srt_rotate` rotates the basis, so the offset needs R(−θ) to get back.
 *  - `srt_scale` divides the basis, so a pattern-space delta reaches
 *    proportionally further on screen.
 *
 * Emitting all of it at one site is what stops the four rib types and the two
 * backends from each growing their own version.
 */
interface RibGradient { lines: string[]; gm: string; gp: string; den: string }

/**
 * ∂w/∂main and ∂w/∂perp of the rib field, plus |∇φ|² — emitted ONCE per fragment.
 *
 * Split out from the delta so the seam-coverage sub-samples can reuse it instead
 * of re-differencing the wave field. That is the whole reason noise ribs stay
 * affordable: three sub-samples cost three `reedLens` calls, not fifteen noise
 * evaluations. Differencing in the pattern basis (not on screen) is what makes
 * srt_scale cancel here and apply exactly once, in emitDeltaTail.
 */
function emitRibGradient(o: {
  id: string
  sfx?: string
  isVert: boolean
  basis: Basis
  wave: ScreenWave | null
}): RibGradient {
  const { id, isVert, basis, wave } = o
  const sfx = o.sfx ?? ''
  const srtScr = basis.point
  const resMain = basis.resMain
  const resPerp = basis.resPerp
  const gm = `rg_gm${sfx}_${id}`
  const gp = `rg_gp${sfx}_${id}`
  const den = `rg_den${sfx}_${id}`
  const lines: string[] = []

  if (wave && wave.differentiable && wave.dependsOnMain) {
    const em = isVert ? `vec2(1.0 / ${resMain}, 0.0)` : `vec2(0.0, 1.0 / ${resMain})`
    lines.push(`vec2 rg_em${sfx}_${id} = ${em};`)
    lines.push(`float ${gm} = (${wave.expr(`${srtScr} + rg_em${sfx}_${id}`)} - ${wave.expr(`${srtScr} - rg_em${sfx}_${id}`)}) * 0.5 * ${resMain};`)
    // The first-order inverse below divides by (1 + gm), which vanishes exactly
    // where the rib field folds along its own main axis — the map stops being
    // invertible and the deviation is unbounded. Reachable: for circular/noise
    // ribs |∂w/∂main| hits 1 at amplitude/wavelength = 1/2π ≈ 0.159, i.e.
    // amplitude 32 at wavelength 200, both inside the sliders. Clamping the
    // gradient (not the quotient) keeps the sign and caps the amplification;
    // clamping `den` alone does nothing, because the numerator vanishes too.
    lines.push(`${gm} = max(${gm}, -0.75);`)
  } else {
    // Pure cross-rib fields (every wave shape) have no main-axis dependence at
    // all, so this is exact, not a fallback — and it keeps `den` at 1.
    lines.push(`float ${gm} = 0.0;`)
  }
  if (wave && wave.differentiable) {
    const ep = isVert ? `vec2(0.0, 1.0 / ${resPerp})` : `vec2(1.0 / ${resPerp}, 0.0)`
    lines.push(`vec2 rg_ep${sfx}_${id} = ${ep};`)
    lines.push(`float ${gp} = (${wave.expr(`${srtScr} + rg_ep${sfx}_${id}`)} - ${wave.expr(`${srtScr} - rg_ep${sfx}_${id}`)}) * 0.5 * ${resMain};`)
  } else {
    lines.push(`float ${gp} = 0.0;`)
  }
  lines.push(`float ${den} = (1.0 + ${gm}) * (1.0 + ${gm}) + ${gp} * ${gp};`)
  return { lines, gm, gp, den }
}

/**
 * Map ONE sub-sample's lens result from the SRT'd pattern basis back to a
 * screen-UV offset, reusing the shared rib gradient.
 *
 * `disp` is a scalar measured along the pattern main axis, which is only the
 * on-screen cross-rib direction when the ribs are straight and unrotated.
 * Everything else puts a perpendicular component into the offset:
 *
 *  - a wave/circular/noise rib tilts the field, so refraction runs along ∇φ, not
 *    along the main axis. The first-order inverse of φ = main + w is
 *    disp·∇φ/|∇φ|², which collapses to (disp, 0) at ∇w = 0 — straight ribs are
 *    unchanged by construction.
 *  - `bow` displaces along the perp axis (rib thickness, see reedLens).
 *  - `srt_rotate` rotates the basis, so the offset needs R(−θ) to get back.
 *  - `srt_scale` divides the basis, so a pattern-space delta reaches
 *    proportionally further on screen.
 */
function emitDeltaTail(o: {
  id: string
  sfx: string
  isVert: boolean
  disp: string
  bowPerp: string
  basis: Basis
  grad: RibGradient
}): { lines: string[]; delta: string } {
  const { id, sfx, isVert, disp, bowPerp, basis, grad } = o
  const aspScr = basis.asp
  const radScr = basis.rad
  const scale = basis.scale
  const resMain = basis.resMain
  const resPerp = basis.resPerp
  const { gm, gp, den } = grad
  const d = `rg_d${sfx}_${id}`
  const lines: string[] = []
  const dMain = `(${disp} * (1.0 + ${gm}) / ${den})`
  const dPerp = `(${disp} * ${gp} * (${resMain} / ${resPerp}) / ${den} + ${bowPerp})`
  lines.push(`vec2 ${d} = ${isVert ? `vec2(${dMain}, ${dPerp})` : `vec2(${dPerp}, ${dMain})`};`)
  // Undo the pattern basis: R(-rad) under the same aspect conjugation the
  // forward rotate uses, then re-apply the scale the basis divided out.
  lines.push(`${d}.x *= ${aspScr};`)
  lines.push(`${d} = vec2(${d}.x * cos(${radScr}) + ${d}.y * sin(${radScr}), -${d}.x * sin(${radScr}) + ${d}.y * cos(${radScr}));`)
  lines.push(`${d}.x /= ${aspScr};`)
  lines.push(`${d} *= vec2(${scale});`)
  return { lines, delta: d }
}

/**
 * reedLens + disp + bow + delta, evaluated `offPx` device px along the seam
 * normal from the pixel centre.
 *
 * The rib phase is FIRST-ORDER EXTRAPOLATED rather than re-derived: Δwm =
 * t·|∇φ|·ribUV, which is exact for straight ribs and accurate to O(¼·w″) over
 * the ±0.5 px a pixel spans. That is what lets a sub-sample cost one reedLens
 * call and no wave-field evaluation at all.
 */
function emitLensTail(o: {
  id: string
  sfx: string
  isVert: boolean
  offPx: string
  wmCentre: string
  gradRate: string
  ior: string
  curvature: string
  ribWidth: string
  bow: string
  basis: Basis
  grad: RibGradient
}): { lines: string[]; delta: string; lens: string } {
  const { id, sfx, isVert, offPx, wmCentre, gradRate, basis } = o
  const ribUVScreen = basis.ribUV
  const resPerp = basis.resPerp
  const lines: string[] = []
  // `rg_swm`, not `rg_wm`: the centre sub-sample has an empty suffix, and
  // `rg_wm_<id>` is already the frozen-ref path's warped main axis.
  const wm = `rg_swm${sfx}_${id}`
  const lens = `rg_lens${sfx}_${id}`
  const disp = `rg_disp${sfx}_${id}`
  const bowV = `rg_bow${sfx}_${id}`

  lines.push(`float ${wm} = ${wmCentre} + (${offPx}) * ${gradRate} * ${ribUVScreen};`)
  lines.push(`vec3 ${lens} = reedLens(${wm}, ${ribUVScreen}, ${o.ior}, ${o.curvature});`)
  lines.push(`float ${disp} = ${lens}.x - ${wm};`)
  // Thickness bow, in rib half-widths → device px → perp-axis screen UV
  lines.push(`float ${bowV} = ${lens}.y * (${o.ribWidth} * u_dpr * 0.5) * ${o.bow} / ${resPerp};`)
  const tail = emitDeltaTail({ id, sfx, isVert, disp, bowPerp: bowV, basis, grad: o.grad })
  lines.push(...tail.lines)
  return { lines, delta: tail.delta, lens }
}

/** Frost gather tap count. 16 is where a stratified disc stops improving on the
 *  content high curvature is actually used on: measured against a 256-tap disc,
 *  8 taps read 5.37 codes, 12 read 3.89, 16 read 2.93, 24 read 2.01. Today's 8
 *  white-noise taps read 10.34. */
const FROST_TAPS = 16

/** Golden angle, the Vogel/sunflower spiral increment. */
const GOLDEN_ANGLE = '2.39996323'

/**
 * Frosted glass: a stratified disc gather.
 *
 * Replaces 8 white-noise taps in a square footprint seeded from a coarse lattice.
 * Three separate defects made that read as pixelation rather than frost, and they
 * were multiplicative, not additive:
 *
 *  - The seed lattice quantised to 4 CSS px, so a whole cell shared one tap set —
 *    8x8 device px at DPR 2. Measured: it was 100% of the block structure
 *    (blockExcess 15.13 -> 0.10 when removed) and removed ZERO error (10.34 ->
 *    9.96 codes vs a 256-tap disc). It only moved the estimator's variance off
 *    individual pixels and onto a grid, which is why deleting it alone DOUBLES the
 *    speckle. It is now exposed as `grain`, since it is purely an aesthetic knob.
 *  - 8 iid taps is a hopeless estimator: sigma = sigma_tap/sqrt(N) is 45 codes at
 *    a hard edge, the output is literally 8 rigidly shifted copies at 31.9 codes
 *    each (ghosting), and alpha takes only 9 discrete values. Stratification, not
 *    raw N, is what buys the win: reaching 2 codes with iid taps needs N ~ 8100.
 *  - `reedHash` is one LCG round over raw float bits, so on an integer pixel grid
 *    it inherits the LCG lattice: peak |ACF| 0.647 used as a rotation and 0.843 as
 *    radial jitter, against an iid floor of 0.009. Remove the block grid and a
 *    diagonal moire takes its place. pcg2d reads 0.008, i.e. at the noise floor.
 *
 * Taps are unjittered Vogel: measured identical to the radially-jittered variant
 * (2.93 vs 2.95 codes) while leaving the hash's second component free for the
 * coverage stratification below, which is what closes the seam-AA gap.
 *
 * Each tap's BASE is also stratified across the pixel footprint along the seam
 * normal. That is what makes the gather subsume the seam discontinuity and the
 * minification supersample instead of disabling them: this branch runs whenever
 * frost > 0.001, and at frost 0.002 the jitter radius is 0.048 device px — far too
 * small to antialias anything — so without this the seam error snapped straight
 * back to its pre-fix value. The offset is at most +/-0.707 px, so the frost look
 * itself is unchanged.
 */
function emitFrostGather(o: {
  id: string
  lang: 'glsl' | 'wgsl'
  isVert: boolean
  sampler: string
  out: string
  coords: string
  frost: string
  grain: string
  wmCentre: string
  ribUVScreen: string
  rate: string
  halfWidth: string
  normal: string
  ribWidth: string
  ior: string
  curvature: string
  bow: string
  aspScr: string
  radScr: string
  scale: string
  grad: RibGradient
}): string {
  const { id, lang, isVert, sampler, out } = o
  const { gm, gp, den } = o.grad
  const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
  const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
  const w = lang === 'wgsl'
  const f = (n: string) => (w ? `f32(${n})` : `float(${n})`)
  const dcl = (t: string) => (w ? 'let ' : `${t} `)
  const v2 = w ? 'vec2f' : 'vec2'
  const v3 = w ? 'vec3f' : 'vec3'
  const v4 = w ? 'vec4f' : 'vec4'
  const fetch = (uv: string) => (w
    ? `textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${uv}, 0.0)`
    : `texture(${sampler}, ${uv})`)
  const base = w ? 'in.position.xy' : 'gl_FragCoord.xy'
  const vp = w ? 'uniforms.u_viewport' : 'u_viewport'
  const refSz = w ? 'uniforms.u_ref_size' : 'u_ref_size'
  const dprU = w ? 'uniforms.u_dpr' : 'u_dpr'
  const nrm = w ? `${v2}(rg_n_${id}.x, -rg_n_${id}.y)` : `rg_n_${id}`
  const dlt = (d: string) => (w ? `${v2}(${d}.x, -${d}.y)` : d)
  const i = `rg_fi_${id}`
  const A = `rg_acc_${id}`, AA = `rg_aacc_${id}`
  const N = FROST_TAPS

  return [
    // Radius as a LENGTH in device px, not per-axis UV — in UV it picks up the
    // canvas aspect and reshapes the footprint on resize. Divided by the viewport
    // per tap, so the footprint is a true circle in device px.
    `${dcl('float')}rg_fradpx_${id} = ${o.frost} * 24.0 * ${dprU};`,
    // Cell size in CSS px. grain 0 -> one device pixel, i.e. per-pixel grain;
    // grain 4 reproduces the old lattice pitch exactly.
    `${dcl('float')}rg_cell_${id} = max(${o.grain}, 1.0 / ${dprU});`,
    // Seeded off the frozen-ref coordinate, NOT the sample position: the hash is
    // over raw float bits, so seeding from anything the lens touches
    // re-randomises the whole grain field on every resize, DPR flip and param drag.
    `${dcl('vec2')}rg_gc_${id} = floor(${o.coords} * (${refSz} / rg_cell_${id}));`,
    `${dcl('vec2')}rg_h_${id} = reedPcg(rg_gc_${id});`,
    `${dcl('float')}rg_rot_${id} = rg_h_${id}.x * 6.28318530718;`,
    `${w ? `var ${A}: ${v3} = ${v3}(0.0);` : `${v3} ${A} = ${v3}(0.0);`}`,
    `${w ? `var ${AA}: f32 = 0.0;` : `float ${AA} = 0.0;`}`,
    `for (${w ? `var ${i}: i32 = 0` : `int ${i} = 0`}; ${i} < ${N}; ${i}++) {`,
    // Stratified position across the pixel footprint along the seam normal.
    `  ${dcl('float')}rg_ft_${id} = (((${f(i)} + rg_h_${id}.y) / ${N}.0) - 0.5) * 2.0 * ${o.halfWidth};`,
    `  ${dcl('float')}rg_fwm_${id} = ${o.wmCentre} + rg_ft_${id} * ${o.rate} * ${o.ribUVScreen};`,
    `  ${dcl('vec3')}rg_fl_${id} = reedLens(rg_fwm_${id}, ${o.ribUVScreen}, ${o.ior}, ${o.curvature});`,
    `  ${dcl('float')}rg_fdsp_${id} = rg_fl_${id}.x - rg_fwm_${id};`,
    `  ${dcl('float')}rg_fbw_${id} = rg_fl_${id}.y * (${o.ribWidth} * ${dprU} * 0.5) * ${o.bow} / ${resPerp};`,
    `  ${w ? 'var' : 'vec2'} rg_fd_${id}${w ? ': vec2f' : ''} = ${isVert
      ? `${v2}((rg_fdsp_${id} * (1.0 + ${gm}) / ${den}), (rg_fdsp_${id} * ${gp} * (${resMain} / ${resPerp}) / ${den} + rg_fbw_${id}))`
      : `${v2}((rg_fdsp_${id} * ${gp} * (${resMain} / ${resPerp}) / ${den} + rg_fbw_${id}), (rg_fdsp_${id} * (1.0 + ${gm}) / ${den}))`};`,
    `  rg_fd_${id}.x *= ${o.aspScr};`,
    `  rg_fd_${id} = ${v2}(rg_fd_${id}.x * cos(${o.radScr}) + rg_fd_${id}.y * sin(${o.radScr}), -rg_fd_${id}.x * sin(${o.radScr}) + rg_fd_${id}.y * cos(${o.radScr}));`,
    `  rg_fd_${id}.x /= ${o.aspScr};`,
    `  rg_fd_${id} *= ${v2}(${o.scale});`,
    // Vogel spiral: equal-area radii, golden-angle spacing, rotated per cell.
    `  ${dcl('float')}rg_fa_${id} = rg_rot_${id} + ${f(i)} * ${GOLDEN_ANGLE};`,
    `  ${dcl('float')}rg_fr_${id} = rg_fradpx_${id} * sqrt((${f(i)} + 0.5) / ${N}.0);`,
    `  ${w ? 'var' : 'vec2'} rg_tap_${id}${w ? ': vec2f' : ''} = (${base} + ${nrm} * rg_ft_${id}) / ${vp} + ${dlt(`rg_fd_${id}`)} + ${v2}(cos(rg_fa_${id}), sin(rg_fa_${id})) * rg_fr_${id} / ${vp};`,
    // Mirror into range rather than clamping, so the border does not smear.
    `  rg_tap_${id} = ${v2}(1.0) - abs(fract(rg_tap_${id} * 0.5) * 2.0 - ${v2}(1.0));`,
    `  ${dcl('vec4')}rg_s_${id} = ${fetch(`rg_tap_${id}`)};`,
    // Premultiplied AND in linear light. Premultiplied because averaging
    // straight-alpha texels drags opaque colour into transparent taps; linear
    // because the texels are sRGB-encoded and averaging encoded values loses ~12%
    // of the energy and darkens edges. This is the widest gather in the node, so
    // it is where the gamma error is largest.
    `  ${A} = ${A} + sombra_toLin(rg_s_${id}.rgb) * rg_s_${id}.a;`,
    `  ${AA} = ${AA} + rg_s_${id}.a;`,
    `}`,
    // Re-encode, plus one LSB of dither: a 16-tap average is smooth and
    // low-frequency, which is exactly what bands when quantised back to 8 bits.
    `${out} = ${v4}(sombra_toSrgb(${A} / ${w ? `${v3}(max(${AA}, 1e-5))` : `max(${AA}, 1e-5)`}) + ${v3}((sombra_dither(${base}) - 0.5) / 255.0), ${AA} / ${N}.0);`,
  ].join('\n  ')
}

/** Fixed loop bound for the minification supersample. GLSL ES needs a
 *  compile-time constant, so the count is capped here and the loop breaks early
 *  at the per-fragment count (the pattern blur.ts uses). 8 is where a
 *  low-contrast source stops improving: at |L'| 2-4 a 255-code step wants ~64
 *  taps but a 30-code one wants 8, and heavily-filtered content is where high
 *  curvature is actually used. */
const MINIF_MAX_TAPS = 8

/**
 * Minification supersampling: N colour samples across the pixel footprint along
 * the rib normal, averaged premultiplied.
 *
 * Where |L'| > 1 the lens minifies — one screen pixel covers |L'| source pixels —
 * and a single bilinear tap simply cannot represent that. It reads as a ragged,
 * sparkling rib edge, and it is NOT what the seam-coverage split fixes: coverage
 * models one clean step per pixel, whereas past the cliff there are extra creases
 * inside every rib.
 *
 * Sub-samples are spaced uniformly in SCREEN space and their COLOURS averaged,
 * which is exactly the pixel box filter. That matters because it sidesteps the
 * hard part: the pre-image of one pixel is up to two disjoint intervals with
 * folds and multiplicity 4 (measured at ior 1.65 / curvature 2.15), so
 * integrating in source space would need the map inverted and its branches
 * tracked. Each sub-sample instead traverses the whole map independently and the
 * branch structure takes care of itself. Averaging the sampled POSITION would be
 * wrong for the same reason it is wrong at a seam — that only equals averaging
 * colour if the image is locally affine, and across a 52-107 px jump it is not.
 *
 * N comes from the analytic derivative, so this costs nothing where it is not
 * needed: at the node defaults 0% of the rib minifies and N is exactly 1.
 */
function emitMinifSupersample(o: {
  id: string
  lang: 'glsl' | 'wgsl'
  isVert: boolean
  sampler: string
  out: string
  taps: string
  wmCentre: string
  ribUVScreen: string
  rate: string
  halfWidth: string
  normal: string
  ribWidth: string
  ior: string
  curvature: string
  bow: string
  aspScr: string
  radScr: string
  scale: string
  grad: RibGradient
}): string {
  const { id, lang, isVert, sampler, out, taps } = o
  const { gm, gp, den } = o.grad
  const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
  const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
  const w = lang === 'wgsl'
  const f = (n: string) => (w ? `f32(${n})` : `float(${n})`)
  // `let` is illegal for a reassigned var; everything here is single-assignment
  // except the accumulators, which are `var`.
  const dcl = (t: string) => (w ? 'let ' : `${t} `)
  const v2 = w ? 'vec2f' : 'vec2'
  const v3 = w ? 'vec3f' : 'vec3'
  const v4 = w ? 'vec4f' : 'vec4'
  const fetch = (uv: string) => (w
    ? `textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${uv}, 0.0)`
    : `texture(${sampler}, ${uv})`)
  const base = w ? 'in.position.xy' : 'gl_FragCoord.xy'
  const vp = w ? 'uniforms.u_viewport' : 'u_viewport'
  // y-DOWN base vs y-UP normal and delta: each needs its own negation on WGSL.
  const nrm = w ? `${v2}(${o.normal}.x, -${o.normal}.y)` : o.normal
  const dlt = (d: string) => (w ? `${v2}(${d}.x, -${d}.y)` : d)
  const A = `rg_ms_acc_${id}`, AA = `rg_ms_a_${id}`
  const L = `rg_ms_l_${id}`, T = `rg_ms_t_${id}`, WM = `rg_ms_wm_${id}`
  const D = `rg_ms_d_${id}`, S = `rg_ms_s_${id}`, UV = `rg_ms_uv_${id}`
  const DSP = `rg_ms_dsp_${id}`, BW = `rg_ms_bw_${id}`
  const dMain = `(${DSP} * (1.0 + ${gm}) / ${den})`
  const dPerp = `(${DSP} * ${gp} * (${resMain} / ${resPerp}) / ${den} + ${BW})`

  return [
    `${w ? `var ${A}: ${v3} = ${v3}(0.0);` : `${v3} ${A} = ${v3}(0.0);`}`,
    `${w ? `var ${AA}: f32 = 0.0;` : `float ${AA} = 0.0;`}`,
    `for (${w ? 'var rg_ms_i_' + id + ': i32 = 0' : 'int rg_ms_i_' + id + ' = 0'}; rg_ms_i_${id} < ${MINIF_MAX_TAPS}; rg_ms_i_${id}++) {`,
    `  if (${f(`rg_ms_i_${id}`)} >= ${taps}) { break; }`,
    `  ${dcl('float')}${T} = ((2.0 * (${f(`rg_ms_i_${id}`)} + 0.5) / ${taps}) - 1.0) * ${o.halfWidth};`,
    `  ${dcl('float')}${WM} = ${o.wmCentre} + ${T} * ${o.rate} * ${o.ribUVScreen};`,
    `  ${dcl('vec3')}${L} = reedLens(${WM}, ${o.ribUVScreen}, ${o.ior}, ${o.curvature});`,
    `  ${dcl('float')}${DSP} = ${L}.x - ${WM};`,
    `  ${dcl('float')}${BW} = ${L}.y * (${o.ribWidth} * u_dpr * 0.5) * ${o.bow} / ${resPerp};`,
    `  ${w ? 'var' : 'vec2'} ${D}${w ? ': vec2f' : ''} = ${isVert ? `${v2}(${dMain}, ${dPerp})` : `${v2}(${dPerp}, ${dMain})`};`,
    `  ${D}.x *= ${o.aspScr};`,
    `  ${D} = ${v2}(${D}.x * cos(${o.radScr}) + ${D}.y * sin(${o.radScr}), -${D}.x * sin(${o.radScr}) + ${D}.y * cos(${o.radScr}));`,
    `  ${D}.x /= ${o.aspScr};`,
    `  ${D} *= ${v2}(${o.scale});`,
    `  ${dcl('vec2')}${UV} = (${base} + ${nrm} * ${T}) / ${vp} + ${dlt(D)};`,
    `  ${dcl('vec4')}${S} = ${fetch(UV)};`,
    // Linear light, same reason as the frost gather. It matters MORE here, not
    // less: at |L'| = 176 the sub-samples span 176 source px, so they can be
    // wildly different colours, and the gamma error scales with that contrast.
    `  ${A} = ${A} + sombra_toLin(${S}.rgb) * ${S}.a;`,
    `  ${AA} = ${AA} + ${S}.a;`,
    `}`,
    `${out} = ${v4}(sombra_toSrgb(${A} / ${w ? `${v3}(max(${AA}, 1e-5))` : `max(${AA}, 1e-5)`}) + ${v3}((sombra_dither(${base}) - 0.5) / 255.0), ${AA} / ${taps});`,
  ].join('\n  ')
}

/**
 * Seam-coverage antialiasing geometry.
 *
 * `sampleUV` is C0-discontinuous at every rib seam: across one pixel boundary the
 * sampled position jumps by 2/3 of a rib period (≈107 device px at ribWidth 80,
 * DPR 2), and the shader draws that step at one sample per pixel with no coverage
 * term. Where the seam is axis-aligned that reads as a hard-but-straight cut;
 * where it is oblique or curved it staircases.
 *
 * So: find the signed distance from the pixel centre to the nearest seam along
 * the seam normal, in device px. If a seam falls inside the pixel, the caller
 * splits it and samples each side at the centroid of its own sub-interval,
 * weighted by coverage; otherwise it takes the single centre tap.
 *
 * NO HARDWARE DERIVATIVES. The rate comes from the analytic gradient above and a
 * closed form for the rib period, which sidesteps three separate problems:
 * `fwidth` is illegal under the possibly-non-uniform `frost` branch and Tint
 * rejects it silently; `mechanicalGlslToWgsl` has no dFdx→dpdx rule, so the name
 * would pass through unmapped and fail at Tint; and `fwidth` of the FOLDED
 * coordinate returns the jump (~52 px/px) rather than the slope, and only on the
 * ~half of sub-pixel phases where a 2×2 quad straddles the discontinuity — so a
 * derivative-driven detector would blink on and off as the canvas is resized.
 */
function emitSeamGeometry(o: {
  id: string
  isVert: boolean
  wmCentre: string
  ribUVScreen: string
  ribWidth: string
  scale: string
  radScr: string
  grad: RibGradient
}): { lines: string[]; rate: string; centroidA: string; centroidB: string; weightA: string; normal: string; split: string; halfWidth: string } {
  const { id, isVert, wmCentre, ribUVScreen, ribWidth, scale, radScr, grad } = o
  const { gm, gp, den } = grad
  const lines: string[] = []
  const phi = `rg_phi_${id}`
  const prd = `rg_prd_${id}`
  const rate = `rg_gl_${id}`
  const ss = `rg_ss_${id}`
  const n = `rg_n_${id}`
  const hw = `rg_hw_${id}`

  // Seams sit at integer rib phase. |∇φ| per SCREEN device px is exact:
  // sqrt(den) / (ribWidth · u_dpr · srt_scale).
  lines.push(`float ${phi} = ${wmCentre} / ${ribUVScreen};`)
  lines.push(`float ${prd} = ${ribWidth} * u_dpr * ${scale};`)
  lines.push(`float ${rate} = sqrt(${den}) / max(abs(${prd}), 1e-6);`)
  lines.push(`float ${ss} = (floor(${phi} + 0.5) - ${phi}) / max(${rate}, 1e-9);`)
  // Seam normal in screen axes. Device px are isotropic, so this is a plain
  // R(-rad) — no aspect conjugation (that exists in emitDeltaTail only because
  // the delta there is expressed in per-axis UV, not px).
  lines.push(`vec2 ${n} = ${isVert ? `vec2(1.0 + ${gm}, ${gp})` : `vec2(${gp}, 1.0 + ${gm})`};`)
  lines.push(`${n} = vec2(${n}.x * cos(${radScr}) + ${n}.y * sin(${radScr}), -${n}.x * sin(${radScr}) + ${n}.y * cos(${radScr})) / max(sqrt(${den}), 1e-9);`)
  // Half the unit pixel's support projected on the normal: 0.5 axis-aligned,
  // 0.707 at 45°.
  lines.push(`float ${hw} = (abs(${n}.x) + abs(${n}.y)) * 0.5;`)
  // Coverage of the near side, and the centroid of each sub-interval, in px.
  lines.push(`float rg_wa_${id} = (${ss} + ${hw}) / max(2.0 * ${hw}, 1e-6);`)
  lines.push(`float rg_ca_${id} = (${ss} - ${hw}) * 0.5;`)
  lines.push(`float rg_cb_${id} = (${ss} + ${hw}) * 0.5;`)
  lines.push(`bool rg_split_${id} = abs(${ss}) < ${hw};`)
  return {
    lines, rate,
    centroidA: `rg_ca_${id}`, centroidB: `rg_cb_${id}`,
    weightA: `rg_wa_${id}`, normal: n, split: `rg_split_${id}`, halfWidth: hw,
  }
}

export const reededGlassNode: NodeDefinition = {
  type: 'reeded_glass',
  label: 'Reeded Glass',
  category: 'Effect',
  description: 'Cylindrical lens distortion through ribbed glass',

  inputs: [
    { id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0] },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
    { id: 'coords', label: 'Coords', type: 'vec2' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    {
      id: 'ribWidth', label: 'Rib Width', type: 'float', default: 80,
      min: 2, max: 400, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'ior', label: 'IOR', type: 'float', default: 1.5,
      min: 1.0, max: 3.0, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'curvature', label: 'Curvature', type: 'float', default: 0.8,
      min: 0, max: 2, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      // Off-axis view through the rib's own thickness — the only term that can
      // move a line running parallel to the ribs. Signed: bow either way.
      id: 'bow', label: 'Bow', type: 'float', default: 1,
      min: -1, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'frost', label: 'Frost', type: 'float', default: 0,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      // Frost grain cell size in CSS px. 0 = per-device-pixel (smooth frost).
      // 4 reproduces the pitch of the original lattice-seeded look exactly; the
      // lattice was purely a quantisation of the seed, so this is an aesthetic
      // control and does not change how accurate the gather is.
      id: 'grain', label: 'Grain', type: 'float', default: 0,
      min: 0, max: 16, step: 0.5,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'direction', label: 'Direction', type: 'enum', default: 'vertical',
      options: DIRECTION_OPTIONS,
      updateMode: 'recompile',
    },
    {
      id: 'ribType', label: 'Rib Type', type: 'enum', default: 'straight',
      options: RIB_TYPE_OPTIONS,
      updateMode: 'recompile',
    },
    {
      id: 'waveShape', label: 'Wave Shape', type: 'enum', default: 'sine',
      options: WAVE_SHAPE_OPTIONS,
      showWhen: { ribType: 'wave' },
      updateMode: 'recompile',
    },
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'simplex',
      options: NOISE_TYPE_OPTIONS,
      showWhen: { ribType: 'noise' },
      updateMode: 'recompile',
    },
    {
      id: 'amplitude', label: 'Amplitude', type: 'float', default: 20,
      min: 0, max: 200, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { ribType: ['wave', 'circular', 'noise'] },
    },
    {
      id: 'wavelength', label: 'Wavelength', type: 'float', default: 200,
      min: 10, max: 1000, step: 1,
      connectable: true, updateMode: 'uniform',
      showWhen: { ribType: ['wave', 'circular', 'noise'] },
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const direction = (params.direction as string) || 'vertical'
    const ribType = (params.ribType as string) || 'straight'
    const id = ctx.nodeId.replace(/-/g, '_')

    registerLensFn(ctx)
    ctx.functionRegistry.set('sombra_color_helpers', COLOR_GLSL_HELPERS)

    // Integer-based hash for frost jitter — no sin artifacts/scanlines
    addFunction(ctx, 'reedHash', `vec2 reedHash(vec2 p) {
  uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;
}`)

    // Two-round pcg2d for the frost rotation. reedHash cannot be used here: it is
    // ONE LCG round over raw float bits, so on an integer pixel grid the bitcast
    // input is itself a linear ramp and the output inherits the LCG lattice —
    // measured peak |ACF| 0.647 as a rotation source against an iid floor of
    // 0.009, which weaves a diagonal moire the moment the block lattice is gone.
    // pcg2d reads 0.008, i.e. at the noise floor.
    addFunction(ctx, 'reedPcg', `vec2 reedPcg(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p))) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return vec2(v) / 4294967296.0;
}`)

    const isVert = direction === 'vertical'
    const lines: string[] = []

    // Generate auto_uv with SRT applied (frozen-ref space)
    ctx.uniforms.add('u_resolution')
    ctx.uniforms.add('u_dpr')
    ctx.uniforms.add('u_ref_size')
    ctx.uniforms.add('u_anchor')
    // Canonical auto_uv, kept BEFORE the SRT. This is what `coords` is measured
    // from: the SRT positions the rib pattern, it must not rotate the coordinate
    // frame we hand downstream. (The old path SRT'd this value in place, so
    // rotating the glass 47° returned coords in a 47°-rotated frame.)
    const autoUv = `rg_auv_${id}`
    const coordsVar = `rg_coords_${id}`
    lines.push(`vec2 ${autoUv} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`)
    lines.push(`vec2 ${coordsVar} = ${autoUv};`)
    // SRT the PATTERN basis: center → scale → rotate → translate → re-center.
    // No aspect conjugation here: ref space is already isotropic (one unit is
    // u_dpr * u_ref_size device px on BOTH axes), so conjugating — as this path
    // used to — makes the rotation non-rigid and skews the rib angle on a
    // non-square canvas. The screen path needs it because v_uv is per-axis.
    const radRef = `rg_rad_ref_${id}`
    lines.push(`${coordsVar} -= u_anchor;`)
    lines.push(`${coordsVar} /= vec2(${inputs.srt_scale});`)
    lines.push(`float ${radRef} = ${inputs.srt_rotate} * 0.01745329;`)
    lines.push(`${coordsVar} = vec2(${coordsVar}.x * cos(${radRef}) - ${coordsVar}.y * sin(${radRef}), ${coordsVar}.x * sin(${radRef}) + ${coordsVar}.y * cos(${radRef}));`)
    lines.push(`${coordsVar} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) / (u_dpr * u_ref_size);`)
    lines.push(`${coordsVar} += u_anchor;`)

    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    const ribUVRef = `rg_ribUV_ref_${id}`
    lines.push(`float ${ampRef} = ${inputs.amplitude} / u_ref_size;`)
    lines.push(`float ${wlRef} = ${inputs.wavelength} / u_ref_size;`)
    lines.push(`float ${ribUVRef} = ${inputs.ribWidth} / u_ref_size;`)
    if (ribType === 'noise') registerNoiseType(ctx, (params.noiseType as string) || 'simplex')

    // The rib pattern must be evaluated in the SAME orientation as the colour
    // path, or the two outputs describe mirror-image glass. `rg_coords` is
    // canonical auto_uv — y-DOWN, which is right for the OUTPUT — while srtScr
    // comes from v_uv and is y-UP. Mirroring after the rotate would give R(-theta),
    // so the pattern point is built y-up from the start and SRT'd in that
    // orientation, exactly as srtScr is. No aspect conjugation: ref space is
    // isotropic.
    const patRef = `rg_pat_ref_${id}`
    lines.push(`vec2 ${patRef} = vec2(${autoUv}.x - u_anchor.x, -(${autoUv}.y - u_anchor.y));`)
    lines.push(`${patRef} /= vec2(${inputs.srt_scale});`)
    lines.push(`${patRef} = vec2(${patRef}.x * cos(${radRef}) - ${patRef}.y * sin(${radRef}), ${patRef}.x * sin(${radRef}) + ${patRef}.y * cos(${radRef}));`)
    lines.push(`${patRef} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) / (u_dpr * u_ref_size);`)

    const refBasis: Basis = {
      point: patRef,
      resMain: '(u_dpr * u_ref_size)', resPerp: '(u_dpr * u_ref_size)',
      ribUV: ribUVRef,
      toPx: (pt) => `(${pt}) * (u_dpr * u_ref_size)`,
      asp: '1.0', rad: radRef, scale: `${inputs.srt_scale}`,
      amp: ampRef, wl: wlRef, wlPx: `(${inputs.wavelength} * u_dpr)`,
    }

    // Same emitters the colour path uses — that is the whole point. The two
    // outputs cannot describe different optics because there is only one
    // implementation of the optics.
    const waveRef = screenWave({
      ribType, waveShape: (params.waveShape as string) || 'sine',
      noiseType: (params.noiseType as string) || 'simplex',
      isVert, basis: refBasis,
    })
    const warpedMainRef = `rg_wm_ref_${id}`
    const mainRef = isVert ? `${patRef}.x` : `${patRef}.y`
    if (!waveRef) {
      lines.push(`float ${warpedMainRef} = ${mainRef};`)
    } else {
      lines.push(`float rg_wv_ref_${id} = ${waveRef.expr(patRef)};`)
      lines.push(`float ${warpedMainRef} = ${mainRef} + rg_wv_ref_${id};`)
    }
    const gradRef = emitRibGradient({ id, sfx: '_r', isVert, basis: refBasis, wave: waveRef })
    lines.push(...gradRef.lines)
    const tailRef = emitLensTail({
      id, sfx: '_r', isVert, offPx: '0.0', gradRate: '0.0',
      wmCentre: warpedMainRef, ior: `${inputs.ior}`, curvature: `${inputs.curvature}`,
      ribWidth: `${inputs.ribWidth}`, bow: `${inputs.bow}`, basis: refBasis, grad: gradRef,
    })
    lines.push(...tailRef.lines)

    // Coords output — always populated, and always the same distortion `color`
    // applies, expressed in canonical auto_uv units.
    lines.push(`vec2 ${outputs.coords} = ${autoUv} + vec2(${tailRef.delta}.x, -${tailRef.delta}.y);`)

    // Color output — texture mode (source wired) vs fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply SRT to screen UV coords for rib pattern
      const srtScr = `rg_srt_scr_${id}`
      lines.push(`vec2 ${srtScr} = v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y);`)
      lines.push(`${srtScr} /= vec2(${inputs.srt_scale});`)
      // Rotate with aspect correction
      const aspScr = `rg_asp_scr_${id}`
      const radScr = `rg_rad_scr_${id}`
      lines.push(`float ${aspScr} = u_resolution.x / u_resolution.y;`)
      lines.push(`float ${radScr} = ${inputs.srt_rotate} * 0.01745329;`)
      lines.push(`${srtScr}.x *= ${aspScr};`)
      lines.push(`${srtScr} = vec2(${srtScr}.x * cos(${radScr}) - ${srtScr}.y * sin(${radScr}), ${srtScr}.x * sin(${radScr}) + ${srtScr}.y * cos(${radScr}));`)
      lines.push(`${srtScr}.x /= ${aspScr};`)
      // Translate in screen UV (pixels → screen UV)
      lines.push(`${srtScr} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) * u_dpr / u_resolution;`)

      const mainScr = isVert ? `${srtScr}.x` : `${srtScr}.y`
      const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
      const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
      const warpedMainScr = `rg_wm_scr_${id}`

      // Convert amplitude (main axis) and wavelength (perp axis) from pixels to screen UV
      const ampScr = `rg_amp_scr_${id}`
      const wlScr = `rg_wl_scr_${id}`
      lines.push(`float ${ampScr} = ${inputs.amplitude} * u_dpr / ${resMain};`)
      lines.push(`float ${wlScr} = ${inputs.wavelength} * u_dpr / ${resPerp};`)
      // Pixel-space wavelength for isotropic noise/circular sampling
      const wlPx = `(${inputs.wavelength} * u_dpr)`
      // Rib width in screen UV — per-axis, hence the resMain divisor
      const ribUVScreen = `rg_ribUV_scr_${id}`
      lines.push(`float ${ribUVScreen} = ${inputs.ribWidth} * u_dpr / ${resMain};`)

      const scrBasis: Basis = {
        point: srtScr, resMain, resPerp, ribUV: ribUVScreen,
        toPx: (pt) => `(${pt}) * u_resolution`,
        asp: aspScr, rad: radScr, scale: `${inputs.srt_scale}`,
        amp: ampScr, wl: wlScr, wlPx,
      }
      const wave = screenWave({
        ribType, waveShape: (params.waveShape as string) || 'sine',
        noiseType: (params.noiseType as string) || 'simplex',
        isVert, basis: scrBasis,
      })
      if (!wave) {
        lines.push(`float ${warpedMainScr} = ${mainScr};`)
      } else {
        lines.push(`float rg_wv_scr_${id} = ${wave.expr(srtScr)};`)
        lines.push(`float ${warpedMainScr} = ${mainScr} + rg_wv_scr_${id};`)
      }

      // Rib gradient and seam geometry: emitted once, shared by all three
      // sub-samples below.
      const grad = emitRibGradient({ id, isVert, basis: scrBasis, wave })
      lines.push(...grad.lines)
      const seam = emitSeamGeometry({
        id, isVert, wmCentre: warpedMainScr, ribUVScreen,
        ribWidth: `${inputs.ribWidth}`, scale: `${inputs.srt_scale}`, radScr, grad,
      })
      lines.push(...seam.lines)

      // Lens + delta at the pixel centre, and at the centroid of each side of a
      // seam that cuts through this pixel.
      const tailArgs = {
        id, isVert, wmCentre: warpedMainScr, gradRate: seam.rate,
        ior: `${inputs.ior}`, curvature: `${inputs.curvature}`,
        ribWidth: `${inputs.ribWidth}`, bow: `${inputs.bow}`,
        basis: scrBasis, grad,
      }
      const mid = emitLensTail({ ...tailArgs, sfx: '', offPx: '0.0' })
      const subA = emitLensTail({ ...tailArgs, sfx: '_a', offPx: seam.centroidA })
      const subB = emitLensTail({ ...tailArgs, sfx: '_b', offPx: seam.centroidB })
      lines.push(...mid.lines, ...subA.lines, ...subB.lines)
      // Supersample count from the analytic cross-rib derivative: 1 wherever the
      // lens magnifies (which is everywhere at the defaults), rising with the
      // minification factor and capped.
      const taps = `rg_nt_${id}`
      lines.push(`float ${taps} = clamp(ceil(abs(${mid.lens}.z)), 1.0, ${MINIF_MAX_TAPS}.0);`)

      // Use gl_FragCoord/viewport instead of v_uv for FBO sampling —
      // on WGSL, in.position.y=0 at top matches WebGPU texture convention,
      // while v_uv.y=0 at bottom does not.
      ctx.uniforms.add('u_viewport')
      const sampleUV = `rg_sampleUV_${id}`
      lines.push(`vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + ${mid.delta};`)
      lines.push(`vec2 ${sampleUV}_a = (gl_FragCoord.xy + ${seam.normal} * (${seam.centroidA})) / u_viewport + ${subA.delta};`)
      lines.push(`vec2 ${sampleUV}_b = (gl_FragCoord.xy + ${seam.normal} * (${seam.centroidB})) / u_viewport + ${subB.delta};`)

      const frostVar = `rg_frost_${id}`
      lines.push(`float ${frostVar} = ${inputs.frost};`)
      lines.push(`vec4 ${outputs.color};`)
      lines.push(`if (${frostVar} > 0.001) {`)
      lines.push('  ' + emitFrostGather({
        id, lang: 'glsl', isVert, sampler: samplerName, out: `${outputs.color}`,
        coords: coordsVar, frost: frostVar, grain: `${inputs.grain}`,
        wmCentre: warpedMainScr, ribUVScreen, rate: seam.rate, halfWidth: seam.halfWidth,
        normal: seam.normal, ribWidth: `${inputs.ribWidth}`, ior: `${inputs.ior}`,
        curvature: `${inputs.curvature}`, bow: `${inputs.bow}`,
        aspScr, radScr, scale: `${inputs.srt_scale}`, grad,
      }))
      lines.push(`} else if (${taps} > 1.0) {`)
      lines.push('  ' + emitMinifSupersample({
        id, lang: 'glsl', isVert, sampler: samplerName, out: `${outputs.color}`, taps,
        wmCentre: warpedMainScr, ribUVScreen, rate: seam.rate, halfWidth: seam.halfWidth,
        normal: seam.normal, ribWidth: `${inputs.ribWidth}`, ior: `${inputs.ior}`,
        curvature: `${inputs.curvature}`, bow: `${inputs.bow}`,
        aspScr, radScr, scale: `${inputs.srt_scale}`, grad,
      }))
      // A rib seam cutting through this pixel: sample each side at its own
      // centroid and weight by coverage. Premultiplied, matching the frost
      // accumulator — straight-alpha averaging fringes a transparent edge and is
      // algebraically identical on opaque content.
      lines.push(`} else if (${seam.split}) {`)
      lines.push(`  vec4 rg_A_${id} = texture(${samplerName}, ${sampleUV}_a);`)
      lines.push(`  vec4 rg_B_${id} = texture(${samplerName}, ${sampleUV}_b);`)
      lines.push(`  float rg_pa_${id} = rg_A_${id}.a * ${seam.weightA};`)
      lines.push(`  float rg_pb_${id} = rg_B_${id}.a * (1.0 - ${seam.weightA});`)
      lines.push(`  float rg_ao_${id} = rg_pa_${id} + rg_pb_${id};`)
      // Linear light: the two sides of a seam are up to 107 device px apart in the
      // source, so this is the HIGHEST-contrast average in the node.
      lines.push(`  ${outputs.color} = vec4(sombra_toSrgb((sombra_toLin(rg_A_${id}.rgb) * rg_pa_${id} + sombra_toLin(rg_B_${id}.rgb) * rg_pb_${id}) / max(rg_ao_${id}, 1e-5)), rg_ao_${id});`)
      lines.push(`} else {`)
      lines.push(`  ${outputs.color} = texture(${samplerName}, ${sampleUV});`)
      lines.push(`}`)
    } else {
      lines.push(`vec4 ${outputs.color} = ${inputs.source};`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {

    const direction = (ctx.params.direction as string) || 'vertical'
    const ribType = (ctx.params.ribType as string) || 'straight'
    const isVert = direction === 'vertical'
    const id = ctx.nodeId.replace(/-/g, '_')

    // --- Shared GLSL functions as IRFunction objects ---
    const functions: IRFunction[] = []

    // Cylindrical lens function
    const lensFn: IRFunction = {
      key: 'reedLens',
      name: 'reedLens',
      params: [
        { name: 'coord', type: 'float' },
        { name: 'ribW', type: 'float' },
        { name: 'ior', type: 'float' },
        { name: 'curvature', type: 'float' },
      ],
      returnType: 'vec3',
      body: [raw(REED_LENS_BODY)],
    }
    functions.push(lensFn)

    // Integer-based hash for frost jitter
    const hashFn: IRFunction = {
      key: 'reedHash',
      name: 'reedHash',
      params: [{ name: 'p', type: 'vec2' }],
      returnType: 'vec2',
      body: [raw(
        // GLSL
        `uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;`,
        // WGSL: vec2<u32> >> requires vec2<u32> RHS (not scalar u32)
        `var q: vec2<u32> = vec2<u32>(bitcast<u32>(p.x), bitcast<u32>(p.y));
  q = q * vec2<u32>(1103515245u) + vec2<u32>(12345u);
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> vec2<u32>(16u));
  return vec2f(q) / f32(0xFFFFFFFFu) * 2.0 - 1.0;`,
      )],
    }
    functions.push(hashFn)

    // Two-round pcg2d for the frost rotation — see the glsl() comment. WGSL needs
    // a vec2<u32> shift RHS, hence the explicit second argument.
    const pcgFn: IRFunction = {
      key: 'reedPcg',
      name: 'reedPcg',
      params: [{ name: 'p', type: 'vec2' }],
      returnType: 'vec2',
      body: [raw(
        `uvec2 v = uvec2(ivec2(floor(p))) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return vec2(v) / 4294967296.0;`,
        `var v: vec2<u32> = vec2<u32>(vec2<i32>(floor(p))) * vec2<u32>(1664525u) + vec2<u32>(1013904223u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2<u32>(16u));
  return vec2f(v) / 4294967296.0;`,
      )],
    }
    functions.push(pcgFn)
    functions.push(...COLOR_IR_HELPERS)

    // --- Main computation ---
    const stmts: IRStmt[] = []

    // Canonical auto_uv, kept BEFORE the SRT — see the glsl() comment. Two-argument
    // raw() because the base differs per backend: gl_FragCoord is y-up here and the
    // assembler rewrites it to in.position, which is y-down.
    const autoUv = `rg_auv_${id}`
    const coordsVar = `rg_coords_${id}`
    stmts.push(raw(
      `vec2 ${autoUv} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`,
      `let ${autoUv} = (in.position.xy - uniforms.u_resolution * uniforms.u_anchor) / (uniforms.u_dpr * uniforms.u_ref_size) + uniforms.u_anchor;`,
    ))
    const radRef = `rg_rad_ref_${id}`
    // No aspect conjugation: ref space is isotropic, so conjugating would make the
    // rotate non-rigid and skew the rib angle on a non-square canvas.
    stmts.push(raw(
      `vec2 ${coordsVar} = ${autoUv};\n` +
      `  ${coordsVar} -= u_anchor;\n` +
      `  ${coordsVar} /= vec2(${ctx.inputs.srt_scale});\n` +
      `  float ${radRef} = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar} = vec2(${coordsVar}.x * cos(${radRef}) - ${coordsVar}.y * sin(${radRef}), ${coordsVar}.x * sin(${radRef}) + ${coordsVar}.y * cos(${radRef}));\n` +
      `  ${coordsVar} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (u_dpr * u_ref_size);\n` +
      `  ${coordsVar} += u_anchor;`,
      `var ${coordsVar}: vec2f = ${autoUv};\n` +
      `  ${coordsVar} -= uniforms.u_anchor;\n` +
      `  ${coordsVar} /= vec2f(${ctx.inputs.srt_scale});\n` +
      `  let ${radRef} = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar} = vec2f(${coordsVar}.x * cos(${radRef}) - ${coordsVar}.y * sin(${radRef}), ${coordsVar}.x * sin(${radRef}) + ${coordsVar}.y * cos(${radRef}));\n` +
      `  ${coordsVar} -= vec2f(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (uniforms.u_dpr * uniforms.u_ref_size);\n` +
      `  ${coordsVar} += uniforms.u_anchor;`,
    ))

    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    const ribUVRef = `rg_ribUV_ref_${id}`
    stmts.push(raw(`float ${ampRef} = ${ctx.inputs.amplitude} / u_ref_size;`))
    stmts.push(raw(`float ${wlRef} = ${ctx.inputs.wavelength} / u_ref_size;`))
    stmts.push(raw(`float ${ribUVRef} = ${ctx.inputs.ribWidth} / u_ref_size;`))
    if (ribType === 'noise') functions.push(...getIRNoiseFunctions((ctx.params.noiseType as string) || 'simplex'))

    // Same orientation as the colour path — see the glsl() comment.
    const patRef = `rg_pat_ref_${id}`
    stmts.push(raw(
      `vec2 ${patRef} = vec2(${autoUv}.x - u_anchor.x, -(${autoUv}.y - u_anchor.y));\n` +
      `  ${patRef} /= vec2(${ctx.inputs.srt_scale});\n` +
      `  ${patRef} = vec2(${patRef}.x * cos(${radRef}) - ${patRef}.y * sin(${radRef}), ${patRef}.x * sin(${radRef}) + ${patRef}.y * cos(${radRef}));\n` +
      `  ${patRef} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (u_dpr * u_ref_size);`,
      `var ${patRef}: vec2f = vec2f(${autoUv}.x - uniforms.u_anchor.x, -(${autoUv}.y - uniforms.u_anchor.y));\n` +
      `  ${patRef} /= vec2f(${ctx.inputs.srt_scale});\n` +
      `  ${patRef} = vec2f(${patRef}.x * cos(${radRef}) - ${patRef}.y * sin(${radRef}), ${patRef}.x * sin(${radRef}) + ${patRef}.y * cos(${radRef}));\n` +
      `  ${patRef} -= vec2f(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (uniforms.u_dpr * uniforms.u_ref_size);`,
    ))

    const refBasis: Basis = {
      point: patRef,
      resMain: '(u_dpr * u_ref_size)', resPerp: '(u_dpr * u_ref_size)',
      ribUV: ribUVRef,
      toPx: (pt) => `(${pt}) * (u_dpr * u_ref_size)`,
      asp: '1.0', rad: radRef, scale: `${ctx.inputs.srt_scale}`,
      amp: ampRef, wl: wlRef, wlPx: `(${ctx.inputs.wavelength} * u_dpr)`,
    }

    const waveRef = screenWave({
      ribType, waveShape: (ctx.params.waveShape as string) || 'sine',
      noiseType: (ctx.params.noiseType as string) || 'simplex',
      isVert, basis: refBasis,
    })
    const warpedMainRef = `rg_wm_ref_${id}`
    const mainRef = isVert ? `${patRef}.x` : `${patRef}.y`
    if (!waveRef) {
      stmts.push(raw(`float ${warpedMainRef} = ${mainRef};`))
    } else {
      stmts.push(raw(`float rg_wv_ref_${id} = ${waveRef.expr(patRef)};`))
      stmts.push(raw(`float ${warpedMainRef} = ${mainRef} + rg_wv_ref_${id};`))
    }
    const gradRef = emitRibGradient({ id, sfx: '_r', isVert, basis: refBasis, wave: waveRef })
    for (const l of gradRef.lines) stmts.push(raw(l))
    const tailRef = emitLensTail({
      id, sfx: '_r', isVert, offPx: '0.0', gradRate: '0.0',
      wmCentre: warpedMainRef, ior: `${ctx.inputs.ior}`, curvature: `${ctx.inputs.curvature}`,
      ribWidth: `${ctx.inputs.ribWidth}`, bow: `${ctx.inputs.bow}`, basis: refBasis, grad: gradRef,
    })
    for (const l of tailRef.lines) stmts.push(raw(l))

    // Coords output — always populated, same distortion `color` applies, in
    // canonical auto_uv units.
    stmts.push(raw(`vec2 ${ctx.outputs.coords} = ${autoUv} + vec2(${tailRef.delta}.x, -${tailRef.delta}.y);`))

    // Color output — texture mode vs non-texture fallback
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Apply SRT to screen UV coords for rib pattern
      const srtScr = `rg_srt_scr_${id}`
      stmts.push(raw(`vec2 ${srtScr} = v_uv - vec2(u_anchor.x, 1.0 - u_anchor.y);`))
      stmts.push(raw(`${srtScr} /= vec2(${ctx.inputs.srt_scale});`))
      stmts.push(raw(`float rg_asp_scr_${id} = u_resolution.x / u_resolution.y;`))
      stmts.push(raw(`float rg_rad_scr_${id} = ${ctx.inputs.srt_rotate} * 0.01745329;`))
      stmts.push(raw(`${srtScr}.x *= rg_asp_scr_${id};`))
      stmts.push(raw(`${srtScr} = vec2(${srtScr}.x * cos(rg_rad_scr_${id}) - ${srtScr}.y * sin(rg_rad_scr_${id}), ${srtScr}.x * sin(rg_rad_scr_${id}) + ${srtScr}.y * cos(rg_rad_scr_${id}));`))
      stmts.push(raw(`${srtScr}.x /= rg_asp_scr_${id};`))
      stmts.push(raw(`${srtScr} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) * u_dpr / u_resolution;`))

      const mainScr = isVert ? `${srtScr}.x` : `${srtScr}.y`
      const warpedMainScr = `rg_wm_scr_${id}`

      // Convert amplitude (main axis) and wavelength (perp axis) from pixels to screen UV
      const resMainIR = isVert ? 'u_resolution.x' : 'u_resolution.y'
      const resPerpIR = isVert ? 'u_resolution.y' : 'u_resolution.x'
      const ampScrIR = `rg_amp_scr_${id}`
      const wlScrIR = `rg_wl_scr_${id}`
      stmts.push(raw(`float ${ampScrIR} = ${ctx.inputs.amplitude} * u_dpr / ${resMainIR};`))
      stmts.push(raw(`float ${wlScrIR} = ${ctx.inputs.wavelength} * u_dpr / ${resPerpIR};`))
      const wlPxIR = `(${ctx.inputs.wavelength} * u_dpr)`
      // Rib width in screen UV — per-axis, hence the resMain divisor. Built as an
      // IR expression rather than a raw string so the WGSL backend parenthesises it
      // exactly as it did before, keeping the colour path byte-identical.
      const ribUVScreen = `rg_ribUV_scr_${id}`
      stmts.push(declare(ribUVScreen, 'float',
        binary('/', binary('*', variable(ctx.inputs.ribWidth), variable('u_dpr'), 'float'),
          variable(resMainIR), 'float')))

      const scrBasis: Basis = {
        point: srtScr, resMain: resMainIR, resPerp: resPerpIR, ribUV: ribUVScreen,
        toPx: (pt) => `(${pt}) * u_resolution`,
        asp: `rg_asp_scr_${id}`, rad: `rg_rad_scr_${id}`, scale: `${ctx.inputs.srt_scale}`,
        amp: ampScrIR, wl: wlScrIR, wlPx: wlPxIR,
      }
      const wave = screenWave({
        ribType, waveShape: (ctx.params.waveShape as string) || 'sine',
        noiseType: (ctx.params.noiseType as string) || 'simplex',
        isVert, basis: scrBasis,
      })
      if (!wave) {
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr};`))
      } else {
        stmts.push(raw(`float rg_wv_scr_${id} = ${wave.expr(srtScr)};`))
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr} + rg_wv_scr_${id};`))
      }

      // Rib gradient and seam geometry: emitted once, shared by all three
      // sub-samples below.
      const grad = emitRibGradient({ id, isVert, basis: scrBasis, wave })
      for (const l of grad.lines) stmts.push(raw(l))
      const seam = emitSeamGeometry({
        id, isVert, wmCentre: warpedMainScr, ribUVScreen,
        ribWidth: `${ctx.inputs.ribWidth}`, scale: `${ctx.inputs.srt_scale}`,
        radScr: `rg_rad_scr_${id}`, grad,
      })
      for (const l of seam.lines) stmts.push(raw(l))

      // Lens + delta at the pixel centre, and at the centroid of each side of a
      // seam that cuts through this pixel.
      const tailArgs = {
        id, isVert, wmCentre: warpedMainScr, gradRate: seam.rate,
        ior: `${ctx.inputs.ior}`, curvature: `${ctx.inputs.curvature}`,
        ribWidth: `${ctx.inputs.ribWidth}`, bow: `${ctx.inputs.bow}`,
        basis: scrBasis, grad,
      }
      const mid = emitLensTail({ ...tailArgs, sfx: '', offPx: '0.0' })
      const subA = emitLensTail({ ...tailArgs, sfx: '_a', offPx: seam.centroidA })
      const subB = emitLensTail({ ...tailArgs, sfx: '_b', offPx: seam.centroidB })
      for (const l of [...mid.lines, ...subA.lines, ...subB.lines]) stmts.push(raw(l))
      // Supersample count from the analytic cross-rib derivative: 1 wherever the
      // lens magnifies (which is everywhere at the defaults), rising with the
      // minification factor and capped.
      const taps = `rg_nt_${id}`
      stmts.push(raw(`float ${taps} = clamp(ceil(abs(${mid.lens}.z)), 1.0, ${MINIF_MAX_TAPS}.0);`))
      const minifArgs = {
        id, isVert, sampler: samplerName, out: `${ctx.outputs.color}`, taps,
        wmCentre: warpedMainScr, ribUVScreen, rate: seam.rate, halfWidth: seam.halfWidth,
        normal: seam.normal, ribWidth: `${ctx.inputs.ribWidth}`, ior: `${ctx.inputs.ior}`,
        curvature: `${ctx.inputs.curvature}`, bow: `${ctx.inputs.bow}`,
        aspScr: `rg_asp_scr_${id}`, radScr: `rg_rad_scr_${id}`,
        scale: `${ctx.inputs.srt_scale}`, grad,
      } as const

      // Use gl_FragCoord/viewport instead of v_uv — matches WebGPU texture convention.
      //
      // MUST be two-argument raw(). The delta is derived from v_uv, which is
      // y-UP in both backends, but the base is gl_FragCoord, which the assembler
      // rewrites to in.position — y-DOWN on WGSL. Mechanical translation would
      // add a y-up delta to a y-down base, inverting the lens on WebGPU only
      // (measured: sample row off by exactly 2× the offset at every fragment,
      // magnification at rib centres becoming compression). Harmless while the
      // delta was x-only for vertical ribs; the moment bow, a rib gradient or
      // srt_rotate puts anything in y, every configuration is exposed.
      //
      // The sub-sample lines carry TWO independent y negations for two different
      // reasons: the seam normal is y-up (pattern basis) and so is the delta.
      // Dropping either one still *looks* antialiased while losing almost all of
      // the benefit, and reads exactly 0.000 at the defaults, where the perp
      // component is never consumed — i.e. invisible in the first thing anyone
      // would eyeball.
      const sampleUV = `rg_sampleUV_${id}`
      stmts.push(raw(
        `vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + ${mid.delta};`,
        `let ${sampleUV} = in.position.xy / uniforms.u_viewport + vec2f(${mid.delta}.x, -${mid.delta}.y);`,
      ))
      for (const [s, c, dv] of [['_a', seam.centroidA, subA.delta], ['_b', seam.centroidB, subB.delta]] as const) {
        stmts.push(raw(
          `vec2 ${sampleUV}${s} = (gl_FragCoord.xy + ${seam.normal} * (${c})) / u_viewport + ${dv};`,
          `let ${sampleUV}${s} = (in.position.xy + vec2f(${seam.normal}.x, -${seam.normal}.y) * (${c})) / uniforms.u_viewport + vec2f(${dv}.x, -${dv}.y);`,
        ))
      }

      // Frosted glass: hash-based jitter blur (8 taps).
      // Premultiplied accumulation — averaging straight-alpha texels drags opaque
      // colour into transparent taps. Reduces exactly to sum(rgb)/8 with alpha 1
      // for a fully opaque source (see rgba-node-audit.md).
      const frostVar = `rg_frost_${id}`
      stmts.push(declare(frostVar, 'float', variable(ctx.inputs.frost)))

      // Use raw() for the conditional frost blur — complex control flow with loop.
      //
      // The WGSL arm MUST be written out rather than left to mechanical
      // translation. Frost is connectable, so when it is wired the `frost > 0.001`
      // condition becomes data-dependent, and mechanical translation emits
      // `textureSample` — which WGSL only permits from uniform control flow. Tint
      // rejects the module with "must only be called from uniform control flow",
      // and the failure is silent and total: createRenderPipeline does not throw on
      // an already-invalid module, so the renderer reports compile SUCCESS, then at
      // draw time the invalid pipeline invalidates the whole command buffer and the
      // entire frame is dropped — including the pass's loadOp:'clear'. The graph
      // still works on the WebGL2 fallback, which has no uniformity rule.
      // textureSampleLevel takes an explicit LOD and is allowed under non-uniform
      // control flow; these textures have no mips so level 0 is the only level.
      const wgslSample = (uv: string) =>
        `textureSampleLevel(${samplerName}_tex, ${samplerName}_samp, ${uv}, 0.0)`
      const frostArgs = {
        id, isVert, sampler: samplerName, out: `${ctx.outputs.color}`,
        coords: coordsVar, frost: frostVar, grain: `${ctx.inputs.grain}`,
        wmCentre: warpedMainScr, ribUVScreen, rate: seam.rate, halfWidth: seam.halfWidth,
        normal: seam.normal, ribWidth: `${ctx.inputs.ribWidth}`, ior: `${ctx.inputs.ior}`,
        curvature: `${ctx.inputs.curvature}`, bow: `${ctx.inputs.bow}`,
        aspScr: `rg_asp_scr_${id}`, radScr: `rg_rad_scr_${id}`,
        scale: `${ctx.inputs.srt_scale}`, grad,
      } as const
      const frostStmts: IRStmt[] = [
        raw(
          `vec4 ${ctx.outputs.color};
  if (${frostVar} > 0.001) {
    ${emitFrostGather({ ...frostArgs, lang: 'glsl' })}
  } else if (${taps} > 1.0) {
    ${emitMinifSupersample({ ...minifArgs, lang: 'glsl' })}
  } else if (${seam.split}) {
    vec4 rg_A_${id} = texture(${samplerName}, ${sampleUV}_a);
    vec4 rg_B_${id} = texture(${samplerName}, ${sampleUV}_b);
    float rg_pa_${id} = rg_A_${id}.a * ${seam.weightA};
    float rg_pb_${id} = rg_B_${id}.a * (1.0 - ${seam.weightA});
    float rg_ao_${id} = rg_pa_${id} + rg_pb_${id};
    ${ctx.outputs.color} = vec4(sombra_toSrgb((sombra_toLin(rg_A_${id}.rgb) * rg_pa_${id} + sombra_toLin(rg_B_${id}.rgb) * rg_pb_${id}) / max(rg_ao_${id}, 1e-5)), rg_ao_${id});
  } else {
    ${ctx.outputs.color} = texture(${samplerName}, ${sampleUV});
  }`,
          `var ${ctx.outputs.color}: vec4f;
  if (${frostVar} > 0.001) {
    ${emitFrostGather({ ...frostArgs, lang: 'wgsl' })}
  } else if (${taps} > 1.0) {
    ${emitMinifSupersample({ ...minifArgs, lang: 'wgsl' })}
  } else if (${seam.split}) {
    let rg_A_${id} = ${wgslSample(`${sampleUV}_a`)};
    let rg_B_${id} = ${wgslSample(`${sampleUV}_b`)};
    let rg_pa_${id} = rg_A_${id}.a * ${seam.weightA};
    let rg_pb_${id} = rg_B_${id}.a * (1.0 - ${seam.weightA});
    let rg_ao_${id} = rg_pa_${id} + rg_pb_${id};
    ${ctx.outputs.color} = vec4f(sombra_toSrgb((sombra_toLin(rg_A_${id}.rgb) * rg_pa_${id} + sombra_toLin(rg_B_${id}.rgb) * rg_pb_${id}) / vec3f(max(rg_ao_${id}, 1e-5))), rg_ao_${id});
  } else {
    ${ctx.outputs.color} = ${wgslSample(sampleUV)};
  }`,
        ),
      ]
            stmts.push(...frostStmts)
    } else {
      // Non-texture fallback: passthrough source input
      stmts.push(
        declare(ctx.outputs.color, 'vec4', variable(ctx.inputs.source)),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(['u_ref_size', 'u_resolution', 'u_dpr', 'u_anchor', 'u_viewport']),
      functions,
    }
  },
}
