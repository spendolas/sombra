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
import type { IRContext, IRFunction, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, call, declare, binary, raw } from '../../compiler/ir/types'

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

  return vec2((floor(coord / ribW) + lensed) * ribW, sag * (ior - 1.0) * amp);`

function registerLensFn(ctx: GLSLContext): void {
  addFunction(ctx, 'reedLens', `vec2 reedLens(float coord, float ribW, float ior, float curvature) {
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

function screenWave(o: {
  ribType: string
  waveShape: string
  noiseType: string
  isVert: boolean
  ampScr: string
  wlScr: string
  wlPx: string
}): ScreenWave | null {
  const { isVert, ampScr, wlScr, wlPx } = o
  const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
  const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
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
    return { expr: (p) => `sin(length((${p}) * u_resolution) / ${wlPx} * 6.28318) * ${ampScr}`, differentiable: true, dependsOnMain: true }
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
function emitScreenDelta(o: {
  id: string
  isVert: boolean
  srtScr: string
  disp: string
  bowPerp: string
  aspScr: string
  radScr: string
  scale: string
  wave: ScreenWave | null
}): { lines: string[]; delta: string } {
  const { id, isVert, srtScr, disp, bowPerp, aspScr, radScr, scale, wave } = o
  const resMain = isVert ? 'u_resolution.x' : 'u_resolution.y'
  const resPerp = isVert ? 'u_resolution.y' : 'u_resolution.x'
  const gm = `rg_gm_${id}`
  const gp = `rg_gp_${id}`
  const den = `rg_den_${id}`
  const d = `rg_d_${id}`
  const lines: string[] = []

  // ∂w/∂main and ∂w/∂perp, both in pixels-per-pixel. Differencing in the
  // pattern basis (not on screen) is what makes srt_scale cancel out here and
  // apply once, below.
  if (wave && wave.differentiable && wave.dependsOnMain) {
    const em = isVert ? `vec2(1.0 / ${resMain}, 0.0)` : `vec2(0.0, 1.0 / ${resMain})`
    lines.push(`vec2 rg_em_${id} = ${em};`)
    lines.push(`float ${gm} = (${wave.expr(`${srtScr} + rg_em_${id}`)} - ${wave.expr(`${srtScr} - rg_em_${id}`)}) * 0.5 * ${resMain};`)
  } else {
    lines.push(`float ${gm} = 0.0;`)
  }
  if (wave && wave.differentiable) {
    const ep = isVert ? `vec2(0.0, 1.0 / ${resPerp})` : `vec2(1.0 / ${resPerp}, 0.0)`
    lines.push(`vec2 rg_ep_${id} = ${ep};`)
    lines.push(`float ${gp} = (${wave.expr(`${srtScr} + rg_ep_${id}`)} - ${wave.expr(`${srtScr} - rg_ep_${id}`)}) * 0.5 * ${resMain};`)
  } else {
    lines.push(`float ${gp} = 0.0;`)
  }

  lines.push(`float ${den} = (1.0 + ${gm}) * (1.0 + ${gm}) + ${gp} * ${gp};`)
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

    // Integer-based hash for frost jitter — no sin artifacts/scanlines
    addFunction(ctx, 'reedHash', `vec2 reedHash(vec2 p) {
  uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;
}`)

    const isVert = direction === 'vertical'
    const lines: string[] = []

    // Generate auto_uv with SRT applied (frozen-ref space)
    ctx.uniforms.add('u_resolution')
    ctx.uniforms.add('u_dpr')
    ctx.uniforms.add('u_ref_size')
    ctx.uniforms.add('u_anchor')
    const coordsVar = `rg_coords_${id}`
    lines.push(`vec2 ${coordsVar} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`)
    // SRT: center → scale → rotate (aspect-corrected) → translate → re-center
    lines.push(`${coordsVar} -= u_anchor;`)
    lines.push(`${coordsVar} /= vec2(${inputs.srt_scale});`)
    const aspRef = `rg_asp_ref_${id}`
    const radRef = `rg_rad_ref_${id}`
    lines.push(`float ${aspRef} = u_resolution.x / u_resolution.y;`)
    lines.push(`float ${radRef} = ${inputs.srt_rotate} * 0.01745329;`)
    lines.push(`${coordsVar}.x *= ${aspRef};`)
    lines.push(`${coordsVar} = vec2(${coordsVar}.x * cos(${radRef}) - ${coordsVar}.y * sin(${radRef}), ${coordsVar}.x * sin(${radRef}) + ${coordsVar}.y * cos(${radRef}));`)
    lines.push(`${coordsVar}.x /= ${aspRef};`)
    lines.push(`${coordsVar} -= vec2(${inputs.srt_translateX}, -(${inputs.srt_translateY})) / (u_dpr * u_ref_size);`)
    lines.push(`${coordsVar} += u_anchor;`)

    // main = axis being sliced, perp = perpendicular axis
    const main = isVert ? `${coordsVar}.x` : `${coordsVar}.y`
    const perp = isVert ? `${coordsVar}.y` : `${coordsVar}.x`

    const warpedMain = `rg_wm_${id}`

    // Convert amplitude and wavelength from pixels to frozen-ref UV
    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    lines.push(`float ${ampRef} = ${inputs.amplitude} / u_ref_size;`)
    lines.push(`float ${wlRef} = ${inputs.wavelength} / u_ref_size;`)

    if (ribType === 'straight') {
      lines.push(`float ${warpedMain} = ${main};`)
    } else {
      const waveVal = `rg_wv_${id}`

      if (ribType === 'wave') {
        const waveShape = (params.waveShape as string) || 'sine'
        switch (waveShape) {
          case 'sine':
            lines.push(`float ${waveVal} = sin(${perp} / ${wlRef} * 6.28318) * ${ampRef};`); break
          case 'triangle':
            lines.push(`float ${waveVal} = (abs(fract(${perp} / ${wlRef}) - 0.5) * 4.0 - 1.0) * ${ampRef};`); break
          case 'square':
            lines.push(`float ${waveVal} = (step(0.5, fract(${perp} / ${wlRef})) * 2.0 - 1.0) * ${ampRef};`); break
          case 'sawtooth':
            lines.push(`float ${waveVal} = (fract(${perp} / ${wlRef}) * 2.0 - 1.0) * ${ampRef};`); break
          case 'chevron':
            lines.push(`float ${waveVal} = (abs(${perp} * 2.0 - 1.0)) * ${ampRef} * sin(${perp} / ${wlRef} * 6.28318);`); break
          case 'u_shape':
            lines.push(`float ${waveVal} = (pow(abs(fract(${perp} / ${wlRef}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampRef};`); break
        }
      } else if (ribType === 'circular') {
        lines.push(`float ${waveVal} = sin(length(${coordsVar} - 0.5) / ${wlRef} * 6.28318) * ${ampRef};`)
      } else if (ribType === 'noise') {
        const noiseType = (params.noiseType as string) || 'simplex'
        registerNoiseType(ctx, noiseType)
        const noiseFn = resolveNoiseFn(noiseType)
        lines.push(`float ${waveVal} = (${noiseFn}(vec3(${perp} / ${wlRef}, ${main} / ${wlRef}, 0.0)) * 2.0 - 1.0) * ${ampRef};`)
      }

      lines.push(`float ${warpedMain} = ${main} + ${waveVal};`)
    }

    // Rib width in frozen-ref UV space (for coords output)
    ctx.uniforms.add('u_ref_size')
    const ribUVRef = `rg_ribUV_ref_${id}`
    lines.push(`float ${ribUVRef} = ${inputs.ribWidth} / u_ref_size;`)

    // Rib width in screen UV space (for texture mode sampling)
    ctx.uniforms.add('u_resolution')
    ctx.uniforms.add('u_dpr')
    const ribUVScreen = `rg_ribUV_scr_${id}`
    lines.push(`float ${ribUVScreen} = ${inputs.ribWidth} * u_dpr / u_resolution.${isVert ? 'x' : 'y'};`)

    // Lens remap in frozen-ref space (for coords output)
    const lensRef = `rg_lens_ref_${id}`
    lines.push(`vec2 ${lensRef} = reedLens(${warpedMain}, ${ribUVRef}, ${inputs.ior}, ${inputs.curvature});`)
    // Thickness bow, in rib half-widths → frozen-ref UV (isotropic, no aspect)
    const bowRef = `rg_bow_ref_${id}`
    lines.push(`float ${bowRef} = ${lensRef}.y * ${ribUVRef} * 0.5 * ${inputs.bow};`)

    // Reconstruct distorted vec2 (frozen-ref coords output)
    const distorted = `rg_distorted_${id}`
    if (isVert) {
      lines.push(`vec2 ${distorted} = vec2(${lensRef}.x, ${coordsVar}.y + ${bowRef});`)
    } else {
      lines.push(`vec2 ${distorted} = vec2(${coordsVar}.x + ${bowRef}, ${lensRef}.x);`)
    }

    // Coords output — always populated
    lines.push(`vec2 ${outputs.coords} = ${distorted};`)

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

      const wave = screenWave({
        ribType, waveShape: (params.waveShape as string) || 'sine',
        noiseType: (params.noiseType as string) || 'simplex',
        isVert, ampScr, wlScr, wlPx,
      })
      if (!wave) {
        lines.push(`float ${warpedMainScr} = ${mainScr};`)
      } else {
        lines.push(`float rg_wv_scr_${id} = ${wave.expr(srtScr)};`)
        lines.push(`float ${warpedMainScr} = ${mainScr} + rg_wv_scr_${id};`)
      }

      // Lens in screen UV space
      const lensScr = `rg_lens_scr_${id}`
      lines.push(`vec2 ${lensScr} = reedLens(${warpedMainScr}, ${ribUVScreen}, ${inputs.ior}, ${inputs.curvature});`)
      const disp = `rg_disp_${id}`
      lines.push(`float ${disp} = ${lensScr}.x - ${warpedMainScr};`)
      // Thickness bow, in rib half-widths → device px → perp-axis screen UV
      const bowScr = `rg_bow_scr_${id}`
      lines.push(`float ${bowScr} = ${lensScr}.y * (${inputs.ribWidth} * u_dpr * 0.5) * ${inputs.bow} / ${resPerp};`)

      const { lines: deltaLines, delta } = emitScreenDelta({
        id, isVert, srtScr, disp, bowPerp: bowScr,
        aspScr, radScr, scale: `${inputs.srt_scale}`, wave,
      })
      lines.push(...deltaLines)

      // Use gl_FragCoord/viewport instead of v_uv for FBO sampling —
      // on WGSL, in.position.y=0 at top matches WebGPU texture convention,
      // while v_uv.y=0 at bottom does not.
      ctx.uniforms.add('u_viewport')
      const sampleUV = `rg_sampleUV_${id}`
      lines.push(`vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + ${delta};`)

      // Frosted glass: hash-based jitter blur (grainy texture).
      // Premultiplied accumulation — averaging straight-alpha texels drags
      // opaque colour into transparent taps. Reduces exactly to sum(rgb)/8 with
      // alpha 1 for a fully opaque source (see rgba-node-audit.md).
      const frostVar = `rg_frost_${id}`
      lines.push(`float ${frostVar} = ${inputs.frost};`)
      lines.push(`vec4 ${outputs.color};`)
      lines.push(`if (${frostVar} > 0.001) {`)
      lines.push(`  vec3 rg_acc_${id} = vec3(0.0);`)
      lines.push(`  float rg_aacc_${id} = 0.0;`)
      // Radius is a length, so it belongs in px, not in per-axis UV where it
      // picks up the canvas aspect and reshapes the grain footprint on resize.
      lines.push(`  vec2 rg_frad_${id} = vec2(${frostVar} * 24.0 * u_dpr) / u_viewport;`)
      // Seed off a quantised frozen-ref lattice, NOT the sample position: the
      // hash is over raw float bits, so seeding from anything the lens touches
      // fully re-randomises the grain on every resize, DPR flip and param drag.
      lines.push(`  vec2 rg_gc_${id} = floor(${coordsVar} * (u_ref_size * 0.25));`)
      lines.push(`  for (int rg_i_${id} = 0; rg_i_${id} < 8; rg_i_${id}++) {`)
      lines.push(`    vec2 rg_jit_${id} = reedHash(rg_gc_${id} + vec2(float(rg_i_${id}) * 7.31, float(rg_i_${id}) * -11.13)) * rg_frad_${id};`)
      lines.push(`    vec2 rg_tap_${id} = ${sampleUV} + rg_jit_${id};`)
      lines.push(`    rg_tap_${id} = 1.0 - abs(fract(rg_tap_${id} * 0.5) * 2.0 - 1.0);`)
      lines.push(`    vec4 rg_s_${id} = texture(${samplerName}, rg_tap_${id});`)
      lines.push(`    rg_acc_${id} += rg_s_${id}.rgb * rg_s_${id}.a;`)
      lines.push(`    rg_aacc_${id} += rg_s_${id}.a;`)
      lines.push(`  }`)
      lines.push(`  ${outputs.color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / 8.0);`)
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
      returnType: 'vec2',
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

    // --- Main computation ---
    const stmts: IRStmt[] = []

    // Generate auto_uv with SRT applied (frozen-ref space)
    // WGSL: in.position.y is already top-to-bottom — NO y-flip needed
    const coordsVar = `rg_coords_${id}`
    // WGSL needs `var` (mutable) since SRT modifies it in-place
    stmts.push(raw(
      // GLSL
      `vec2 ${coordsVar} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`,
      // WGSL
      `var ${coordsVar}: vec2f = (in.position.xy - uniforms.u_resolution * uniforms.u_anchor) / (uniforms.u_dpr * uniforms.u_ref_size) + uniforms.u_anchor;`,
    ))
    // SRT: center → scale → rotate (aspect-corrected) → translate → re-center
    stmts.push(raw(
      // GLSL
      `${coordsVar} -= u_anchor;\n` +
      `  ${coordsVar} /= vec2(${ctx.inputs.srt_scale});\n` +
      `  float rg_asp_ref_${id} = u_resolution.x / u_resolution.y;\n` +
      `  float rg_rad_ref_${id} = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar}.x *= rg_asp_ref_${id};\n` +
      `  ${coordsVar} = vec2(${coordsVar}.x * cos(rg_rad_ref_${id}) - ${coordsVar}.y * sin(rg_rad_ref_${id}), ${coordsVar}.x * sin(rg_rad_ref_${id}) + ${coordsVar}.y * cos(rg_rad_ref_${id}));\n` +
      `  ${coordsVar}.x /= rg_asp_ref_${id};\n` +
      `  ${coordsVar} -= vec2(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (u_dpr * u_ref_size);\n` +
      `  ${coordsVar} += u_anchor;`,
      // WGSL
      `${coordsVar} -= uniforms.u_anchor;\n` +
      `  ${coordsVar} /= vec2f(${ctx.inputs.srt_scale});\n` +
      `  var rg_asp_ref_${id}: f32 = uniforms.u_resolution.x / uniforms.u_resolution.y;\n` +
      `  var rg_rad_ref_${id}: f32 = ${ctx.inputs.srt_rotate} * 0.01745329;\n` +
      `  ${coordsVar}.x *= rg_asp_ref_${id};\n` +
      `  ${coordsVar} = vec2f(${coordsVar}.x * cos(rg_rad_ref_${id}) - ${coordsVar}.y * sin(rg_rad_ref_${id}), ${coordsVar}.x * sin(rg_rad_ref_${id}) + ${coordsVar}.y * cos(rg_rad_ref_${id}));\n` +
      `  ${coordsVar}.x /= rg_asp_ref_${id};\n` +
      `  ${coordsVar} -= vec2f(${ctx.inputs.srt_translateX}, -(${ctx.inputs.srt_translateY})) / (uniforms.u_dpr * uniforms.u_ref_size);\n` +
      `  ${coordsVar} += uniforms.u_anchor;`,
    ))

    const mainAxis = isVert ? `${coordsVar}.x` : `${coordsVar}.y`
    const perpAxis = isVert ? `${coordsVar}.y` : `${coordsVar}.x`

    const warpedMain = `rg_wm_${id}`

    // Convert amplitude and wavelength from pixels to frozen-ref UV
    const ampRef = `rg_amp_ref_${id}`
    const wlRef = `rg_wl_ref_${id}`
    stmts.push(raw(`float ${ampRef} = ${ctx.inputs.amplitude} / u_ref_size;`))
    stmts.push(raw(`float ${wlRef} = ${ctx.inputs.wavelength} / u_ref_size;`))

    if (ribType === 'straight') {
      stmts.push(declare(warpedMain, 'float', variable(mainAxis)))
    } else {
      const waveVal = `rg_wv_${id}`

      if (ribType === 'wave') {
        const waveShape = (ctx.params.waveShape as string) || 'sine'
        switch (waveShape) {
          case 'sine':
            stmts.push(raw(`float ${waveVal} = sin(${perpAxis} / ${wlRef} * 6.28318) * ${ampRef};`)); break
          case 'triangle':
            stmts.push(raw(`float ${waveVal} = (abs(fract(${perpAxis} / ${wlRef}) - 0.5) * 4.0 - 1.0) * ${ampRef};`)); break
          case 'square':
            stmts.push(raw(`float ${waveVal} = (step(0.5, fract(${perpAxis} / ${wlRef})) * 2.0 - 1.0) * ${ampRef};`)); break
          case 'sawtooth':
            stmts.push(raw(`float ${waveVal} = (fract(${perpAxis} / ${wlRef}) * 2.0 - 1.0) * ${ampRef};`)); break
          case 'chevron':
            stmts.push(raw(`float ${waveVal} = (abs(${perpAxis} * 2.0 - 1.0)) * ${ampRef} * sin(${perpAxis} / ${wlRef} * 6.28318);`)); break
          case 'u_shape':
            stmts.push(raw(`float ${waveVal} = (pow(abs(fract(${perpAxis} / ${wlRef}) * 2.0 - 1.0), 2.0) * 2.0 - 1.0) * ${ampRef};`)); break
        }
      } else if (ribType === 'circular') {
        stmts.push(raw(`float ${waveVal} = sin(length(${coordsVar} - 0.5) / ${wlRef} * 6.28318) * ${ampRef};`))
      } else if (ribType === 'noise') {
        const noiseType = (ctx.params.noiseType as string) || 'simplex'
        const noiseFn = resolveNoiseFn(noiseType)
        functions.push(...getIRNoiseFunctions(noiseType))
        stmts.push(raw(`float ${waveVal} = (${noiseFn}(vec3(${perpAxis} / ${wlRef}, ${mainAxis} / ${wlRef}, 0.0)) * 2.0 - 1.0) * ${ampRef};`))
      }

      stmts.push(
        declare(warpedMain, 'float',
          binary('+', variable(mainAxis), variable(waveVal), 'float'),
        ),
      )
    }

    // Rib width in frozen-ref UV (for coords output)
    const ribUVRef = `rg_ribUV_ref_${id}`
    stmts.push(
      declare(ribUVRef, 'float',
        binary('/', variable(ctx.inputs.ribWidth), variable('u_ref_size'), 'float'),
      ),
    )

    // Rib width in screen UV (for texture mode)
    const resComponent = isVert ? 'u_resolution.x' : 'u_resolution.y'
    const ribUVScreen = `rg_ribUV_scr_${id}`
    stmts.push(
      declare(ribUVScreen, 'float',
        binary('/',
          binary('*', variable(ctx.inputs.ribWidth), variable('u_dpr'), 'float'),
          variable(resComponent),
          'float',
        ),
      ),
    )

    // Lens remap in frozen-ref space (for coords output)
    const lensRef = `rg_lens_ref_${id}`
    stmts.push(
      declare(lensRef, 'vec2',
        call('reedLens', [
          variable(warpedMain),
          variable(ribUVRef),
          variable(ctx.inputs.ior),
          variable(ctx.inputs.curvature),
        ], 'vec2'),
      ),
    )
    // Thickness bow, in rib half-widths → frozen-ref UV (isotropic, no aspect)
    const bowRef = `rg_bow_ref_${id}`
    stmts.push(raw(`float ${bowRef} = ${lensRef}.y * ${ribUVRef} * 0.5 * ${ctx.inputs.bow};`))

    // Reconstruct distorted vec2 (frozen-ref coords output)
    const distorted = `rg_distorted_${id}`
    if (isVert) {
      stmts.push(raw(`vec2 ${distorted} = vec2(${lensRef}.x, ${coordsVar}.y + ${bowRef});`))
    } else {
      stmts.push(raw(`vec2 ${distorted} = vec2(${coordsVar}.x + ${bowRef}, ${lensRef}.x);`))
    }

    // Coords output
    stmts.push(
      declare(ctx.outputs.coords, 'vec2', variable(distorted)),
    )

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

      const wave = screenWave({
        ribType, waveShape: (ctx.params.waveShape as string) || 'sine',
        noiseType: (ctx.params.noiseType as string) || 'simplex',
        isVert, ampScr: ampScrIR, wlScr: wlScrIR, wlPx: wlPxIR,
      })
      if (!wave) {
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr};`))
      } else {
        stmts.push(raw(`float rg_wv_scr_${id} = ${wave.expr(srtScr)};`))
        stmts.push(raw(`float ${warpedMainScr} = ${mainScr} + rg_wv_scr_${id};`))
      }

      // Lens in screen UV space
      const lensScr = `rg_lens_scr_${id}`
      stmts.push(
        declare(lensScr, 'vec2',
          call('reedLens', [
            variable(warpedMainScr),
            variable(ribUVScreen),
            variable(ctx.inputs.ior),
            variable(ctx.inputs.curvature),
          ], 'vec2'),
        ),
      )
      const disp = `rg_disp_${id}`
      stmts.push(raw(`float ${disp} = ${lensScr}.x - ${warpedMainScr};`))
      // Thickness bow, in rib half-widths → device px → perp-axis screen UV
      const bowScr = `rg_bow_scr_${id}`
      stmts.push(raw(`float ${bowScr} = ${lensScr}.y * (${ctx.inputs.ribWidth} * u_dpr * 0.5) * ${ctx.inputs.bow} / ${resPerpIR};`))

      const { lines: deltaLines, delta } = emitScreenDelta({
        id, isVert, srtScr, disp, bowPerp: bowScr,
        aspScr: `rg_asp_scr_${id}`, radScr: `rg_rad_scr_${id}`,
        scale: `${ctx.inputs.srt_scale}`, wave,
      })
      for (const l of deltaLines) stmts.push(raw(l))

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
      const sampleUV = `rg_sampleUV_${id}`
      stmts.push(raw(
        `vec2 ${sampleUV} = gl_FragCoord.xy / u_viewport + ${delta};`,
        `let ${sampleUV} = in.position.xy / uniforms.u_viewport + vec2f(${delta}.x, -${delta}.y);`,
      ))

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
      const frostStmts: IRStmt[] = [
        raw(
          `vec4 ${ctx.outputs.color};
  if (${frostVar} > 0.001) {
    vec3 rg_acc_${id} = vec3(0.0);
    float rg_aacc_${id} = 0.0;
    vec2 rg_frad_${id} = vec2(${frostVar} * 24.0 * u_dpr) / u_viewport;
    vec2 rg_gc_${id} = floor(${coordsVar} * (u_ref_size * 0.25));
    for (int rg_i_${id} = 0; rg_i_${id} < 8; rg_i_${id}++) {
      vec2 rg_jit_${id} = reedHash(rg_gc_${id} + vec2(float(rg_i_${id}) * 7.31, float(rg_i_${id}) * -11.13)) * rg_frad_${id};
      vec2 rg_tap_${id} = ${sampleUV} + rg_jit_${id};
      rg_tap_${id} = 1.0 - abs(fract(rg_tap_${id} * 0.5) * 2.0 - 1.0);
      vec4 rg_s_${id} = texture(${samplerName}, rg_tap_${id});
      rg_acc_${id} += rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} += rg_s_${id}.a;
    }
    ${ctx.outputs.color} = vec4(rg_acc_${id} / max(rg_aacc_${id}, 1e-5), rg_aacc_${id} / 8.0);
  } else {
    ${ctx.outputs.color} = texture(${samplerName}, ${sampleUV});
  }`,
          `var ${ctx.outputs.color}: vec4f;
  if (${frostVar} > 0.001) {
    var rg_acc_${id}: vec3f = vec3f(0.0);
    var rg_aacc_${id}: f32 = 0.0;
    let rg_frad_${id} = vec2f(${frostVar} * 24.0 * uniforms.u_dpr) / uniforms.u_viewport;
    let rg_gc_${id} = floor(${coordsVar} * (uniforms.u_ref_size * 0.25));
    for (var rg_i_${id}: i32 = 0; rg_i_${id} < 8; rg_i_${id}++) {
      let rg_jit_${id} = reedHash(rg_gc_${id} + vec2f(f32(rg_i_${id}) * 7.31, f32(rg_i_${id}) * -11.13)) * rg_frad_${id};
      var rg_tap_${id} = ${sampleUV} + rg_jit_${id};
      rg_tap_${id} = vec2f(1.0) - abs(fract(rg_tap_${id} * 0.5) * vec2f(2.0) - vec2f(1.0));
      let rg_s_${id} = ${wgslSample(`rg_tap_${id}`)};
      rg_acc_${id} = rg_acc_${id} + rg_s_${id}.rgb * rg_s_${id}.a;
      rg_aacc_${id} = rg_aacc_${id} + rg_s_${id}.a;
    }
    ${ctx.outputs.color} = vec4f(rg_acc_${id} / vec3f(max(rg_aacc_${id}, 1e-5)), rg_aacc_${id} / 8.0);
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
