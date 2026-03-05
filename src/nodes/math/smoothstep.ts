/**
 * Smoothstep node - Smooth Hermite interpolation
 * Remaps input through a smooth S-curve between min and max.
 * Values below min → 0, above max → 1.
 */

import type { NodeDefinition } from '../types'

export const smoothstepNode: NodeDefinition = {
  type: 'smoothstep',
  label: 'Smoothstep',
  category: 'Distort',
  description: 'Remaps input through a smooth S-curve between min and max',

  inputs: [
    { id: 'x', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Min', type: 'float', default: 0.0, min: 0, max: 1, step: 0.01, connectable: true },
    { id: 'max', label: 'Max', type: 'float', default: 1.0, min: 0, max: 1, step: 0.01, connectable: true },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = smoothstep(${inputs.min}, ${inputs.max}, ${inputs.x});`
  },
}
