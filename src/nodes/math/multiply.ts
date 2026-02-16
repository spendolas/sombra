/**
 * Multiply node - multiplies two values
 */

import type { NodeDefinition } from '../types'

export const multiplyNode: NodeDefinition = {
  type: 'multiply',
  label: 'Multiply',
  category: 'Math',
  description: 'Multiply two values (component-wise for vectors)',

  inputs: [
    {
      id: 'a',
      label: 'A',
      type: 'vec3',
      default: [1.0, 1.0, 1.0],
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

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec3 ${outputs.result} = ${inputs.a} * ${inputs.b};`
  },
}
