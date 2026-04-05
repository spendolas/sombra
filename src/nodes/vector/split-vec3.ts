/**
 * Split Vec3 — decompose a vec3 into its X, Y, Z float components.
 */

import type { NodeDefinition } from '../types'
import { variable, swizzle, declare } from '../../compiler/ir/types'

export const splitVec3Node: NodeDefinition = {
  type: 'split_vec3',
  label: 'Split Vec3',
  category: 'Vector',
  description: 'Decompose vec3 into X, Y, Z float components',
  hidePreview: true,

  inputs: [
    { id: 'vector', label: 'Vector', type: 'vec3', default: [0, 0, 0] },
  ],

  outputs: [
    { id: 'x', label: 'X', type: 'float' },
    { id: 'y', label: 'Y', type: 'float' },
    { id: 'z', label: 'Z', type: 'float' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return [
      `float ${outputs.x} = ${inputs.vector}.x;`,
      `float ${outputs.y} = ${inputs.vector}.y;`,
      `float ${outputs.z} = ${inputs.vector}.z;`,
    ].join('\n  ')
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.x, 'float',
        swizzle(variable(ctx.inputs.vector), 'x', 'float'),
      ),
      declare(ctx.outputs.y, 'float',
        swizzle(variable(ctx.inputs.vector), 'y', 'float'),
      ),
      declare(ctx.outputs.z, 'float',
        swizzle(variable(ctx.inputs.vector), 'z', 'float'),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
