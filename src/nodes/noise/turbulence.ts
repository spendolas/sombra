/**
 * Turbulence - Standalone remap: abs(n * 2.0 - 1.0)
 * Creates folded patterns from any 0-1 input
 */

import type { NodeDefinition } from '../types'

export const turbulenceNode: NodeDefinition = {
  type: 'turbulence',
  label: 'Turbulence',
  category: 'Noise',
  description: 'Folds a 0-1 signal around 0.5, creating sharp ridges at extremes',

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = abs(${inputs.value} * 2.0 - 1.0);`
  },
}
