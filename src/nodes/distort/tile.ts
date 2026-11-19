/**
 * Tile — repeat UV coordinates with optional mirroring.
 * Outputs tiled coordinates in [0, 1] range per cell.
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, declare, construct, binary, literal, call, textureSample, raw } from '../../compiler/ir/types'

export const tileNode: NodeDefinition = {
  type: 'tile',
  label: 'Tile',
  category: 'Distort',
  description: 'Repeat coordinates with optional mirroring',

  inputs: [
    { id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
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

    // The exported `uv` is a coordinate, so it is tiled from y-down coords. In texture mode
    // `coords` is the NATIVE screen UV (the sample base): the export then comes from
    // ctx.coordsYDown and the texture is still sampled at the native-derived `sampleUv`.
    const tileLines = (c: string, out: string, tag: string): string[] => {
      if (!mirrorX && !mirrorY) {
        return [`vec2 ${out} = fract(${c} * vec2(${inputs.countX}, ${inputs.countY}));`]
      }
      const lines = [`vec2 tile_sc${tag}_${id} = ${c} * vec2(${inputs.countX}, ${inputs.countY});`]
      if (mirrorX) {
        lines.push(`float tile_mx${tag}_${id} = mod(tile_sc${tag}_${id}.x, 2.0);`)
        lines.push(`float tile_tx${tag}_${id} = tile_mx${tag}_${id} < 1.0 ? tile_mx${tag}_${id} : 2.0 - tile_mx${tag}_${id};`)
      } else {
        lines.push(`float tile_tx${tag}_${id} = fract(tile_sc${tag}_${id}.x);`)
      }
      if (mirrorY) {
        lines.push(`float tile_my${tag}_${id} = mod(tile_sc${tag}_${id}.y, 2.0);`)
        lines.push(`float tile_ty${tag}_${id} = tile_my${tag}_${id} < 1.0 ? tile_my${tag}_${id} : 2.0 - tile_my${tag}_${id};`)
      } else {
        lines.push(`float tile_ty${tag}_${id} = fract(tile_sc${tag}_${id}.y);`)
      }
      lines.push(`vec2 ${out} = vec2(tile_tx${tag}_${id}, tile_ty${tag}_${id});`)
      return lines
    }
    const lines = tileLines(ctx.coordsYDown ?? inputs.coords, outputs.uv, '')
    const sampleUv = ctx.coordsYDown ? `tile_samp_${id}` : outputs.uv
    if (ctx.coordsYDown) lines.push(...tileLines(inputs.coords, sampleUv, '_s'))

    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Full RGBA sample — alpha rides with the pixel (see rgba-node-audit.md).
      lines.push(`vec4 ${outputs.color} = texture(${samplerName}, ${sampleUv});`)
    } else {
      lines.push(`vec4 ${outputs.color} = vec4(${outputs.uv}, 0.5, 1.0);`)
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

    // Same split as glsl(): export from ctx.coordsYDown, sample from native `coords`.
    const tileStmts = (c: string, out: string, tag: string): IRStmt[] => {
      if (!mirrorX && !mirrorY) {
        // Simple fract tiling
        return [
          declare(out, 'vec2',
            call('fract', [
              binary('*',
                variable(c),
                construct('vec2', [variable(ctx.inputs.countX), variable(ctx.inputs.countY)]),
                'vec2',
              ),
            ], 'vec2'),
          ),
        ]
      }
      // Mirror tiling: scale, then mirror per-axis
      const sc = `tile_sc${tag}_${id}`
      const out2: IRStmt[] = [
        declare(sc, 'vec2',
          binary('*',
            variable(c),
            construct('vec2', [variable(ctx.inputs.countX), variable(ctx.inputs.countY)]),
            'vec2',
          ),
        ),
      ]
      if (mirrorX) {
        out2.push(
          raw(`float tile_mx${tag}_${id} = mod(${sc}.x, 2.0);`),
          raw(`float tile_tx${tag}_${id} = tile_mx${tag}_${id} < 1.0 ? tile_mx${tag}_${id} : 2.0 - tile_mx${tag}_${id};`),
        )
      } else {
        out2.push(raw(`float tile_tx${tag}_${id} = fract(${sc}.x);`))
      }
      if (mirrorY) {
        out2.push(
          raw(`float tile_my${tag}_${id} = mod(${sc}.y, 2.0);`),
          raw(`float tile_ty${tag}_${id} = tile_my${tag}_${id} < 1.0 ? tile_my${tag}_${id} : 2.0 - tile_my${tag}_${id};`),
        )
      } else {
        out2.push(raw(`float tile_ty${tag}_${id} = fract(${sc}.y);`))
      }
      out2.push(declare(out, 'vec2', construct('vec2', [variable(`tile_tx${tag}_${id}`), variable(`tile_ty${tag}_${id}`)])))
      return out2
    }
    stmts.push(...tileStmts(ctx.coordsYDown ?? ctx.inputs.coords, ctx.outputs.uv, ''))
    const sampleUv = ctx.coordsYDown ? `tile_samp_${id}` : ctx.outputs.uv
    if (ctx.coordsYDown) stmts.push(...tileStmts(ctx.inputs.coords, sampleUv, '_s'))

    // Color output — full RGBA sample, alpha rides with the pixel (see rgba-node-audit.md).
    if (samplerName) {
      stmts.push(
        declare(ctx.outputs.color, 'vec4',
          textureSample(samplerName, variable(sampleUv)),
        ),
      )
    } else {
      stmts.push(
        declare(ctx.outputs.color, 'vec4',
          construct('vec4', [variable(ctx.outputs.uv), literal('float', 0.5), literal('float', 1.0)]),
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
