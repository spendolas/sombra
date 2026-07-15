/**
 * Posterize — quantize color to a fixed number of levels.
 */

import type { NodeDefinition } from '../types'
import { variable, call, binary, literal, declare, construct, swizzle } from '../../compiler/ir/types'

export const posterizeNode: NodeDefinition = {
  type: 'posterize',
  label: 'Posterize',
  category: 'Color',
  description: 'Quantize color to N discrete levels',

  inputs: [
    { id: 'color', label: 'Color', type: 'color', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'color' },
  ],

  params: [
    {
      id: 'levels', label: 'Levels', type: 'float', default: 4,
      min: 2, max: 32, step: 1,
      connectable: true, updateMode: 'uniform',
    },
    {
      id: 'preserveAlpha', label: 'Preserve Alpha', type: 'bool', default: false,
      updateMode: 'recompile',
    },
  ],

  // Quantization applies to all four channels, including alpha (channel transform — see rgba-node-audit.md).
  // preserveAlpha=true quantizes rgb only, passing input alpha through untouched.
  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const preserveAlpha = params.preserveAlpha === true
    if (preserveAlpha) {
      return `vec4 ${outputs.result} = vec4(floor(${inputs.color}.rgb * ${inputs.levels}) / (${inputs.levels} - 1.0), ${inputs.color}.a);`
    }
    return `vec4 ${outputs.result} = floor(${inputs.color} * ${inputs.levels}) / (${inputs.levels} - 1.0);`
  },

  ir: (ctx) => {
    const preserveAlpha = ctx.params.preserveAlpha === true
    const color = variable(ctx.inputs.color)
    const levels = variable(ctx.inputs.levels)

    // floor(color * levels) / (levels - 1.0)
    const value = preserveAlpha
      ? construct('vec4', [
          binary('/',
            call('floor', [
              binary('*', swizzle(color, 'rgb', 'vec3'), levels, 'vec3'),
            ], 'vec3'),
            binary('-', levels, literal('float', 1.0), 'float'),
            'vec3',
          ),
          swizzle(color, 'a', 'float'),
        ])
      : binary('/',
          call('floor', [
            binary('*', color, levels, 'vec4'),
          ], 'vec4'),
          binary('-', levels, literal('float', 1.0), 'float'),
          'vec4',
        )

    return {
      statements: [declare(ctx.outputs.result, 'vec4', value)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
