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
    { id: 'source', label: 'Source', type: 'vec3', textureInput: true, default: [0, 0, 0] },
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'vec3' },
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

    if (mode === 'inverse') {
      const lines = [
        `float pc_angle_${id} = (${inputs.coords}.y - 0.5) * 6.28318530718;`,
        `vec2 ${outputs.polar} = vec2(${inputs.centerX}, ${inputs.centerY}) + vec2(cos(pc_angle_${id}), sin(pc_angle_${id})) * ${inputs.coords}.x;`,
      ]
      const samplerName = ctx.textureSamplers?.source
      if (samplerName) {
        lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${outputs.polar}).rgb;`)
      } else {
        lines.push(`vec3 ${outputs.color} = ${inputs.source};`)
      }
      return lines.join('\n  ')
    }

    // forward: cartesian → polar
    const lines = [
      `vec2 pc_off_${id} = ${inputs.coords} - vec2(${inputs.centerX}, ${inputs.centerY});`,
      `float pc_r_${id} = length(pc_off_${id});`,
      `float pc_theta_${id} = atan(pc_off_${id}.y, pc_off_${id}.x) / 6.28318530718 + 0.5;`,
      `vec2 ${outputs.polar} = vec2(pc_r_${id}, pc_theta_${id});`,
    ]
    const samplerName = ctx.textureSamplers?.source
    if (samplerName) {
      lines.push(`vec3 ${outputs.color} = texture(${samplerName}, ${outputs.polar}).rgb;`)
    } else {
      lines.push(`vec3 ${outputs.color} = ${inputs.source};`)
    }
    return lines.join('\n  ')
  },

  ir: (ctx: IRContext): IRNodeOutput => {
    const mode = (ctx.params.mode as string) || 'forward'
    const id = ctx.nodeId.replace(/-/g, '_')
    const samplerName = ctx.textureSamplers?.source

    const stmts: IRStmt[] = []

    if (mode === 'inverse') {
      // Inverse: (r, theta) → (x, y)
      const angle = `pc_angle_${id}`
      stmts.push(
        declare(angle, 'float',
          binary('*',
            binary('-', swizzle(variable(ctx.inputs.coords), 'y', 'float'), literal('float', 0.5), 'float'),
            literal('float', 6.28318530718),
            'float',
          ),
        ),
      )
      stmts.push(
        declare(ctx.outputs.polar, 'vec2',
          binary('+',
            construct('vec2', [variable(ctx.inputs.centerX), variable(ctx.inputs.centerY)]),
            binary('*',
              construct('vec2', [
                call('cos', [variable(angle)], 'float'),
                call('sin', [variable(angle)], 'float'),
              ]),
              swizzle(variable(ctx.inputs.coords), 'x', 'float'),
              'vec2',
            ),
            'vec2',
          ),
        ),
      )
    } else {
      // Forward: cartesian → polar
      const off = `pc_off_${id}`
      const r = `pc_r_${id}`
      const theta = `pc_theta_${id}`
      stmts.push(
        declare(off, 'vec2',
          binary('-',
            variable(ctx.inputs.coords),
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
        declare(ctx.outputs.polar, 'vec2',
          construct('vec2', [variable(r), variable(theta)]),
        ),
      )
    }

    // Color output
    if (samplerName) {
      stmts.push(
        declare(ctx.outputs.color, 'vec3',
          swizzle(textureSample(samplerName, variable(ctx.outputs.polar)), 'rgb', 'vec3'),
        ),
      )
    } else {
      stmts.push(
        declare(ctx.outputs.color, 'vec3', variable(ctx.inputs.source)),
      )
    }

    return {
      statements: stmts,
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
