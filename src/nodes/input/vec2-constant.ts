/**
 * Vec2 Constant node - Output a constant 2D vector value
 */

import type { NodeDefinition } from '../types'
import { variable, declare, construct } from '../../compiler/ir/types'

export const vec2ConstantNode: NodeDefinition = {
  type: 'vec2_constant',
  label: 'Vec2',
  category: 'Input',
  description: 'Constant 2D vector value',
  hidePreview: true,

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

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.value, 'vec2',
        construct('vec2', [variable(ctx.inputs.x), variable(ctx.inputs.y)]),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
