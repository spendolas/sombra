/**
 * Float Constant node - Output a constant number value
 */

import type { NodeDefinition } from '../types'

export const floatConstantNode: NodeDefinition = {
  type: 'float_constant',
  label: 'Number',
  category: 'Input',
  description: 'Constant number value',
  hidePreview: true,

  inputs: [],

  outputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'float',
    },
  ],

  params: [
    {
      id: 'value',
      label: 'Value',
      type: 'float',
      default: 1.0,
      min: -10.0,
      max: 10.0,
      step: 0.01,
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.value} = ${inputs.value};`
  },
}
