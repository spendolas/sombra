/**
 * Ridged - Standalone remap: (1.0 - abs(n * 2.0 - 1.0))^2
 * Creates sharp ridge lines from any 0-1 input
 */

import type { NodeDefinition } from '../types'

export const ridgedNode: NodeDefinition = {
  type: 'ridged',
  label: 'Ridged',
  category: 'Noise',
  description: 'Inverted turbulence squared — sharp bright ridges on dark background',

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = pow(1.0 - abs(${inputs.value} * 2.0 - 1.0), 2.0);`
  },
}
