/**
 * Gaussian Blur — a RADIUS-ADAPTIVE PYRAMID Gaussian in linear light with
 * premultiplied alpha and a dithered write.
 *
 * The bake-off (docs/research/2026-07-27-blur-algorithm-bakeoff.md) chose this over
 * a plain separable Gaussian: shape indistinguishable from a full-resolution
 * Gaussian, for 71× less sampling work at σ64, because its cost FALLS as the radius
 * grows. The structure is
 *
 *     ingest    sRGB straight       -> linear premultiplied   (folded into the first op)
 *     N x       progressive halving  (5-tap dual-filter box, each at 0.5^depth)
 *     2 x       linear-sampled Gaussian at the coarse level (σ~4px, H then V)
 *     N x       progressive upsampling (8-tap dual-filter)
 *     egress    linear premultiplied -> sRGB straight + dither (folded into the last op)
 *
 * `N = clamp(floor(log2(σ / 4)), 0, 5)`, σ = radius/3, so the coarse-level σ stays
 * near 4px at every radius — the rule that keeps it clean at both ends. The coarse
 * σ is set by SUBTRACTING the pyramid's own intrinsic blur, not by dividing, or the
 * width runs ~4% wide and steps at each N boundary.
 *
 * Per-pass resolution comes from `multiPass.resolution` (RenderPass.resolution): each
 * pass rasterises at `0.5^depth`, and the framework scales u_dpr so screen-UV sampling
 * stays correct. Tap offsets are in SOURCE texels — down reads a 2× larger source
 * (0.5 target-texel/offset), up reads a 2× smaller one (2 target-texels), coarse reads
 * a same-size source (1 target-texel). See `srcFactor` below.
 *
 * The ingest/egress colour conversion is FOLDED into the first and last passes rather
 * than run as separate passes: separate ones would add 2 to the pass count, and at N=3
 * that is 9 intermediates — over the WebGL2 cap of 8. Folded, the deepest pyramid
 * (radius 128 → N=3) is 8 passes / 7 intermediates, which fits both backends.
 *
 * TRADE-OFF, deliberate: radius is `recompile` and NOT connectable. N (and therefore the
 * pass count and per-pass resolution) is a compile-time decision, so a wired or animated
 * radius is impossible by construction — a dragged slider recompiles (debounced). Code
 * needing a wireable/animatable radius wants the linear-sampled separable Gaussian, which
 * the bake-off names as the fallback and which is what this node used to be
 * (git history before feat/pyramid-blur).
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { COLOR_GLSL_HELPERS, COLOR_IR_HELPERS } from '../shared/color-space'
import { raw } from '../../compiler/ir/types'

/** Kernel extent is 3 sigma, so the Radius slider reads as the visible reach. */
const SIGMA_PER_RADIUS = 1 / 3

/** Largest radius the slider offers. Do NOT raise past 128 without bake-off engine
 *  change #2 (WebGL2 ping-pong reuse): 128 → N=3 → 7 intermediates == the cap with a
 *  folded bracket, and a deeper pyramid overflows WebGL2. */
const RADIUS_MAX = 128

/** Coarse level targets ~4px sigma. */
const TARGET_SMALL = 4

/** Deepest pyramid. N=5 would be 12 passes; the radius cap keeps us at N≤3 anyway. */
const N_MAX = 5

/**
 * Measured intrinsic sigma of the down+up chain, per N (bake-off phase5b-fix.ts).
 * The chain is itself a blur; the coarse Gaussian must be narrowed to leave room for
 * it, or the total runs wide and steps at each N boundary.
 */
const INTRINSIC_SIGMA = [0.31, 2.07, 4.68, 9.70, 19.21, 38.99]

type Role = 'down' | 'coarseH' | 'coarseV' | 'up'

interface PassInfo {
  role: Role
  /** Render-target scale for this pass, relative to canvas (RenderPass.resolution). */
  scale: number
  /** Source texel size in units of THIS pass's target texels: down 0.5, coarse 1, up 2. */
  srcFactor: number
  isFirst: boolean
  isLast: boolean
}

interface PyramidPlan {
  N: number
  /** Coarse-level Gaussian sigma, in coarse-level texels. Baked at compile time. */
  coarseSigma: number
  passes: PassInfo[]
}

/** The whole pyramid structure for a given radius. Single source of truth for
 *  multiPass.count, multiPass.resolution, and per-sub-pass role dispatch. */
export function pyramidPlan(radiusPx: number): PyramidPlan {
  const sigma = Math.max(0, radiusPx) * SIGMA_PER_RADIUS
  const N = sigma <= TARGET_SMALL ? 0 : Math.max(0, Math.min(N_MAX, Math.floor(Math.log2(sigma / TARGET_SMALL))))
  // Subtract the down/up chain's own blur, then express at the coarse level's scale.
  const intrinsic = INTRINSIC_SIGMA[N]
  const coarseSigma = Math.sqrt(Math.max(0, sigma * sigma - intrinsic * intrinsic)) / 2 ** N

  const passes: PassInfo[] = []
  for (let d = 1; d <= N; d++) passes.push({ role: 'down', scale: 2 ** -d, srcFactor: 0.5, isFirst: false, isLast: false })
  passes.push({ role: 'coarseH', scale: 2 ** -N, srcFactor: 1, isFirst: false, isLast: false })
  passes.push({ role: 'coarseV', scale: 2 ** -N, srcFactor: 1, isFirst: false, isLast: false })
  for (let d = N - 1; d >= 0; d--) passes.push({ role: 'up', scale: 2 ** -d, srcFactor: 2, isFirst: false, isLast: false })

  passes[0].isFirst = true
  passes[passes.length - 1].isLast = true
  return { N, coarseSigma, passes }
}

/** Radius from params, clamped. Not connectable — see the node header. */
function radiusOf(params: Record<string, unknown>): number {
  const r = Number(params.radius ?? 12)
  return Math.max(0, Math.min(RADIUS_MAX, Number.isFinite(r) ? r : 12))
}

/**
 * A 1-D Gaussian kernel out to 4 sigma, normalised — the same shape the bake-off's
 * CPU reference and GPU candidates used, so a GPU-vs-reference comparison is meaningful.
 */
function gaussianKernel1D(sigma: number): number[] {
  const s = Math.max(sigma, 1e-4)
  const radius = Math.max(1, Math.ceil(s * 4))
  const w: number[] = []
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s))
    w.push(v)
    sum += v
  }
  return w.map((v) => v / sum)
}

/** Linear-sampled taps: centre alone, then fold adjacent pairs into one bilinear
 *  fetch at their weighted midpoint (RasterGrid), halving reads. Valid because the
 *  intermediates hold LINEAR light — the whole reason for the premultiplied bracket. */
function foldedGaussTaps(sigma: number): Array<{ off: number; w: number }> {
  const k = gaussianKernel1D(sigma)
  const r = (k.length - 1) / 2
  const taps: Array<{ off: number; w: number }> = [{ off: 0, w: k[r] }]
  for (let i = 1; i <= r; i += 2) {
    const w1 = k[r + i]
    const w2 = i + 1 <= r ? k[r + i + 1] : 0
    const w = w1 + w2
    if (w <= 0) continue
    const off = (i * w1 + (i + 1) * w2) / w
    taps.push({ off, w })
    taps.push({ off: -off, w })
  }
  return taps
}

interface EmitOpts {
  id: string
  out: string
  sampler: string | undefined
  fallback: string
  pass: PassInfo
  coarseSigma: number
  wgsl: boolean
}

function emit(o: EmitOpts): string {
  const { id, out, sampler, fallback, pass, coarseSigma, wgsl } = o
  const v4 = wgsl ? 'vec4f' : 'vec4'
  const v3 = wgsl ? 'vec3f' : 'vec3'
  const v2 = wgsl ? 'vec2f' : 'vec2'
  const decl = (t: string, n: string, init: string) => (wgsl ? `var ${n}: ${t} = ${init};` : `${t} ${n} = ${init};`)
  const frag = wgsl ? 'in.position.xy' : 'gl_FragCoord.xy'
  // Explicit LOD — these render targets have no mips and level 0 is the only level;
  // it is also the form legal under any control flow in WGSL.
  const sample = (uv: string) =>
    wgsl ? `textureSampleLevel(${sampler}_tex, ${sampler}_samp, ${uv}, 0.0)` : `textureLod(${sampler}, ${uv}, 0.0)`

  if (!sampler) return `${decl(v4, out, fallback)}`

  const L: string[] = []
  L.push(decl(v2, `b_uv_${id}`, `${frag} / u_viewport`))
  // One SOURCE texel in UV. srcFactor converts target texels -> source texels:
  // down reads a 2× larger source (0.5), up a 2× smaller one (2.0), coarse same (1.0).
  L.push(decl(v2, `b_t_${id}`, `${v2}(${pass.srcFactor.toPrecision(9)}) / u_viewport`))

  // A tap, returned already in linear-PREMULTIPLIED space. The first pass ingests
  // sRGB-straight and converts; every later pass reads values already converted.
  const tap = (uvExpr: string): string => {
    const s = sample(uvExpr)
    if (pass.isFirst) return `${v4}(sombra_toLin((${s}).rgb) * (${s}).a, (${s}).a)`
    return s
  }

  if (pass.role === 'down') {
    // Bjorge dual-filter downsample: centre*4 + 4 corners at ±1 source-texel, /8.
    L.push(decl(v4, `b_s_${id}`, `${tap(`b_uv_${id}`)} * 4.0`))
    for (const [sx, sy] of [[-1, -1], [1, 1], [1, -1], [-1, 1]]) {
      L.push(`b_s_${id} = b_s_${id} + ${tap(`b_uv_${id} + ${v2}(${sx.toFixed(1)}, ${sy.toFixed(1)}) * b_t_${id}`)};`)
    }
    L.push(decl(v4, `b_o_${id}`, `b_s_${id} / 8.0`))
  } else if (pass.role === 'up') {
    // Bjorge dual-filter upsample: edge midpoints *2, corners *1, /12, at ±1 source-texel.
    L.push(decl(v4, `b_s_${id}`, `${v4}(0.0)`))
    for (const [sx, sy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      L.push(`b_s_${id} = b_s_${id} + ${tap(`b_uv_${id} + ${v2}(${sx.toFixed(1)}, ${sy.toFixed(1)}) * b_t_${id}`)} * 2.0;`)
    }
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      L.push(`b_s_${id} = b_s_${id} + ${tap(`b_uv_${id} + ${v2}(${sx.toFixed(1)}, ${sy.toFixed(1)}) * b_t_${id}`)};`)
    }
    L.push(decl(v4, `b_o_${id}`, `b_s_${id} / 12.0`))
  } else {
    // Coarse: one axis of a linear-sampled separable Gaussian at coarseSigma (in
    // coarse-level texels). H then V across the two coarse passes.
    //
    // Radius is authored in REFERENCE px, so the blur must widen by u_dpr to reach the
    // same visible extent on a hi-DPI display. N is picked dpr-independently (compile
    // time), but the coarse blur is where width is set: scaling every tap offset by u_dpr
    // and keeping the baked weights turns a Gaussian of coarseSigma into one of
    // coarseSigma*u_dpr — a Gaussian is self-similar under offset scaling. The down/up
    // passes are fixed structural resamples and take no dpr. (At dpr 2 the coarse sigma
    // lands near 8px rather than 4px — still well within the method's clean range.)
    const axis = pass.role === 'coarseH' ? [1, 0] : [0, 1]
    const taps = foldedGaussTaps(coarseSigma)
    L.push(decl(v2, `b_ct_${id}`, `b_t_${id} * u_dpr`))
    L.push(decl(v4, `b_s_${id}`, `${v4}(0.0)`))
    for (const t of taps) {
      const uv = `b_uv_${id} + ${v2}(${(axis[0] * t.off).toPrecision(9)}, ${(axis[1] * t.off).toPrecision(9)}) * b_ct_${id}`
      L.push(`b_s_${id} = b_s_${id} + ${tap(uv)} * ${t.w.toPrecision(9)};`)
    }
    L.push(decl(v4, `b_o_${id}`, `b_s_${id}`))
  }

  if (pass.isLast) {
    // Egress: un-premultiply, encode to sRGB, dither one LSB. Alpha passes through —
    // the blur filters alpha, it does not invent it.
    const unpre = wgsl
      ? `select(${v3}(0.0), b_o_${id}.rgb / b_o_${id}.a, b_o_${id}.a > 0.0)`
      : `b_o_${id}.a > 0.0 ? b_o_${id}.rgb / b_o_${id}.a : ${v3}(0.0)`
    L.push(decl(v3, `b_lin_${id}`, unpre))
    L.push(decl(v3, `b_enc_${id}`, `sombra_toSrgb(b_lin_${id}) + ${v3}((sombra_dither(${frag}) - 0.5) / 255.0)`))
    L.push(decl(v4, out, `${v4}(b_enc_${id}, b_o_${id}.a)`))
  } else {
    // Intermediate: keep linear-premultiplied, no colour conversion.
    L.push(decl(v4, out, `b_o_${id}`))
  }

  return L.join('\n  ')
}

/** The sub-pass index selects which pyramid pass this invocation emits. */
function passFor(params: Record<string, unknown>): PassInfo {
  const plan = pyramidPlan(radiusOf(params))
  const i = Math.max(0, Math.min(plan.passes.length - 1, Number(params.__subPass ?? 0)))
  return plan.passes[i]
}

export const blurNode: NodeDefinition = {
  type: 'blur',
  label: 'Gaussian Blur',
  category: 'Effect',
  description: 'Radius-adaptive pyramid Gaussian blur in linear light with premultiplied alpha',
  textureFilter: 'linear',

  conditionalPreview: true,

  multiPass: {
    count: (p) => pyramidPlan(radiusOf(p)).passes.length,
    from: 'color',
    to: 'source',
    resolution: (i, p) => {
      const passes = pyramidPlan(radiusOf(p)).passes
      return passes[Math.max(0, Math.min(passes.length - 1, i))].scale
    },
  },

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
      // NOT connectable: N (pass count + per-pass resolution) is decided at compile
      // time from the radius, so a wired runtime value cannot drive the pyramid.
      // Recompile on change; the debounced worker recompile handles a dragged slider.
      updateMode: 'recompile',
      warnAbove: 96,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms, params } = ctx
    uniforms.add('u_viewport')
    uniforms.add('u_dpr')
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    if (sampler) ctx.functionRegistry.set('sombra_color_helpers', COLOR_GLSL_HELPERS)
    return emit({
      id,
      out: outputs.color,
      sampler,
      fallback: inputs.source,
      pass: passFor(params),
      coarseSigma: pyramidPlan(radiusOf(params)).coarseSigma,
      wgsl: false,
    })
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    const common = {
      id,
      out: ctx.outputs.color,
      sampler,
      fallback: ctx.inputs.source,
      pass: passFor(ctx.params),
      coarseSigma: pyramidPlan(radiusOf(ctx.params)).coarseSigma,
    }
    const stmts: IRStmt[] = sampler
      ? [raw(emit({ ...common, wgsl: false }), emit({ ...common, wgsl: true }))]
      : [raw(emit({ ...common, wgsl: false }))]
    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set<string>(['u_viewport', 'u_dpr']),
      ...(sampler ? { functions: COLOR_IR_HELPERS } : {}),
    }
  },
}
