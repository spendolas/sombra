/**
 * Resolution node - provides canvas resolution uniform
 */

import type { NodeDefinition } from '../types'
import { variable, declare } from '../../compiler/ir/types'

export const resolutionNode: NodeDefinition = {
  type: 'resolution',
  label: 'Resolution',
  category: 'Input',
  description: 'Canvas resolution (width, height)',
  hidePreview: true,

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

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.resolution, 'vec2', variable('u_resolution')),
    ],
    uniforms: [],
    standardUniforms: new Set(['u_resolution']),
  }),
}
