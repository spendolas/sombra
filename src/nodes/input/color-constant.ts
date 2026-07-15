/**
 * Color Constant node - provides a constant RGBA color
 */

import type { NodeDefinition } from '../types'
import { declare, variable } from '../../compiler/ir/types'

export const colorConstantNode: NodeDefinition = {
  type: 'color_constant',
  label: 'Color',
  category: 'Input',
  description: 'Constant RGBA color value',

  inputs: [],

  outputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'color',
    },
  ],

  params: [
    {
      id: 'color',
      label: 'Color',
      type: 'color',
      default: [1.0, 0.0, 1.0, 1.0], // Magenta default
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    // `color` param is an RGBA (vec4) uniform; output the full vec4 directly.
    return `vec4 ${outputs.color} = ${inputs.color};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.color, 'vec4', variable(ctx.inputs.color)),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
