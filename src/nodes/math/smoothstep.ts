/**
 * Smoothstep node - Smooth Hermite interpolation
 * Returns smooth transition from 0 to 1 when input goes from edge0 to edge1
 */

import type { NodeDefinition } from '../types'

export const smoothstepNode: NodeDefinition = {
  type: 'smoothstep',
  label: 'Smoothstep',
  category: 'Math',
  description: 'Smooth Hermite interpolation between two edges',

  inputs: [
    {
      id: 'edge0',
      label: 'Edge 0',
      type: 'float',
      default: 0.0,
    },
    {
      id: 'edge1',
      label: 'Edge 1',
      type: 'float',
      default: 1.0,
    },
    {
      id: 'x',
      label: 'X',
      type: 'float',
      default: 0.5,
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'float',
    },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = smoothstep(${inputs.edge0}, ${inputs.edge1}, ${inputs.x});`
  },
}
