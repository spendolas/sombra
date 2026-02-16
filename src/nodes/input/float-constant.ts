/**
 * Float Constant node - Output a constant number value
 */

import type { NodeDefinition } from '../types'

export const floatConstantNode: NodeDefinition = {
  type: 'float_constant',
  label: 'Number',
  category: 'Input',
  description: 'Constant number value',

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
    },
  ],

  glsl: (ctx) => {
    const { outputs, params } = ctx
    const value = params.value !== undefined ? params.value : 1.0

    // Format as float literal
    const valueStr = typeof value === 'number'
      ? (Number.isInteger(value) ? `${value}.0` : `${value}`)
      : `${value}`

    return `float ${outputs.value} = ${valueStr};`
  },
}
