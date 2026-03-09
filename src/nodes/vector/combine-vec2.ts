/**
 * Combine Vec2 — compose X, Y floats into a vec2.
 */

import type { NodeDefinition } from '../types'

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
}
