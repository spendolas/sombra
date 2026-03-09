/**
 * Posterize — quantize color to a fixed number of levels.
 */

import type { NodeDefinition } from '../types'

export const posterizeNode: NodeDefinition = {
  type: 'posterize',
  label: 'Posterize',
  category: 'Color',
  description: 'Quantize color to N discrete levels',

  inputs: [
    { id: 'color', label: 'Color', type: 'vec3', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'vec3' },
  ],

  params: [
    {
      id: 'levels', label: 'Levels', type: 'float', default: 4,
      min: 2, max: 32, step: 1,
      connectable: true, updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec3 ${outputs.result} = floor(${inputs.color} * ${inputs.levels}) / (${inputs.levels} - 1.0);`
  },
}
