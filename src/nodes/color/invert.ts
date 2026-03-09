/**
 * Invert — flip color channels: vec3(1.0) - color.
 */

import type { NodeDefinition } from '../types'

export const invertNode: NodeDefinition = {
  type: 'invert',
  label: 'Invert',
  category: 'Color',
  description: 'Invert color channels',

  inputs: [
    { id: 'color', label: 'Color', type: 'vec3', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'vec3' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec3 ${outputs.result} = vec3(1.0) - ${inputs.color};`
  },
}
