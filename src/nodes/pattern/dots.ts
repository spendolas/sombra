/**
 * Dots — regular grid of circles with adjustable radius and edge softness.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare } from '../../compiler/ir/types'

export const dotsNode: NodeDefinition = {
  type: 'dots',
  label: 'Dots',
  category: 'Pattern',
  description: 'Grid of circles — adjustable radius and softness',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    { id: 'radius', label: 'Radius', type: 'float', default: 0.3, min: 0.01, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.05, min: 0.0, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const sc = `dt_sc_${id}`
    const cell = `dt_cell_${id}`
    const d = `dt_d_${id}`
    return [
      `vec2 ${sc} = ${inputs.coords};`,
      `vec2 ${cell} = fract(${sc}) - 0.5;`,
      `float ${d} = length(${cell});`,
      `float ${outputs.value} = 1.0 - smoothstep(${inputs.radius} - ${inputs.softness}, ${inputs.radius} + ${inputs.softness}, ${d});`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const sc = `dt_sc_${id}`
    const cell = `dt_cell_${id}`
    const d = `dt_d_${id}`
    return {
      statements: [
        // vec2 sc = coords
        declare(sc, 'vec2', variable(ctx.inputs.coords)),
        // vec2 cell = fract(sc) - 0.5
        declare(cell, 'vec2',
          binary('-',
            call('fract', [variable(sc)], 'vec2'),
            literal('float', 0.5),
            'vec2',
          ),
        ),
        // float d = length(cell)
        declare(d, 'float',
          call('length', [variable(cell)], 'float'),
        ),
        // float value = 1.0 - smoothstep(radius - softness, radius + softness, d)
        declare(ctx.outputs.value, 'float',
          binary('-',
            literal('float', 1.0),
            call('smoothstep', [
              binary('-', variable(ctx.inputs.radius), variable(ctx.inputs.softness), 'float'),
              binary('+', variable(ctx.inputs.radius), variable(ctx.inputs.softness), 'float'),
              variable(d),
            ], 'float'),
            'float',
          ),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
