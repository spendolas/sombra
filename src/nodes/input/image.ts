/**
 * Image node — loads a user-uploaded image as a sampler2D texture.
 * Outputs: color (color/RGBA — sampled rgb + alpha combined), alpha (float — same alpha,
 * kept as a separate port for backward-compat with existing graphs wired to it).
 * The image is stored as base64 in params.imageData and bound as a uniform sampler2D.
 */

import type { NodeDefinition, GLSLContext, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { declare, assign, construct, literal, raw, call, variable, binary, ternary, textureSample } from '../../compiler/ir/types'

/** Compute the sampler uniform name for an image node. */
export function imageSamplerName(nodeId: string): string {
  return `u_${nodeId.replace(/-/g, '_')}_image`
}

const FIT_MODE_OPTIONS = [
  { value: 'contain', label: 'Fit' },
  { value: 'cover', label: 'Fill' },
]

/**
 * `clamp(uv, vec2(0), vec2(1))` as IR. The VECTOR form is valid in both GLSL and WGSL;
 * GLSL's `clamp(vec2, float, float)` overload does not exist in WGSL, and relying on it is
 * what forced these sites to carry a hand-written WGSL arm.
 */
const clampUV = (uv: string) => call('clamp', [
  variable(uv),
  construct('vec2', [literal('float', 0.0)]),
  construct('vec2', [literal('float', 1.0)]),
], 'vec2')

export const imageNode: NodeDefinition = {
  type: 'image',
  label: 'Image',
  category: 'Input',
  description: 'Upload an image file to use as a texture',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    // auto_uv (isotropic, ref-sized) — the framework SRTs this before the node.
    // Isotropic space is what lets rotation stay aspect-true (a rotated circle
    // stays a circle); the old screen_uv space rotated anisotropically → shear.
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
    { id: 'alpha', label: 'Alpha', type: 'float' },
  ],

  params: [
    { id: 'imageData', label: 'Image Data', type: 'float', default: 0, hidden: true, updateMode: 'recompile' },
    { id: 'imageName', label: 'Image Name', type: 'float', default: 0, hidden: true, updateMode: 'recompile' },
    {
      id: 'imageAspect', label: 'Image Aspect', type: 'float', default: 1,
      hidden: true, updateMode: 'uniform',
    },
    {
      id: 'fitMode', label: 'Mode', type: 'enum', default: 'contain',
      options: FIT_MODE_OPTIONS, updateMode: 'recompile',
    },
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
  ],

  glsl: (ctx: GLSLContext) => {
    const { inputs, outputs, params } = ctx
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const samplerName = `u_${sanitizedId}_image`
    const hasImage = !!(params.imageData)
    const fitMode = (params.fitMode as string) || 'contain'

    // Register image sampler so assembleFragmentShader declares it
    if (ctx.imageSamplers) {
      ctx.imageSamplers.add(samplerName)
    }

    const lines: string[] = []

    if (hasImage) {
      ctx.uniforms.add('u_resolution')
      ctx.uniforms.add('u_anchor')
      ctx.uniforms.add('u_dpr')
      ctx.uniforms.add('u_ref_size')

      // inputs.coords is SRT-transformed AUTO_UV — isotropic. Fit is px-based and
      // applied AFTER the isotropic SRT, so contain/cover preserve the image
      // aspect at any rotation (a rotated circle stays a circle; the old
      // screen_uv path rotated in an anisotropic space and sheared it). imgDisp
      // is the image's on-canvas pixel size; texUV = SRT'd physical offset /
      // imgDisp. Y is negated because auto_uv is y-down and the texture is y-up.
      const fitUV = `img_uv_${sanitizedId}`
      const ac = `img_ac_${sanitizedId}`, dh = `img_dh_${sanitizedId}`, dw = `img_dw_${sanitizedId}`
      lines.push(`float ${ac} = u_resolution.x / u_resolution.y;`)
      if (fitMode === 'contain') {
        lines.push(`float ${dh} = (${inputs.imageAspect} > ${ac}) ? (u_resolution.x / ${inputs.imageAspect}) : u_resolution.y;`)
      } else {
        lines.push(`float ${dh} = (${inputs.imageAspect} > ${ac}) ? u_resolution.y : (u_resolution.x / ${inputs.imageAspect});`)
      }
      lines.push(`float ${dw} = ${dh} * ${inputs.imageAspect};`)
      lines.push(`vec2 ${fitUV} = vec2(0.0);`)
      lines.push(`${fitUV}.x = (${inputs.coords}.x - u_anchor.x) * (u_dpr * u_ref_size) / ${dw} + 0.5;`)
      lines.push(`${fitUV}.y = -(${inputs.coords}.y - u_anchor.y) * (u_dpr * u_ref_size) / ${dh} + 0.5;`)

      const sampleVar = `node_${sanitizedId}_sample`
      if (fitMode === 'contain') {
        // Clamp to image bounds — black outside
        lines.push(`vec4 ${sampleVar} = vec4(0.0);`)
        lines.push(`if (${fitUV}.x >= 0.0 && ${fitUV}.x <= 1.0 && ${fitUV}.y >= 0.0 && ${fitUV}.y <= 1.0) {`)
        lines.push(`  ${sampleVar} = texture(${samplerName}, ${fitUV});`)
        lines.push(`}`)
      } else {
        // Cover: always sample (texture wraps/clamps at edges)
        lines.push(`vec4 ${sampleVar} = texture(${samplerName}, clamp(${fitUV}, 0.0, 1.0));`)
      }
      lines.push(`vec4 ${outputs.color} = vec4(${sampleVar}.rgb, ${sampleVar}.a);`)
      lines.push(`float ${outputs.alpha} = ${sampleVar}.a;`)
    } else {
      // No image loaded — output mid-gray placeholder (opaque)
      lines.push(`vec4 ${outputs.color} = vec4(vec3(0.5), 1.0);`)
      lines.push(`float ${outputs.alpha} = 1.0;`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const samplerName = `u_${sanitizedId}_image`
    const hasImage = !!(ctx.params.imageData)
    const fitMode = (ctx.params.fitMode as string) || 'contain'

    // Register image sampler in IR context
    if (ctx.imageSamplers) {
      ctx.imageSamplers.add(samplerName)
    }

    const stmts: IRStmt[] = []

    if (hasImage) {
      // Fit mode UV adjustment + texture sampling. The sampling is structured IR: the
      // `textureSample` expression kind already lowers to `texture(s, uv)` on GLSL and
      // `textureSample(s_tex, s_samp, uv)` on WGSL, and `ternary` already lowers to
      // `select()` on WGSL — which is what the removed hand-written arms spelled out.
      const fitUV = `img_uv_${sanitizedId}`
      const ac = `img_ac_${sanitizedId}`
      const dh = `img_dh_${sanitizedId}`
      const dw = `img_dw_${sanitizedId}`
      const sampleVar = `node_${sanitizedId}_sample`
      const insideVar = `img_inside_${sanitizedId}`
      const coords = ctx.inputs.coords
      const aspect = ctx.inputs.imageAspect

      // px-based fit AFTER the isotropic auto_uv SRT (see glsl() for why this
      // keeps rotation aspect-true). Single-arg raw() is mechanically translated
      // to WGSL (wgsl-backend.ts) — same shape both backends, cannot drift.
      const dhLine = fitMode === 'contain'
        ? `float ${dh} = (${aspect} > ${ac}) ? (u_resolution.x / ${aspect}) : u_resolution.y;`
        : `float ${dh} = (${aspect} > ${ac}) ? u_resolution.y : (u_resolution.x / ${aspect});`
      stmts.push(raw(
        `float ${ac} = u_resolution.x / u_resolution.y;
  ${dhLine}
  float ${dw} = ${dh} * ${aspect};
  vec2 ${fitUV} = vec2(0.0);
  ${fitUV}.x = (${coords}.x - u_anchor.x) * (u_dpr * u_ref_size) / ${dw} + 0.5;
  ${fitUV}.y = -(${coords}.y - u_anchor.y) * (u_dpr * u_ref_size) / ${dh} + 0.5;`,
      ))

      if (fitMode === 'contain') {
        // Clamp to image bounds — black outside. Sample-then-select for BOTH
        // backends: WGSL forbids textureSample under non-uniform control flow, so
        // sample unconditionally; ternary lowers to (c?a:b) / select(b,a,c).
        const inBounds = (comp: 'x' | 'y') => binary('&&',
          binary('>=', variable(`${fitUV}.${comp}`), literal('float', 0.0), 'bool'),
          binary('<=', variable(`${fitUV}.${comp}`), literal('float', 1.0), 'bool'), 'bool')
        stmts.push(
          declare(sampleVar, 'vec4', textureSample(samplerName, clampUV(fitUV), 'vec4')),
          declare(insideVar, 'bool', binary('&&', inBounds('x'), inBounds('y'), 'bool')),
          assign(sampleVar, ternary(
            variable(insideVar),
            variable(sampleVar),
            construct('vec4', [literal('float', 0.0)]),
            'vec4',
          )),
        )
      } else {
        // Cover
        stmts.push(declare(sampleVar, 'vec4', textureSample(samplerName, clampUV(fitUV), 'vec4')))
      }

      stmts.push(
        raw(
          `vec4 ${ctx.outputs.color} = vec4(${sampleVar}.rgb, ${sampleVar}.a);`,
        ),
        raw(
          `float ${ctx.outputs.alpha} = ${sampleVar}.a;`,
        ),
      )
    } else {
      // No image loaded — mid-gray placeholder (opaque)
      stmts.push(
        declare(ctx.outputs.color, 'vec4', construct('vec4', [construct('vec3', [literal('float', 0.5)]), literal('float', 1.0)])),
        declare(ctx.outputs.alpha, 'float', literal('float', 1.0)),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: hasImage
        ? new Set(['u_resolution', 'u_anchor', 'u_dpr', 'u_ref_size'])
        : new Set(),
    }
  },
}
