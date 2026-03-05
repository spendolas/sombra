/**
 * Smoothstep node - Smooth Hermite interpolation
 * Remaps input through a smooth S-curve between Low and High thresholds.
 * Values below Low → 0, above High → 1.
 */

import type { NodeDefinition } from '../types'

export const smoothstepNode: NodeDefinition = {
  type: 'smoothstep',
  label: 'Smoothstep',
  category: 'Math',
  description: 'Soft clamp — smooth S-curve remap between Low and High thresholds',

  inputs: [
    { id: 'x', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Low', type: 'float', default: 0.0, min: -0.5, max: 1.5, step: 0.01, connectable: true },
    { id: 'max', label: 'High', type: 'float', default: 1.0, min: -0.5, max: 1.5, step: 0.01, connectable: true },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = smoothstep(${inputs.min}, ${inputs.max}, ${inputs.x});`
  },
}
