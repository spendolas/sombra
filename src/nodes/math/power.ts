/**
 * Power — raise a value to an exponent (gamma curve).
 */

import type { NodeDefinition } from '../types'

export const powerNode: NodeDefinition = {
  type: 'power',
  label: 'Power',
  category: 'Math',
  description: 'Raise a value to an exponent',
  conditionalPreview: true,

  inputs: [
    { id: 'base', label: 'Base', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'exponent', label: 'Exponent', type: 'float', default: 2.0, min: 0.1, max: 10, step: 0.1, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = pow(${inputs.base}, ${inputs.exponent});`
  },
}
