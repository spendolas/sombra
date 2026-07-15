/**
 * Color Constant node - provides a constant RGB color
 */

import type { NodeDefinition } from '../types'
import { raw } from '../../compiler/ir/types'

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
    // `color` param is RGBA (vec4) uniform as of the RGBA type migration;
    // this node's output port is still vec3, so drop alpha here.
    return `vec3 ${outputs.color} = ${inputs.color}.rgb;`
  },

  ir: (ctx) => ({
    statements: [
      raw(
        `vec3 ${ctx.outputs.color} = ${ctx.inputs.color}.rgb;`,
        `let ${ctx.outputs.color}: vec3f = ${ctx.inputs.color}.rgb;`,
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
