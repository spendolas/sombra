/**
 * Invert — flip color channels: vec3(1.0) - color.
 */

import type { NodeDefinition } from '../types'
import { variable, binary, literal, declare, construct, swizzle } from '../../compiler/ir/types'

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

  params: [
    {
      id: 'preserveAlpha', label: 'Preserve Alpha', type: 'bool', default: false,
      updateMode: 'recompile',
    },
  ],

  // Alpha is inverted too, by design — this is a channel transform (see rgba-node-audit.md).
  // preserveAlpha=true switches to rgb-only inversion, passing input alpha through untouched.
  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const preserveAlpha = params.preserveAlpha === true
    if (preserveAlpha) {
      return `vec4 ${outputs.result} = vec4(vec3(1.0) - ${inputs.color}.rgb, ${inputs.color}.a);`
    }
    return `vec4 ${outputs.result} = vec4(1.0) - ${inputs.color};`
  },

  ir: (ctx) => {
    const preserveAlpha = ctx.params.preserveAlpha === true
    const color = variable(ctx.inputs.color)

    const value = preserveAlpha
      ? construct('vec4', [
          binary('-',
            construct('vec3', [literal('float', 1.0)]),
            swizzle(color, 'rgb', 'vec3'),
            'vec3',
          ),
          swizzle(color, 'a', 'float'),
        ])
      : binary('-',
          construct('vec4', [literal('float', 1.0)]),
          color,
          'vec4',
        )

    return {
      statements: [declare(ctx.outputs.result, 'vec4', value)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
