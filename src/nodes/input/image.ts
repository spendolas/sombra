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
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'screen_uv' },
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

      // inputs.coords is already SRT-transformed (centered, scaled, rotated, translated)
      const fitUV = `img_uv_${sanitizedId}`
      lines.push(`float img_ratio_${sanitizedId} = ${inputs.imageAspect} / (u_resolution.x / u_resolution.y);`)
      lines.push(`vec2 ${fitUV} = ${inputs.coords};`)

      if (fitMode === 'contain') {
        // Contain: entire image visible, letterbox where needed
        lines.push(`if (img_ratio_${sanitizedId} > 1.0) {`)
        lines.push(`  ${fitUV}.y = (${inputs.coords}.y - 0.5) * img_ratio_${sanitizedId} + 0.5;`)
        lines.push(`} else {`)
        lines.push(`  ${fitUV}.x = (${inputs.coords}.x - 0.5) / img_ratio_${sanitizedId} + 0.5;`)
        lines.push(`}`)
      } else {
        // Cover: fill canvas, crop where needed
        lines.push(`if (img_ratio_${sanitizedId} > 1.0) {`)
        lines.push(`  ${fitUV}.x = (${inputs.coords}.x - 0.5) / img_ratio_${sanitizedId} + 0.5;`)
        lines.push(`} else {`)
        lines.push(`  ${fitUV}.y = (${inputs.coords}.y - 0.5) * img_ratio_${sanitizedId} + 0.5;`)
        lines.push(`}`)
      }

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
      const ratio = `img_ratio_${sanitizedId}`
      const sampleVar = `node_${sanitizedId}_sample`
      const insideVar = `img_inside_${sanitizedId}`
      const coords = ctx.inputs.coords
      const aspect = ctx.inputs.imageAspect

      stmts.push(
        raw(
          `float ${ratio} = ${aspect} / (u_resolution.x / u_resolution.y);`,
        ),
        raw(
          `vec2 ${fitUV} = ${coords};`,
        ),
      )

      if (fitMode === 'contain') {
        stmts.push(raw(
          `if (${ratio} > 1.0) {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  } else {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  }`,
        ))

        // Clamp to image bounds — black outside.
        //
        // Structured, and deliberately in the sample-then-select shape for BOTH backends
        // rather than GLSL's branch-then-sample. WGSL forbids `textureSample` under
        // non-uniform control flow, so it has to sample unconditionally; and in GLSL the
        // two forms are identical, because `clamp` is a no-op whenever the fragment is
        // inside and the select discards the sample whenever it is not.
        //
        // `ternary` lowers to `(c ? a : b)` on GLSL and `select(b, a, c)` on WGSL, which is
        // exactly what the old hand-written WGSL arm spelled out by hand.
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
        stmts.push(raw(
          `if (${ratio} > 1.0) {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  } else {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  }`,
        ))

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
      standardUniforms: hasImage ? new Set(['u_resolution']) : new Set(),
    }
  },
}
