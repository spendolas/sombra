/**
 * Color Constant node - provides a constant RGB color
 */

import type { NodeDefinition } from '../types'

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
    },
  ],

  glsl: (ctx) => {
    const { outputs, params } = ctx
    const color = params.color as [number, number, number]
    return `vec3 ${outputs.color} = vec3(${color[0]}, ${color[1]}, ${color[2]});`
  },
}
