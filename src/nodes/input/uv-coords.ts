/**
 * UV Coordinates node - provides fragment UV coordinates (0-1)
 */

import type { NodeDefinition } from '../types'

export const uvCoordsNode: NodeDefinition = {
  type: 'uv_coords',
  label: 'UV Coordinates',
  category: 'Input',
  description: 'Provides UV coordinates (0-1) for the current fragment',

  inputs: [],

  outputs: [
    {
      id: 'uv',
      label: 'UV',
      type: 'vec2',
    },
  ],

  glsl: (ctx) => {
    const { outputs, uniforms } = ctx
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    return `vec2 ${outputs.uv} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;`
  },
}
