/**
 * Invert — flip color channels: vec3(1.0) - color.
 */

import type { NodeDefinition } from '../types'
import { variable, binary, literal, declare, construct } from '../../compiler/ir/types'

export const invertNode: NodeDefinition = {
  type: 'invert',
  label: 'Invert',
  category: 'Color',
  description: 'Invert color channels',

  inputs: [
    { id: 'color', label: 'Color', type: 'color', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'color' },
  ],

  // Alpha is inverted too, by design — this is a channel transform (see rgba-node-audit.md).
  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec4 ${outputs.result} = vec4(1.0) - ${inputs.color};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.result, 'vec4',
        binary('-',
          construct('vec4', [literal('float', 1.0)]),
          variable(ctx.inputs.color),
          'vec4',
        ),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
