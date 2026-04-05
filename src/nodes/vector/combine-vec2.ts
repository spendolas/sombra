/**
 * Combine Vec2 — compose X, Y floats into a vec2.
 */

import type { NodeDefinition } from '../types'
import { variable, construct, declare } from '../../compiler/ir/types'

export const combineVec2Node: NodeDefinition = {
  type: 'combine_vec2',
  label: 'Combine Vec2',
  category: 'Vector',
  description: 'Compose X, Y floats into a vec2',

  inputs: [
    { id: 'x', label: 'X', type: 'float', default: 0 },
    { id: 'y', label: 'Y', type: 'float', default: 0 },
  ],

  outputs: [
    { id: 'vector', label: 'Vector', type: 'vec2' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec2 ${outputs.vector} = vec2(${inputs.x}, ${inputs.y});`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.vector, 'vec2',
        construct('vec2', [variable(ctx.inputs.x), variable(ctx.inputs.y)]),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
