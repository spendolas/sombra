/**
 * Pixelate — Snap UV to pixel grid, sampling one color per cell block.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, declare, construct, binary, literal, call, textureSample, swizzle, raw } from '../../compiler/ir/types'

export const pixelateNode: NodeDefinition = {
  type: 'pixelate',
  label: 'Pixelate',
  category: 'Effect',
  description: 'Reduce image to chunky pixel blocks',
  textureFilter: 'nearest',

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'screen_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
    { id: 'uv', label: 'UV', type: 'vec2' },
  ],

  params: [
    {
      id: 'pixelSize',
      label: 'Pixel Size',
      type: 'float',
      default: 8,
      min: 2,
      max: 256,
      step: 1,
      connectable: true,
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_viewport')
    uniforms.add('u_resolution')
    uniforms.add('u_dpr')
    uniforms.add('u_ref_size')
    const id = ctx.nodeId.replace(/-/g, '_')

    const lines: string[] = []

    // Grid in actual pixel space — cells are pixelSize × pixelSize screen pixels
    lines.push(`vec2 pxl_cell_${id} = floor(gl_FragCoord.xy / vec2(${inputs.pixelSize}));`)
    lines.push(`vec2 pxl_px_${id} = (pxl_cell_${id} + 0.5) * vec2(${inputs.pixelSize});`)
    // Screen UV for FBO sampling
    lines.push(`vec2 pxl_screenUV_${id} = pxl_px_${id} / u_viewport;`)
    // Frozen-ref UV for downstream nodes
    lines.push(`vec2 ${outputs.uv} = (pxl_px_${id} - u_resolution * 0.5) / (u_dpr * u_ref_size) + 0.5;`)

    // Color output
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, pxl_screenUV_${id}).rgb;`)
    } else {
      lines.push(`float pxl_ck_${id} = mod(pxl_cell_${id}.x + pxl_cell_${id}.y, 2.0);`)
      lines.push(`vec3 ${outputs.color} = mix(vec3(0.15), vec3(0.3), pxl_ck_${id});`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const samplerName = ctx.textureSamplers?.source

    const standardUniforms = new Set<string>(['u_viewport'])

    const stmts: IRStmt[] = [
      // Grid in actual pixel space
      declare(`pxl_cell_${id}`, 'vec2',
        call('floor', [
          binary('/', variable('gl_FragCoord.xy'), construct('vec2', [variable(ctx.inputs.pixelSize)]), 'vec2'),
        ], 'vec2'),
      ),
      // Pixel center in screen space
      declare(`pxl_px_${id}`, 'vec2',
        binary('*',
          binary('+', variable(`pxl_cell_${id}`), literal('vec2', [0.5, 0.5]), 'vec2'),
          construct('vec2', [variable(ctx.inputs.pixelSize)]),
          'vec2',
        ),
      ),
      // Screen UV (0→1) for FBO texture sampling
      declare(`pxl_screenUV_${id}`, 'vec2',
        binary('/', variable(`pxl_px_${id}`), variable('u_viewport'), 'vec2'),
      ),
      // Frozen-ref UV for downstream nodes (same formula as auto_uv)
      declare(ctx.outputs.uv, 'vec2',
        binary('+',
          binary('/',
            binary('-', variable(`pxl_px_${id}`), binary('*', variable('u_resolution'), literal('float', 0.5), 'vec2'), 'vec2'),
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'vec2',
          ),
          literal('vec2', [0.5, 0.5]),
          'vec2',
        ),
      ),
    ]

    standardUniforms.add('u_resolution')
    standardUniforms.add('u_dpr')
    standardUniforms.add('u_ref_size')

    if (samplerName) {
      // Texture mode: sample from FBO at quantized screen UV (not frozen-ref UV)
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          swizzle(textureSample(samplerName, variable(`pxl_screenUV_${id}`)), 'rgb', 'vec3'),
        ),
      )
    } else {
      // No source: checkerboard fallback
      stmts.push(
        raw(`float pxl_ck_${id} = mod(pxl_cell_${id}.x + pxl_cell_${id}.y, 2.0);
  vec3 ${ctx.outputs.color} = mix(vec3(0.15), vec3(0.3), pxl_ck_${id});`),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms,
    }
  },
}
