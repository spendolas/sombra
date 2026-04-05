/**
 * Color Constant node - provides a constant RGB color
 */

import type { NodeDefinition } from '../types'
import { variable, declare } from '../../compiler/ir/types'

export const colorConstantNode: NodeDefinition = {
  type: 'color_constant',
  label: 'Color',
  category: 'Input',
  description: 'Constant RGB color value',

  inputs: [],

  outputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'vec3',
    },
  ],

  params: [
    {
      id: 'color',
      label: 'Color',
      type: 'color',
      default: [1.0, 0.0, 1.0], // Magenta default
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec3 ${outputs.color} = ${inputs.color};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.color, 'vec3', variable(ctx.inputs.color)),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
