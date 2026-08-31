/**
 * Kawase Blur ⏱ — EXPERIMENTAL. An ANIMATABLE multi-pass Kawase blur: the radius is
 * a live uniform, so it can be wired and animated with no recompile and no pop — the
 * thing the pyramid (`pyramid_blur`) cannot do, because the pyramid bakes its pass
 * count and per-pass resolution from the radius at compile time.
 *
 * The trade the prototype accepts (see docs/superpowers/specs/2026-07-30-animatable-
 * pyramid-blur-design.md): FIXED pass count. Its passes rasterise at HALF linear
 * resolution (the low-pass half-res lever, same as Gaussian Blur — see multiPass below).
 * Kawase's classic
 * structure is a small fixed set of passes whose sample offsets grow per pass; scaling
 * every offset by one factor scales the whole (self-similar) kernel, so a uniform can
 * drive the blur size continuously. Cost is therefore constant in radius — cheaper than
 * the separable Gaussian at large radius (20 fetches vs its hundreds), fixed at small.
 * The known Kawase tell is faint grid/shimmer at VERY large radius, where the sparse
 * per-pass taps stop overlapping; if that look is unacceptable we escalate to the
 * framework cross-fade (design option B).
 *
 * Shape: each pass fetches the 4 diagonal corners at ±off and averages them (0.25 each)
 * — separable, so per axis it is two deltas at ±off with variance off². Across P passes
 * the variances add: σ_texels = k·√(Σ Aₚ²). We want σ = radius/3 · u_frame_scale (the repo's
 * texel-sigma convention, matching Gaussian Blur), so k = σ / √(Σ Aₚ²) is solved in the
 * shader from the live radius — no per-radius calibration constant to tune by eye.
 *
 * Quality bracket, same as every Sombra blur (bake-off): linear-light + premultiplied
 * alpha in/out + a dithered 8-bit write. Ingest (sRGB→linear-premult) folds into the
 * first pass, egress (unpremult→sRGB + dither) into the last; intermediates stay LINEAR
 * so the 4-tap bilinear fetches blend correct light. Alpha passes through — the blur
 * filters alpha, it does not invent it.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { COLOR_GLSL_HELPERS, COLOR_IR_HELPERS } from '../shared/color-space'
import { raw } from '../../compiler/ir/types'

/** Kernel extent is 3 sigma, so the Radius slider reads as the visible reach —
 *  identical to Gaussian Blur, so a given radius looks the same across nodes. */
const SIGMA_PER_RADIUS = 1 / 3

/** Slider ceiling and the clamp a wired value is held to. */
const RADIUS_MAX = 256

/**
 * Per-pass offset schedule Aₚ (in the kernel's own units; the shader multiplies by k).
 * Growing offsets spread the sparse taps so the combined kernel stays gap-free over a
 * useful range. FIVE passes is the classic Kawase sweet spot for a Gaussian-ish shape.
 * σ = k·√(Σ Aₚ²); the shader solves k so σ tracks radius/3.
 */
const OFFSETS = [1, 2, 3, 4, 5]
const PASS_COUNT = OFFSETS.length
/** √(Σ Aₚ²) — the constant relating the offset scale k to the output sigma. */
const OFFSET_RMS = Math.sqrt(OFFSETS.reduce((s, a) => s + a * a, 0))

/**
 * The blur has a variance FLOOR: every bilinear fetch at a fractional offset adds a
 * ~tent (triangle) filter, so five passes contribute a near-constant intrinsic sigma in
 * DEVICE texels independent of radius. Left unaccounted it over-blurs the small end
 * (measured σ 1.71 vs target 1.33 at radius 4 → floor ≈ √(1.71²−1.33²) ≈ 1.07 texels).
 * We subtract it in quadrature — target the Kawase kernel at √(σ² − floor²) so the floor
 * brings the OUTPUT back to σ — mirroring the pyramid's intrinsic-sigma subtraction. It
 * is a device-texel constant, NOT ×u_frame_scale (the fetch grid is device-resolution; σ already
 * carries u_frame_scale), so the correction fades as radius grows and vanishes by mid-range.
 */
const INTRINSIC_TEXELS = 1.07

interface EmitOpts {
  id: string
  out: string
  sampler: string | undefined
  fallback: string
  /** GLSL/WGSL expression for the live radius — may be a wired value. */
  radiusExpr: string
  /** This sub-pass's offset Aₚ. */
  offset: number
  isFirst: boolean
  isLast: boolean
  wgsl: boolean
}

function emit(o: EmitOpts): string {
  const { id, out, sampler, fallback, radiusExpr, offset, isFirst, isLast, wgsl } = o
  const v4 = wgsl ? 'vec4f' : 'vec4'
  const v3 = wgsl ? 'vec3f' : 'vec3'
  const v2 = wgsl ? 'vec2f' : 'vec2'
  const f = wgsl ? 'f32' : 'float'
  const decl = (t: string, n: string, init: string) => (wgsl ? `var ${n}: ${t} = ${init};` : `${t} ${n} = ${init};`)
  const frag = wgsl ? 'in.position.xy' : 'gl_FragCoord.xy'
  // Explicit LOD: a wired radius makes offsets vary per pixel, and WGSL forbids
  // implicit-derivative sampling under non-uniform flow; these targets have no mips.
  const sample = (uv: string) =>
    wgsl
      ? `textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${uv}, 0.0)`
      : `textureLod(${sampler}, ${uv}, 0.0)`

  // No upstream texture: nothing to blur, pass the input default through.
  if (!sampler) return `${decl(v4, out, fallback)}`

  // A tap, returned in linear-PREMULTIPLIED space. The first pass ingests sRGB-straight
  // and converts; later passes read values already converted (intermediates are linear).
  const tap = (uv: string): string => {
    const s = sample(uv)
    return isFirst ? `${v4}(sombra_toLin((${s}).rgb) * (${s}).a, (${s}).a)` : s
  }

  const L: string[] = []
  L.push(decl(v2, `kw_uv_${id}`, `${frag} / u_viewport`))
  // σ in texels = clamp(radius)·(1/3)·u_frame_scale; k spreads the fixed offset schedule to hit
  // it. u_frame_scale enters here (kernel WIDTH must be dpr-independent in reference px), the
  // same place Gaussian Blur puts it. One texel in UV is 1/u_viewport.
  L.push(decl(f, `kw_sig_${id}`, `clamp((${radiusExpr}) * ${SIGMA_PER_RADIUS.toPrecision(9)}, 0.0, ${(RADIUS_MAX * SIGMA_PER_RADIUS).toPrecision(9)}) * u_frame_scale`))
  // Aim the kernel at √(σ² − floor²): the intrinsic tent floor then lands it back on σ.
  L.push(decl(f, `kw_kern_${id}`, `sqrt(max(0.0, kw_sig_${id} * kw_sig_${id} - ${(INTRINSIC_TEXELS * INTRINSIC_TEXELS).toPrecision(9)}))`))
  L.push(decl(f, `kw_k_${id}`, `kw_kern_${id} / ${OFFSET_RMS.toPrecision(9)}`))
  // This pass's corner offset, in TEXELS (isotropic — rotated below, then converted to UV
  // per-axis). Plain Kawase samples a fixed axis-aligned 4-corner pattern; at large radius
  // the sparse taps leave kernel gaps → a coherent passband GRID that crawls in motion.
  L.push(decl(f, `kw_off_${id}`, `${offset.toPrecision(9)} * kw_k_${id}`))
  // STOCHASTIC: rotate the 4-corner pattern by a per-pixel, per-pass hashed angle. The jitter
  // both fills the gaps (each pixel samples a different orientation → the neighbourhood-average
  // kernel is smooth) and decorrelates whatever leaks into STATIC noise (hash of position, not
  // time → no temporal crawl). The seed differs per pass so the passes decorrelate.
  L.push(decl(f, `kw_h_${id}`, `fract(sin(dot(${frag}, ${v2}(12.9898, 78.233)) + ${offset.toPrecision(9)}) * 43758.5453)`))
  L.push(decl(f, `kw_th_${id}`, `6.28318531 * kw_h_${id}`))
  L.push(decl(f, `kw_ct_${id}`, `cos(kw_th_${id})`))
  L.push(decl(f, `kw_st_${id}`, `sin(kw_th_${id})`))

  // 4 rotated corners, weight 0.25 each (already premultiplied → plain average).
  L.push(decl(v4, `kw_s_${id}`, `${v4}(0.0)`))
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    // Rotate the unit corner (sx,sy) by the hashed angle, scale by offset (texels), to UV.
    const rx = `(${sx.toFixed(1)} * kw_ct_${id} - ${sy.toFixed(1)} * kw_st_${id})`
    const ry = `(${sx.toFixed(1)} * kw_st_${id} + ${sy.toFixed(1)} * kw_ct_${id})`
    const uv = `kw_uv_${id} + ${v2}(${rx} * kw_off_${id}, ${ry} * kw_off_${id}) / u_viewport`
    L.push(`kw_s_${id} = kw_s_${id} + ${tap(uv)};`)
  }
  L.push(decl(v4, `kw_o4_${id}`, `kw_s_${id} * 0.25`))

  if (isLast) {
    // Egress: un-premultiply, encode to sRGB, dither one LSB. Alpha passes through.
    const unpre = wgsl
      ? `select(${v3}(0.0), kw_o4_${id}.rgb / kw_o4_${id}.a, kw_o4_${id}.a > 0.0)`
      : `kw_o4_${id}.a > 0.0 ? kw_o4_${id}.rgb / kw_o4_${id}.a : ${v3}(0.0)`
    L.push(decl(v3, `kw_lin_${id}`, unpre))
    L.push(decl(v3, `kw_enc_${id}`, `sombra_toSrgb(kw_lin_${id}) + ${v3}((sombra_dither(${frag}) - 0.5) / 255.0)`))
    L.push(decl(v4, out, `${v4}(kw_enc_${id}, kw_o4_${id}.a)`))
  } else {
    // Intermediate: keep linear-premultiplied, no colour conversion.
    L.push(decl(v4, out, `kw_o4_${id}`))
  }

  return L.join('\n  ')
}

/** The sub-pass index selects this pass's offset (and first/last role). */
function passOffset(params: Record<string, unknown>): { offset: number; isFirst: boolean; isLast: boolean } {
  const i = Math.max(0, Math.min(PASS_COUNT - 1, Number(params.__subPass ?? 0)))
  return { offset: OFFSETS[i], isFirst: i === 0, isLast: i === PASS_COUNT - 1 }
}

export const kawaseBlurNode: NodeDefinition = {
  type: 'kawase_blur',
  label: 'Kawase Blur ⏱',
  category: 'Effect',
  description: 'EXPERIMENTAL animatable multi-pass Kawase blur — radius is a live uniform (wireable/animatable), fixed cost, in linear light with premultiplied alpha',
  textureFilter: 'linear',

  conditionalPreview: true,

  // Fixed pass count (NOT radius-dependent) — that is what keeps radius a uniform.
  //
  // Every pass rasterises at HALF linear resolution (¼ the fragments). Kawase is a
  // low-pass filter, like the Gaussian (blur.ts) — it destroys exactly the high
  // frequencies a full-res target would keep — so downscaling its passes is near-free
  // visually: shape still matches a Gaussian of σ=radius/3 (verify-kawase-blur-gpu),
  // shimmer/leakage is unchanged (verify-kawase-shimmer), and the half-vs-full pixel
  // delta is RMS ~0.5 / max ~6 codes — a re-realisation of the sub-visible stochastic
  // jitter grain at half-res, NOT structural softening (contrast reeded-glass at 107).
  // Each downscaled pass cuts its fragment count ~4×. `u_frame_scale` is scaled with the pass
  // so the kernel's reach in REFERENCE units is unchanged (guarded by
  // verify:frame-scale-invariance); screen-UV sampling stays correct
  // (verify:pass-resolution:gpu), and WGSL/GLSL agree because the scale is backend-agnostic
  // config, not shader text. Each kawase sub-pass is its own depth group, so the pin rule
  // (pass-resolution.ts) is satisfied; when Kawase is terminal its last pass is force-drawn
  // at full canvas by the renderer, so the earlier passes are the ones that downscale.
  multiPass: { count: () => PASS_COUNT, from: 'color', to: 'source', resolution: () => 0.5 },

  inputs: [
    { id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 1] },
  ],

  outputs: [{ id: 'color', label: 'Color', type: 'color' }],

  params: [
    {
      id: 'radius',
      label: 'Radius',
      type: 'float',
      default: 12,
      min: 0,
      max: RADIUS_MAX,
      step: 0.5,
      // Wireable + uniform: offsets are scaled per-pass from the live radius, so
      // changing or animating it neither recompiles nor pops — the whole point.
      connectable: true,
      updateMode: 'uniform',
      warnAbove: 160,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms, params } = ctx
    uniforms.add('u_viewport')
    uniforms.add('u_frame_scale')
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    if (sampler) ctx.functionRegistry.set('sombra_color_helpers', COLOR_GLSL_HELPERS)
    const { offset, isFirst, isLast } = passOffset(params)
    return emit({
      id,
      out: outputs.color,
      sampler,
      fallback: inputs.source,
      radiusExpr: inputs.radius, // connectable → read through inputs, not params
      offset,
      isFirst,
      isLast,
      wgsl: false,
    })
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    const { offset, isFirst, isLast } = passOffset(ctx.params)
    const common = {
      id,
      out: ctx.outputs.color,
      sampler,
      fallback: ctx.inputs.source,
      radiusExpr: ctx.inputs.radius,
      offset,
      isFirst,
      isLast,
    }
    const stmts: IRStmt[] = sampler
      ? [raw(emit({ ...common, wgsl: false }), emit({ ...common, wgsl: true }))]
      : [raw(emit({ ...common, wgsl: false }))]
    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set<string>(['u_viewport', 'u_frame_scale']),
      ...(sampler ? { functions: COLOR_IR_HELPERS } : {}),
    }
  },
}
