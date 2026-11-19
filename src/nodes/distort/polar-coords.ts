/**
 * Polar Coordinates — cartesian ↔ polar conversion.
 * Forward: (x, y) → (r, θ) where θ is normalized to [0, 1].
 * Inverse: (r, θ) → (x, y) where θ is expected in [0, 1].
 */

import type { NodeDefinition } from '../types'
import type { IRContext, IRNodeOutput, IRStmt } from '../../compiler/ir/types'
import { variable, declare, construct, binary, literal, call, textureSample, swizzle } from '../../compiler/ir/types'

export const polarCoordsNode: NodeDefinition = {
  type: 'polar_coords',
  label: 'Polar Coordinates',
  category: 'Distort',
  description: 'Convert between cartesian and polar coordinates',

  inputs: [
    { id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
    { id: 'polar', label: 'Polar', type: 'vec2' },
  ],

  params: [
    {
      id: 'mode', label: 'Mode', type: 'enum', default: 'forward',
      options: [
        { value: 'forward', label: 'Cart → Polar' },
        { value: 'inverse', label: 'Polar → Cart' },
      ],
      updateMode: 'recompile',
    },
    {
      id: 'centerX', label: 'Center X', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'centerY', label: 'Center Y', type: 'float', default: 0.5,
      min: 0, max: 1, step: 0.01,
      connectable: true, updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const mode = (params.mode as string) || 'forward'
    const id = ctx.nodeId.replace(/-/g, '_')

    // The exported `polar` is a coordinate, so it is derived from y-down coords. In texture
    // mode `coords` is the NATIVE screen UV (the sample base): the export then comes from
    // ctx.coordsYDown and the texture is still sampled at the native-derived `samplePolar`.
    const split = !!ctx.coordsYDown
    const polarLines = (c: string, out: string, tag: string): string[] => {
      if (mode === 'inverse') {
        return [
          `float pc_angle${tag}_${id} = (${c}.y - 0.5) * 6.28318530718;`,
          `vec2 ${out} = vec2(${inputs.centerX}, ${inputs.centerY}) + vec2(cos(pc_angle${tag}_${id}), sin(pc_angle${tag}_${id})) * ${c}.x;`,
        ]
      }
      // forward: cartesian → polar
      return [
        `vec2 pc_off${tag}_${id} = ${c} - vec2(${inputs.centerX}, ${inputs.centerY});`,
        `float pc_r${tag}_${id} = length(pc_off${tag}_${id});`,
        `float pc_theta${tag}_${id} = atan(pc_off${tag}_${id}.y, pc_off${tag}_${id}.x) / 6.28318530718 + 0.5;`,
        `vec2 ${out} = vec2(pc_r${tag}_${id}, pc_theta${tag}_${id});`,
      ]
    }
    const lines = polarLines(ctx.coordsYDown ?? inputs.coords, outputs.polar, '')
    const samplePolar = split ? `pc_samp_${id}` : outputs.polar
    if (split) lines.push(...polarLines(inputs.coords, samplePolar, '_s'))

    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      // Full RGBA sample — alpha rides with the pixel (see rgba-node-audit.md).
      lines.push(`vec4 ${outputs.color} = texture(${samplerName}, ${samplePolar});`)
    } else {
      lines.push(`vec4 ${outputs.color} = ${inputs.source};`)
    }
    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const mode = (ctx.params.mode as string) || 'forward'
    const id = ctx.nodeId.replace(/-/g, '_')
    const samplerName = ctx.textureSamplers?.source

    const stmts: IRStmt[] = []

    // The exported `polar` is a coordinate, so it is derived from y-down coords. In texture
    // mode `coords` is the NATIVE screen UV (the sample base): the export then comes from
    // ctx.coordsYDown and the texture is still sampled at the native-derived `samplePolar`.
    const polarStmts = (c: string, out: string, tag: string): IRStmt[] => {
      if (mode === 'inverse') {
        // Inverse: (r, theta) → (x, y)
        const angle = `pc_angle${tag}_${id}`
        return [
          declare(angle, 'float',
            binary('*',
              binary('-', swizzle(variable(c), 'y', 'float'), literal('float', 0.5), 'float'),
              literal('float', 6.28318530718),
              'float',
            ),
          ),
          declare(out, 'vec2',
            binary('+',
              construct('vec2', [variable(ctx.inputs.centerX), variable(ctx.inputs.centerY)]),
              binary('*',
                construct('vec2', [
                  call('cos', [variable(angle)], 'float'),
                  call('sin', [variable(angle)], 'float'),
                ]),
                swizzle(variable(c), 'x', 'float'),
                'vec2',
              ),
              'vec2',
            ),
          ),
        ]
      }
      // Forward: cartesian → polar
      const off = `pc_off${tag}_${id}`
      const r = `pc_r${tag}_${id}`
      const theta = `pc_theta${tag}_${id}`
      return [
        declare(off, 'vec2',
          binary('-',
            variable(c),
            construct('vec2', [variable(ctx.inputs.centerX), variable(ctx.inputs.centerY)]),
            'vec2',
          ),
        ),
        declare(r, 'float',
          call('length', [variable(off)], 'float'),
        ),
        declare(theta, 'float',
          binary('+',
            binary('/',
              call('atan', [
                swizzle(variable(off), 'y', 'float'),
                swizzle(variable(off), 'x', 'float'),
              ], 'float'),
              literal('float', 6.28318530718),
              'float',
            ),
            literal('float', 0.5),
            'float',
          ),
        ),
        declare(out, 'vec2',
          construct('vec2', [variable(r), variable(theta)]),
        ),
      ]
    }
    stmts.push(...polarStmts(ctx.coordsYDown ?? ctx.inputs.coords, ctx.outputs.polar, ''))
    const samplePolar = ctx.coordsYDown ? `pc_samp_${id}` : ctx.outputs.polar
    if (ctx.coordsYDown) stmts.push(...polarStmts(ctx.inputs.coords, samplePolar, '_s'))

    // Color output — full RGBA sample, alpha rides with the pixel (see rgba-node-audit.md).
    if (samplerName) {
      stmts.push(
        declare(ctx.outputs.color, 'vec4',
          textureSample(samplerName, variable(samplePolar)),
        ),
      )
    } else {
      stmts.push(
        declare(ctx.outputs.color, 'vec4', variable(ctx.inputs.source)),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
