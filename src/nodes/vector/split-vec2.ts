/**
 * Split Vec2 — decompose a vec2 into its X, Y float components.
 */

import type { NodeDefinition } from '../types'
import { variable, swizzle, declare } from '../../compiler/ir/types'

export const splitVec2Node: NodeDefinition = {
  type: 'split_vec2',
  label: 'Split Vec2',
  category: 'Vector',
  description: 'Decompose vec2 into X, Y float components',
  hidePreview: true,

  inputs: [
    { id: 'vector', label: 'Vector', type: 'vec2', default: [0, 0] },
  ],

  outputs: [
    { id: 'x', label: 'X', type: 'float' },
    { id: 'y', label: 'Y', type: 'float' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return [
      `float ${outputs.x} = ${inputs.vector}.x;`,
      `float ${outputs.y} = ${inputs.vector}.y;`,
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
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
