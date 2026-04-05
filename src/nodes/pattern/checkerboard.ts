/**
 * Checkerboard — alternating black/white grid pattern.
 * Output is 0.0 or 1.0 (hard edges).
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, swizzle } from '../../compiler/ir/types'

export const checkerboardNode: NodeDefinition = {
  type: 'checkerboard',
  label: 'Checkerboard',
  category: 'Pattern',
  description: 'Alternating grid pattern — outputs 0 or 1',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const c = `cb_c_${id}`
    return [
      `vec2 ${c} = floor(${inputs.coords});`,
      `float ${outputs.value} = mod(${c}.x + ${c}.y, 2.0);`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const c = `cb_c_${id}`
    return {
      statements: [
        declare(c, 'vec2',
          call('floor', [variable(ctx.inputs.coords)], 'vec2'),
        ),
        declare(ctx.outputs.value, 'float',
          call('mod', [
            binary('+', swizzle(variable(c), 'x', 'float'), swizzle(variable(c), 'y', 'float'), 'float'),
            literal('float', 2.0),
          ], 'float'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
