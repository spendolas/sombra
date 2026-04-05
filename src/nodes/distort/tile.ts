/**
 * Tile — repeat UV coordinates with optional mirroring.
 * Outputs tiled coordinates in [0, 1] range per cell.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, declare, construct, binary, literal, call, textureSample, swizzle, raw } from '../../compiler/ir/types'

export const tileNode: NodeDefinition = {
  type: 'tile',
  label: 'Tile',
  category: 'Distort',
  description: 'Repeat coordinates with optional mirroring',

  inputs: [
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
    { id: 'uv', label: 'UV', type: 'vec2' },
  ],

  params: [
    {
      id: 'countX', label: 'Count X', type: 'float', default: 4,
      min: 1, max: 64, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'countY', label: 'Count Y', type: 'float', default: 4,
      min: 1, max: 64, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'mirror', label: 'Mirror', type: 'enum', default: 'none',
      options: [
        { value: 'none', label: 'None' },
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
        { value: 'xy', label: 'XY' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const mirror = (params.mirror as string) || 'none'
    const id = ctx.nodeId.replace(/-/g, '_')
    const mirrorX = mirror === 'x' || mirror === 'xy'
    const mirrorY = mirror === 'y' || mirror === 'xy'

    if (!mirrorX && !mirrorY) {
      const lines = [
        `vec2 ${outputs.uv} = fract(${inputs.coords} * vec2(${inputs.countX}, ${inputs.countY}));`,
      ]
      const samplerName = ctx.textureSamplers?.source
      if (samplerName) {
        lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${outputs.uv}).rgb;`)
      } else {
        lines.push(`vec3 ${outputs.color} = vec3(${outputs.uv}, 0.5);`)
      }
      return lines.join('\n  ')
    }

    const lines = [
      `vec2 tile_sc_${id} = ${inputs.coords} * vec2(${inputs.countX}, ${inputs.countY});`,
    ]

    if (mirrorX) {
      lines.push(`float tile_mx_${id} = mod(tile_sc_${id}.x, 2.0);`)
      lines.push(`float tile_tx_${id} = tile_mx_${id} < 1.0 ? tile_mx_${id} : 2.0 - tile_mx_${id};`)
    } else {
      lines.push(`float tile_tx_${id} = fract(tile_sc_${id}.x);`)
    }

    if (mirrorY) {
      lines.push(`float tile_my_${id} = mod(tile_sc_${id}.y, 2.0);`)
      lines.push(`float tile_ty_${id} = tile_my_${id} < 1.0 ? tile_my_${id} : 2.0 - tile_my_${id};`)
    } else {
      lines.push(`float tile_ty_${id} = fract(tile_sc_${id}.y);`)
    }

    lines.push(`vec2 ${outputs.uv} = vec2(tile_tx_${id}, tile_ty_${id});`)

    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${outputs.uv}).rgb;`)
    } else {
      lines.push(`vec3 ${outputs.color} = vec3(${outputs.uv}, 0.5);`)
    }

    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const mirror = (ctx.params.mirror as string) || 'none'
    const id = ctx.nodeId.replace(/-/g, '_')
    const mirrorX = mirror === 'x' || mirror === 'xy'
    const mirrorY = mirror === 'y' || mirror === 'xy'
    const samplerName = ctx.textureSamplers?.source

    const stmts: IRStmt[] = []

    if (!mirrorX && !mirrorY) {
      // Simple fract tiling
      stmts.push(
        declare(ctx.outputs.uv, 'vec2',
          call('fract', [
            binary('*',
              variable(ctx.inputs.coords),
              construct('vec2', [variable(ctx.inputs.countX), variable(ctx.inputs.countY)]),
              'vec2',
            ),
          ], 'vec2'),
        ),
      )
    } else {
      // Mirror tiling: scale, then mirror per-axis
      const sc = `tile_sc_${id}`
      stmts.push(
        declare(sc, 'vec2',
          binary('*',
            variable(ctx.inputs.coords),
            construct('vec2', [variable(ctx.inputs.countX), variable(ctx.inputs.countY)]),
            'vec2',
          ),
        ),
      )

      if (mirrorX) {
        stmts.push(
          raw(`float tile_mx_${id} = mod(${sc}.x, 2.0);`),
          raw(`float tile_tx_${id} = tile_mx_${id} < 1.0 ? tile_mx_${id} : 2.0 - tile_mx_${id};`),
        )
      } else {
        stmts.push(
          raw(`float tile_tx_${id} = fract(${sc}.x);`),
        )
      }

      if (mirrorY) {
        stmts.push(
          raw(`float tile_my_${id} = mod(${sc}.y, 2.0);`),
          raw(`float tile_ty_${id} = tile_my_${id} < 1.0 ? tile_my_${id} : 2.0 - tile_my_${id};`),
        )
      } else {
        stmts.push(
          raw(`float tile_ty_${id} = fract(${sc}.y);`),
        )
      }

      stmts.push(
        declare(ctx.outputs.uv, 'vec2',
          construct('vec2', [variable(`tile_tx_${id}`), variable(`tile_ty_${id}`)]),
        ),
      )
    }

    // Color output
    if (samplerName) {
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          swizzle(textureSample(samplerName, variable(ctx.outputs.uv)), 'rgb', 'vec3'),
        ),
      )
    } else {
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          construct('vec3', [variable(ctx.outputs.uv), literal('float', 0.5)]),
        ),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
