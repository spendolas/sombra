/**
 * Image node — loads a user-uploaded image as a sampler2D texture.
 * Outputs: color (color/RGBA — sampled rgb + alpha combined), alpha (float — same alpha,
 * kept as a separate port for backward-compat with existing graphs wired to it).
 * The image is stored as base64 in params.imageData and bound as a uniform sampler2D.
 */

import type { NodeDefinition, GLSLContext, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { declare, construct, literal, raw } from '../../compiler/ir/types'

/** Compute the sampler uniform name for an image node. */
export function imageSamplerName(nodeId: string): string {
  return `u_${nodeId.replace(/-/g, '_')}_image`
}

const FIT_MODE_OPTIONS = [
  { value: 'contain', label: 'Fit' },
  { value: 'cover', label: 'Fill' },
]

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
      // Fit mode UV adjustment + texture sampling.
      // Explicit WGSL variants throughout: the mechanical translation would emit
      // `clamp(vec2, 0.0, 0.0)` (no scalar-splat overload in WGSL) and
      // `textureSample` inside non-uniform control flow (derivative_uniformity
      // error) — so WGSL samples unconditionally and masks with select().
      const fitUV = `img_uv_${sanitizedId}`
      const ratio = `img_ratio_${sanitizedId}`
      const sampleVar = `node_${sanitizedId}_sample`
      const insideVar = `img_inside_${sanitizedId}`
      const coords = ctx.inputs.coords
      const aspect = ctx.inputs.imageAspect

      stmts.push(
        raw(
          `float ${ratio} = ${aspect} / (u_resolution.x / u_resolution.y);`,
          `let ${ratio}: f32 = ${aspect} / (u_resolution.x / u_resolution.y);`,
        ),
        raw(
          `vec2 ${fitUV} = ${coords};`,
          `var ${fitUV}: vec2f = ${coords};`,
        ),
      )

      if (fitMode === 'contain') {
        stmts.push(raw(
          `if (${ratio} > 1.0) {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  } else {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  }`,
          `if (${ratio} > 1.0) {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  } else {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  }`,
        ))

        // Clamp to image bounds — black outside.
        // WGSL: sample unconditionally (uniform control flow), then mask.
        stmts.push(raw(
          `vec4 ${sampleVar} = vec4(0.0);
  if (${fitUV}.x >= 0.0 && ${fitUV}.x <= 1.0 && ${fitUV}.y >= 0.0 && ${fitUV}.y <= 1.0) {
    ${sampleVar} = texture(${samplerName}, ${fitUV});
  }`,
          `var ${sampleVar}: vec4f = textureSample(${samplerName}_tex, ${samplerName}_samp, clamp(${fitUV}, vec2f(0.0), vec2f(1.0)));
  let ${insideVar}: bool = ${fitUV}.x >= 0.0 && ${fitUV}.x <= 1.0 && ${fitUV}.y >= 0.0 && ${fitUV}.y <= 1.0;
  ${sampleVar} = select(vec4f(0.0), ${sampleVar}, ${insideVar});`,
        ))
      } else {
        // Cover
        stmts.push(raw(
          `if (${ratio} > 1.0) {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  } else {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  }`,
          `if (${ratio} > 1.0) {
    ${fitUV}.x = (${coords}.x - 0.5) / ${ratio} + 0.5;
  } else {
    ${fitUV}.y = (${coords}.y - 0.5) * ${ratio} + 0.5;
  }`,
        ))

        stmts.push(raw(
          `vec4 ${sampleVar} = texture(${samplerName}, clamp(${fitUV}, 0.0, 1.0));`,
          `let ${sampleVar}: vec4f = textureSample(${samplerName}_tex, ${samplerName}_samp, clamp(${fitUV}, vec2f(0.0), vec2f(1.0)));`,
        ))
      }

      stmts.push(
        raw(
          `vec4 ${ctx.outputs.color} = vec4(${sampleVar}.rgb, ${sampleVar}.a);`,
          `let ${ctx.outputs.color}: vec4f = vec4f(${sampleVar}.rgb, ${sampleVar}.a);`,
        ),
        raw(
          `float ${ctx.outputs.alpha} = ${sampleVar}.a;`,
          `let ${ctx.outputs.alpha}: f32 = ${sampleVar}.a;`,
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
