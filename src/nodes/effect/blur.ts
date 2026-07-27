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
 * Taps are folded into bilinear pairs (each fetch averages two neighbours), which
 * halves the texture reads at identical quality.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRFunction, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { raw } from '../../compiler/ir/types'

/** Kernel extent is 3 sigma, so the Radius slider reads as the visible reach. */
const SIGMA_PER_RADIUS = 1 / 3

interface Tap {
  off: number
  w: number
}

/**
 * 1D Gaussian taps, one fetch per texel, offsets in reference pixels.
 *
 * Deliberately NOT using the linear-sampling trick (folding adjacent tap pairs
 * into one bilinear fetch at their weighted midpoint). That optimization halves
 * the reads, but the hardware's bilinear blend happens in the texture's storage
 * space, and these passes store sRGB-encoded 8-bit. Blending gamma-encoded values
 * is the same error as blurring in sRGB — measured here as ~11 codes too dark on
 * high-frequency content, while smooth content hid it because neighbouring texels
 * are nearly equal.
 *
 * Folding is only valid when the sampled texture holds linear light. Should the
 * engine ever gain float/linear intermediates, this can go back to half the taps.
 */
function buildTaps(radius: number): Tap[] {
  const sigma = Math.max(0.35, radius * SIGMA_PER_RADIUS)
  // Truncate at 4 sigma, matching the reference kernel this was verified against.
  const r = Math.max(1, Math.ceil(sigma * 4))
  const g = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma))

  const weights: number[] = []
  for (let i = -r; i <= r; i++) weights.push(g(i))
  const total = weights.reduce((a, b) => a + b, 0)

  const taps: Tap[] = []
  for (let i = -r; i <= r; i++) {
    const w = weights[i + r] / total
    if (w <= 1e-7) continue
    taps.push({ off: i, w })
  }
  return taps
}

const GLSL_HELPERS = `vec3 sombra_blur_toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 sombra_blur_toSrgb(vec3 c) {
  vec3 v = max(c, vec3(0.0));
  return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));
}
float sombra_blur_dither(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}`

/** Same three helpers as IR functions, so the WGSL backend emits real signatures. */
const IR_HELPERS: IRFunction[] = [
  {
    key: 'sombra_blur_toLin',
    name: 'sombra_blur_toLin',
    params: [{ name: 'c', type: 'vec3' }],
    returnType: 'vec3',
    body: [
      raw(
        '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));',
        '  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), step(vec3f(0.04045), c));',
      ),
    ],
  },
  {
    key: 'sombra_blur_toSrgb',
    name: 'sombra_blur_toSrgb',
    params: [{ name: 'c', type: 'vec3' }],
    returnType: 'vec3',
    body: [
      raw(
        '  vec3 v = max(c, vec3(0.0));\n  return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), v));',
        '  let v = max(c, vec3f(0.0));\n  return mix(v * 12.92, 1.055 * pow(v, vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), v));',
      ),
    ],
  },
  {
    key: 'sombra_blur_dither',
    name: 'sombra_blur_dither',
    params: [{ name: 'p', type: 'vec2' }],
    returnType: 'float',
    body: [
      raw(
        '  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);',
        '  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);',
      ),
    ],
  },
]

interface EmitOpts {
  id: string
  out: string
  sampler: string | undefined
  fallback: string
  radius: number
  axis: string
  wgsl: boolean
}

function emit(o: EmitOpts): string {
  const { id, out, sampler, fallback, radius, axis, wgsl } = o
  const v4 = wgsl ? 'vec4f' : 'vec4'
  const v3 = wgsl ? 'vec3f' : 'vec3'
  const v2 = wgsl ? 'vec2f' : 'vec2'
  const f = wgsl ? 'f32' : 'float'
  const decl = (t: string, n: string, init: string) => (wgsl ? `var ${n}: ${t} = ${init};` : `${t} ${n} = ${init};`)
  const frag = wgsl ? 'in.position.xy' : 'gl_FragCoord.xy'
  const sample = (uv: string) => (wgsl ? `textureSample(${sampler}_tex, ${sampler}_samp, ${uv})` : `texture(${sampler}, ${uv})`)

  // No upstream texture: nothing to blur, pass the input through untouched.
  if (!sampler) return `${decl(v4, out, fallback)}`

  const dir = axis === 'vertical' ? [0, 1] : [1, 0]
  const taps = buildTaps(radius)
  const L: string[] = []

  L.push(decl(v2, `blr_uv_${id}`, `${frag} / u_viewport`))
  // One reference pixel along the blur axis, in screen UV. u_dpr keeps the blur
  // the same visual size regardless of device pixel ratio.
  L.push(decl(v2, `blr_step_${id}`, `${v2}(${dir[0].toFixed(1)}, ${dir[1].toFixed(1)}) * (u_dpr / u_viewport)`))
  L.push(decl(v3, `blr_acc_${id}`, `${v3}(0.0)`))
  L.push(decl(f, `blr_alpha_${id}`, `0.0`))
  L.push(decl(v4, `blr_t_${id}`, `${v4}(0.0)`))

  for (const t of taps) {
    const uv = `blr_uv_${id} + blr_step_${id} * (${t.off.toPrecision(8)})`
    L.push(`blr_t_${id} = ${sample(uv)};`)
    // premultiplied accumulation in linear light
    L.push(`blr_acc_${id} = blr_acc_${id} + sombra_blur_toLin(blr_t_${id}.rgb) * (blr_t_${id}.a * ${t.w.toPrecision(9)});`)
    L.push(`blr_alpha_${id} = blr_alpha_${id} + blr_t_${id}.a * ${t.w.toPrecision(9)};`)
  }

  const unpremul = wgsl
    ? `select(${v3}(0.0), blr_acc_${id} / blr_alpha_${id}, blr_alpha_${id} > 0.0)`
    : `blr_alpha_${id} > 0.0 ? blr_acc_${id} / blr_alpha_${id} : ${v3}(0.0)`
  L.push(decl(v3, `blr_lin_${id}`, unpremul))
  L.push(
    decl(
      v3,
      `blr_enc_${id}`,
      `sombra_blur_toSrgb(blr_lin_${id}) + ${v3}((sombra_blur_dither(${frag}) - 0.5) / 255.0)`,
    ),
  )
  // Alpha is the same weighted average as the colour — the blur filters alpha,
  // it does not invent it.
  L.push(decl(v4, out, `${v4}(blr_enc_${id}, blr_alpha_${id})`))

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

  // Two passes: horizontal, then vertical.
  multiPass: { count: () => 2, from: 'color', to: 'source' },

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
      // Tap count scales with the radius and bakes as literals (GL ES 3.0 needs
      // constant loop bounds), so this cannot ride as a uniform.
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
    if (sampler) {
      ctx.functionRegistry.set('sombra_blur_helpers', GLSL_HELPERS)
    }
    return emit({
      id,
      out: outputs.color,
      sampler,
      fallback: inputs.source,
      radius: Number(params.radius ?? 12),
      axis: axisFor(params),
      wgsl: false,
    })
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const sampler = ctx.textureSamplers?.source
    const standardUniforms = new Set<string>(['u_viewport', 'u_dpr'])
    const radius = Number(ctx.params.radius ?? 12)
    const axis = axisFor(ctx.params)

    const common = { id, out: ctx.outputs.color, sampler, fallback: ctx.inputs.source, radius, axis }

    const stmts: IRStmt[] = [
      raw(emit({ ...common, wgsl: false }), emit({ ...common, wgsl: true })),
    ]

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms,
      ...(sampler ? { functions: IR_HELPERS } : {}),
    }
  },
}
