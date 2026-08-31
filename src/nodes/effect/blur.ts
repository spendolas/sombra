/**
 * Gaussian Blur — a separable Gaussian in linear light with premultiplied alpha.
 *
 * ONE node, two render passes. A separable blur must filter horizontally, store
 * the result, then filter vertically, but the compiler assigns one pass depth per
 * node; the node declares `multiPass` and is expanded into a chain before
 * partitioning (src/compiler/expand-passes.ts), reading its pass index from
 * `params.__subPass` to pick the axis.
 *
 * The second pass is not optional: a single-pass 2D gather was measured against
 * an ideal Gaussian and even 192 sparse taps sit ~4 codes off at sigma 12+,
 * against 0.26 for the separable form.
 * See docs/research/2026-07-27-blur-algorithm-bakeoff.md.
 *
 * Three things this node does that a naive blur does not, each measured:
 *  - averages in LINEAR light. Averaging gamma-encoded values loses ~12% of a
 *    scene's light and puts a blurred black/white edge midpoint at sRGB 132
 *    instead of 190.
 *  - convolves PREMULTIPLIED. Straight-alpha averaging drags colour out of fully
 *    transparent texels, which shows as a halo around anything with soft edges.
 *  - DITHERS the 8-bit write. Banding in a wide blur comes from the final
 *    quantization, not from intermediate precision; one LSB of noise removes it.
 *
 * Radius is wireable and rides as a uniform: weights are evaluated per tap at
 * runtime, so changing or animating it neither recompiles nor pops.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { COLOR_GLSL_HELPERS, COLOR_IR_HELPERS } from '../shared/color-space'
import { raw } from '../../compiler/ir/types'

/** Kernel extent is 3 sigma, so the Radius slider reads as the visible reach. */
const SIGMA_PER_RADIUS = 1 / 3

/** Largest radius the slider offers, and the ceiling a wired value is clamped to. */
const RADIUS_MAX = 128

/**
 * Highest device pixel ratio the renderer will hand us — both cap at
 * Math.min(devicePixelRatio, 2). Taps step ONE texel and sigma is measured in
 * texels (sigma_reference * u_frame_scale), so the loop bound must cover the worst case.
 */
const MAX_DPR = 2

/**
 * Loop half-width in texels: 4 sigma at the largest radius and the highest dpr.
 * Truncating at 4 sigma matches the reference kernel this was verified against.
 *
 * There is deliberately no user-facing "max radius" knob. The bound is a loop
 * limit, not a tap list: the body breaks at 4 sigma of the LIVE radius, so runtime
 * cost follows the actual radius and a generous bound costs nothing — not even
 * shader length, since only this literal changes. (That was not true of the
 * earlier unrolled form, where the bound really did set the cost.)
 */

const BAKED_HALF_WIDTH = Math.max(1, Math.ceil(RADIUS_MAX * SIGMA_PER_RADIUS * 4 * MAX_DPR))

/**
 * Taps are one fetch per texel with weights evaluated AT RUNTIME from the radius,
 * inside a loop with a constant bound that breaks early once past 4 sigma of the
 * live radius. That is the repo's documented shape for a connectable param
 * (NODE_AUTHORING_GUIDE "Connectable params with loop bounds"), and it is what
 * lets Radius be wired at all: a wired value only exists at runtime, so a kernel
 * baked from it is impossible.
 *
 * Deliberately NOT using the linear-sampling trick (folding adjacent tap pairs
 * into one bilinear fetch at their weighted midpoint). That optimization halves
 * the reads, but the hardware's bilinear blend happens in the texture's storage
 * space, and these passes store sRGB-encoded 8-bit. Blending gamma-encoded values
 * is the same error as blurring in sRGB — measured here as ~11 codes too dark on
 * high-frequency content, while smooth content hid it because neighbouring texels
 * are nearly equal. Folding is only valid when the sampled texture holds linear
 * light; should the engine gain float/linear intermediates, it can come back.
 */


interface EmitOpts {
  id: string
  out: string
  sampler: string | undefined
  fallback: string
  /** GLSL/WGSL expression for the live radius — may be a wired value. */
  radiusExpr: string
  axis: string
  /** 'fit' skips out-of-bounds taps and renormalises; 'repeat' clamps (AE parity). */
  edgeMode: string
  wgsl: boolean
}

function emit(o: EmitOpts): string {
  const { id, out, sampler, fallback, radiusExpr, axis, edgeMode, wgsl } = o
  const v4 = wgsl ? 'vec4f' : 'vec4'
  const v3 = wgsl ? 'vec3f' : 'vec3'
  const v2 = wgsl ? 'vec2f' : 'vec2'
  const f = wgsl ? 'f32' : 'float'
  const decl = (t: string, n: string, init: string) => (wgsl ? `var ${n}: ${t} = ${init};` : `${t} ${n} = ${init};`)
  const frag = wgsl ? 'in.position.xy' : 'gl_FragCoord.xy'
  // Explicit LOD. A wired radius makes the loop's break condition vary per pixel,
  // and WGSL forbids implicit-derivative textureSample under non-uniform control
  // flow. These textures have no mips, so level 0 is the only level anyway.
  const sample = (uv: string) =>
    wgsl
      ? `textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${uv}, 0.0)`
      : `textureLod(${sampler}, ${uv}, 0.0)`

  // No upstream texture: nothing to blur, pass the input through untouched.
  if (!sampler) return `${decl(v4, out, fallback)}`

  const dir = axis === 'vertical' ? [0, 1] : [1, 0]
  const R = BAKED_HALF_WIDTH
  const L: string[] = []

  const axisComp = axis === 'vertical' ? 'y' : 'x'
  L.push(decl(v2, `blr_uv_${id}`, `${frag} / u_viewport`))
  // ONE TEXEL per tap. It is tempting to step one *reference* pixel
  // (u_frame_scale / u_viewport) so the kernel is dpr-independent, but that makes each tap
  // skip u_frame_scale texels: at dpr 2 an output pixel then reads only its own parity and
  // half the source is never sampled — a measured 2-px staircase with 26-40 code
  // risers, and a 34.8-code jump when the quality tier flips dpr mid-session.
  // Kernel WIDTH still has to be dpr-independent, so dpr goes into sigma instead.
  L.push(decl(v2, `blr_step_${id}`, `${v2}(${dir[0].toFixed(1)}, ${dir[1].toFixed(1)}) / u_viewport`))
  // Sigma in TEXELS: clamp in reference units, then scale. Both bounds must scale —
  // scaling only the upper one would shrink the smallest possible blur by u_frame_scale.
  L.push(decl(f, `blr_sig_${id}`, `clamp((${radiusExpr}) * ${SIGMA_PER_RADIUS.toPrecision(9)}, 0.35, ${(RADIUS_MAX * SIGMA_PER_RADIUS).toPrecision(9)}) * u_frame_scale`))
  L.push(decl(f, `blr_inv_${id}`, `1.0 / (2.0 * blr_sig_${id} * blr_sig_${id})`))
  L.push(decl(f, `blr_cut_${id}`, `blr_sig_${id} * 4.0`))
  L.push(decl(v3, `blr_acc_${id}`, `${v3}(0.0)`))
  L.push(decl(f, `blr_alpha_${id}`, `0.0`))
  L.push(decl(f, `blr_wsum_${id}`, `0.0`))
  L.push(decl(v4, `blr_t_${id}`, `${v4}(0.0)`))
  L.push(decl(f, `blr_w_${id}`, `0.0`))
  L.push(decl(f, `blr_p_${id}`, `0.0`))

  // Bound is baked; the break makes a small radius cheap.
  const body: string[] = []
  body.push(`  ${decl(f, `blr_fi_${id}`, wgsl ? `f32(blr_i_${id})` : `float(blr_i_${id})`)}`)
  body.push(wgsl
    ? `    if (blr_fi_${id} > blr_cut_${id}) { break; }`
    : `    if (blr_fi_${id} > blr_cut_${id}) break;`)
  body.push(`    blr_w_${id} = exp(-blr_fi_${id} * blr_fi_${id} * blr_inv_${id});`)
  // centre tap once, every other offset mirrored
  for (const sign of ['+', '-']) {
    const mirrored = sign === '-'
    body.push(`    blr_p_${id} = blr_uv_${id}.${axisComp} ${sign} blr_step_${id}.${axisComp} * blr_fi_${id};`)
    // Gate on the tap being inside the source. Counting a clamped tap at full
    // Gaussian weight is what lets ONE border texel drive up to ~49% of the output
    // across a 4-sigma band, which is the smear that tracks the canvas border on
    // resize. Skipping it and normalising over the weight actually gathered drops
    // that sensitivity to ~2%. `repeat` keeps the clamped behaviour, matching After
    // Effects' Repeat Edge Pixels.
    const inBounds = edgeMode === 'repeat'
      ? null
      : `blr_p_${id} >= 0.0 && blr_p_${id} <= 1.0`
    const cond = [mirrored ? `blr_i_${id} > 0` : null, inBounds].filter(Boolean).join(' && ')
    body.push(`    if (${cond || 'true'}) {`)
    body.push(`      blr_t_${id} = ${sample(`blr_uv_${id} ${sign} blr_step_${id} * blr_fi_${id}`)};`)
    body.push(`      blr_acc_${id} = blr_acc_${id} + sombra_toLin(blr_t_${id}.rgb) * (blr_t_${id}.a * blr_w_${id});`)
    body.push(`      blr_alpha_${id} = blr_alpha_${id} + blr_t_${id}.a * blr_w_${id};`)
    body.push(`      blr_wsum_${id} = blr_wsum_${id} + blr_w_${id};`)
    body.push(`    }`)
  }
  L.push(wgsl
    ? `for (var blr_i_${id}: i32 = 0; blr_i_${id} <= ${R}; blr_i_${id}++) {\n${body.join('\n')}\n  }`
    : `for (int blr_i_${id} = 0; blr_i_${id} <= ${R}; blr_i_${id}++) {\n${body.join('\n')}\n  }`)

  // Weights are evaluated at runtime, so normalize by what was actually summed.
  const safeDiv = (num: string, den: string, cond: string) =>
    wgsl ? `select(${v3}(0.0), ${num} / ${den}, ${cond})` : `${cond} ? ${num} / ${den} : ${v3}(0.0)`
  L.push(decl(v3, `blr_lin_${id}`, safeDiv(`blr_acc_${id}`, `blr_alpha_${id}`, `blr_alpha_${id} > 0.0`)))
  L.push(decl(f, `blr_a_${id}`, wgsl
    ? `select(0.0, blr_alpha_${id} / blr_wsum_${id}, blr_wsum_${id} > 0.0)`
    : `blr_wsum_${id} > 0.0 ? blr_alpha_${id} / blr_wsum_${id} : 0.0`))
  L.push(
    decl(
      v3,
      `blr_enc_${id}`,
      `sombra_toSrgb(blr_lin_${id}) + ${v3}((sombra_dither(${frag}) - 0.5) / 255.0)`,
    ),
  )
  // Alpha is the same weighted average as the colour — the blur filters alpha,
  // it does not invent it.
  L.push(decl(v4, out, `${v4}(blr_enc_${id}, blr_a_${id})`))

  return L.join('\n  ')
}

/** Sub-pass 0 filters horizontally, sub-pass 1 vertically. */
function axisFor(params: Record<string, unknown>): 'horizontal' | 'vertical' {
  return Number(params.__subPass ?? 0) === 0 ? 'horizontal' : 'vertical'
}

export const blurNode: NodeDefinition = {
  type: 'blur',
  label: 'Gaussian Blur',
  category: 'Effect',
  description: 'Separable Gaussian blur in linear light with premultiplied alpha',
  textureFilter: 'linear',

  // A blur of nothing conveys nothing, so keep the thumbnail hidden until a
  // source is wired. Without this the node shows a preview area the moment it is
  // added, which reads as stale content rather than as "no input yet".
  conditionalPreview: true,

  // Two passes: horizontal, then vertical.
  //
  // Both passes rasterise at HALF linear resolution (¼ the fragments). A blur is
  // a low-pass filter — it destroys exactly the high frequencies a full-res
  // target would preserve — so downscaling the blur passes is near-free visually
  // while cutting each pass's fragment count ~4×. `u_frame_scale` is scaled with
  // the pass so the kernel's reach in REFERENCE units is unchanged (guarded by
  // verify:frame-scale-invariance); screen-UV sampling stays correct (guarded by
  // verify:pass-resolution:gpu), and WGSL/GLSL agree because the scale lives in
  // this backend-agnostic config, not the shader text (verify-blur-backend-parity).
  //
  // The declaration applies to BOTH sub-passes. When the blur is the terminal
  // node its vertical (last) pass is force-drawn at full canvas by the renderer
  // (writeMultiPassBuiltinUniforms), so the horizontal pass is the one that
  // actually downscales there; mid-chain, both downscale and the downstream
  // consumer reads a half-res — already-blurred — texture at full res.
  multiPass: { count: () => 2, from: 'color', to: 'source', resolution: () => 0.5 },

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
      max: 128,
      step: 0.5,
      // Wireable, and a uniform: weights are evaluated per-tap at runtime, so
      // changing or animating the radius neither recompiles nor pops. Values above
      // Max Radius are clamped in-shader.
      connectable: true,
      updateMode: 'uniform',
      // A big radius is genuinely expensive (~343 fetches per pass at the max),
      // so warn even though it no longer recompiles.
      warnAbove: 96,
      // Honest, non-prescriptive routing: Kawase holds a fixed ~20-tap cost at
      // any radius (still animatable); Pyramid is cheapest for a large static
      // radius (recompiles on change, not connectable).
      warnHint: 'Kawase Blur holds a fixed cost, or Pyramid Blur for a static large radius.',
    },
    {
      id: 'edgeMode',
      label: 'Edges',
      type: 'enum',
      default: 'fit',
      options: [
        { value: 'fit', label: 'Fit to Canvas' },
        { value: 'repeat', label: 'Repeat Edge Pixels' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms, params } = ctx
    uniforms.add('u_viewport')
    uniforms.add('u_frame_scale')
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    if (sampler) {
      ctx.functionRegistry.set('sombra_color_helpers', COLOR_GLSL_HELPERS)
    }
    return emit({
      id,
      out: outputs.color,
      sampler,
      fallback: inputs.source,
      // Connectable, so it MUST be read through inputs (the compiler resolves it to
      // either a uniform or an upstream expression); params would miss a wire.
      radiusExpr: inputs.radius,
      axis: axisFor(params),
      edgeMode: String(params.edgeMode ?? 'fit'),
      wgsl: false,
    })
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    const standardUniforms = new Set<string>(['u_viewport', 'u_frame_scale'])
    const axis = axisFor(ctx.params)

    const common = {
      id,
      out: ctx.outputs.color,
      sampler,
      fallback: ctx.inputs.source,
      radiusExpr: ctx.inputs.radius,
      axis,
      edgeMode: String(ctx.params.edgeMode ?? 'fit'),
    }

    // With no upstream texture the body is just the passthrough of the port
    // default, and that default arrives in GLSL syntax (`vec4(...)`). Supplying an
    // explicit WGSL override here would SKIP the backend's mechanical translation
    // and emit invalid WGSL, so the shader would fail to compile and the node's
    // preview would silently render nothing. Let the backend translate instead.
    const stmts: IRStmt[] = sampler
      ? [raw(emit({ ...common, wgsl: false }), emit({ ...common, wgsl: true }))]
      : [raw(emit({ ...common, wgsl: false }))]

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms,
      ...(sampler ? { functions: COLOR_IR_HELPERS } : {}),
    }
  },
}
