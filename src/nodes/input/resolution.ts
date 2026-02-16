/**
 * Resolution node - provides canvas resolution uniform
 */

import type { NodeDefinition } from '../types'

export const resolutionNode: NodeDefinition = {
  type: 'resolution',
  label: 'Resolution',
  category: 'Input',
  description: 'Canvas resolution (width, height)',

  inputs: [],

  outputs: [
    {
      id: 'resolution',
      label: 'Resolution',
      type: 'vec2',
    },
  ],

  glsl: (ctx) => {
    const { outputs, uniforms } = ctx
    uniforms.add('u_resolution')
    return `vec2 ${outputs.resolution} = u_resolution;`
  },
}
