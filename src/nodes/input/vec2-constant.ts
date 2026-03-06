/**
 * Vec2 Constant node - Output a constant 2D vector value
 */

import type { NodeDefinition } from '../types'

export const vec2ConstantNode: NodeDefinition = {
  type: 'vec2_constant',
  label: 'Vec2',
  category: 'Input',
  description: 'Constant 2D vector value',

  inputs: [],

  outputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'vec2',
    },
  ],

  params: [
    { id: 'x', label: 'X', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01, updateMode: 'uniform' },
    { id: 'y', label: 'Y', type: 'float', default: 0.0, min: -10.0, max: 10.0, step: 0.01, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec2 ${outputs.value} = vec2(${inputs.x}, ${inputs.y});`
  },
}
