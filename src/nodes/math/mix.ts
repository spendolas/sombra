/**
 * Mix node - linear interpolation between two values
 */

import type { NodeDefinition } from '../types'

export const mixNode: NodeDefinition = {
  type: 'mix',
  label: 'Mix',
  category: 'Math',
  description: 'Linear interpolation (lerp) between two values',

  inputs: [
    {
      id: 'a',
      label: 'A',
      type: 'vec3',
      default: [0.0, 0.0, 0.0],
    },
    {
      id: 'b',
      label: 'B',
      type: 'vec3',
      default: [1.0, 1.0, 1.0],
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'vec3',
    },
  ],

  params: [
    {
      id: 'factor',
      label: 'Factor',
      type: 'float',
      default: 0.5,
      min: 0.0,
      max: 1.0,
      step: 0.01,
      connectable: true,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    // inputs.factor is always a GLSL expression (connectable param)
    return `vec3 ${outputs.result} = mix(${inputs.a}, ${inputs.b}, ${inputs.factor});`
  },
}
