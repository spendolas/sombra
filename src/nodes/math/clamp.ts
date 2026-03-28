/**
 * Clamp — restrict a value to a min/max range.
 */

import type { NodeDefinition } from '../types'

export const clampNode: NodeDefinition = {
  type: 'clamp',
  label: 'Clamp',
  category: 'Math',
  description: 'Restrict a value to a min/max range',
  conditionalPreview: true,

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Min', type: 'float', default: 0.0, min: -1, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'max', label: 'Max', type: 'float', default: 1.0, min: -1, max: 2, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = clamp(${inputs.value}, ${inputs.min}, ${inputs.max});`
  },
}
