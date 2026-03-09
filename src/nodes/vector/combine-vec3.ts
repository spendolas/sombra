/**
 * Combine Vec3 — compose X, Y, Z floats into a vec3.
 */

import type { NodeDefinition } from '../types'

export const combineVec3Node: NodeDefinition = {
  type: 'combine_vec3',
  label: 'Combine Vec3',
  category: 'Vector',
  description: 'Compose X, Y, Z floats into a vec3',

  inputs: [
    { id: 'x', label: 'X', type: 'float', default: 0 },
    { id: 'y', label: 'Y', type: 'float', default: 0 },
    { id: 'z', label: 'Z', type: 'float', default: 0 },
  ],

  outputs: [
    { id: 'vector', label: 'Vector', type: 'vec3' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec3 ${outputs.vector} = vec3(${inputs.x}, ${inputs.y}, ${inputs.z});`
  },
}
