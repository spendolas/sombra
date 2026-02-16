/**
 * Add node - adds two values
 */

import type { NodeDefinition } from '../types'

export const addNode: NodeDefinition = {
  type: 'add',
  label: 'Add',
  category: 'Math',
  description: 'Add two values (component-wise for vectors)',

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
      default: [0.0, 0.0, 0.0],
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
    return `vec3 ${outputs.result} = ${inputs.a} + ${inputs.b};`
  },
}
