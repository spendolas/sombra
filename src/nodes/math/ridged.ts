/**
 * Ridged - Standalone remap: (1.0 - abs(n * 2.0 - 1.0))^2
 * Creates sharp ridge lines from any 0-1 input
 */

import type { NodeDefinition } from '../types'
import { variable, literal, binary, call, declare } from '../../compiler/ir/types'

export const ridgedNode: NodeDefinition = {
  type: 'ridged',
  label: 'Ridged',
  category: 'Distort',
  description: 'Inverted turbulence squared — sharp bright ridges on dark background',

  inputs: [
    { id: 'value', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = pow(1.0 - abs(${inputs.value} * 2.0 - 1.0), 2.0);`
  },

  ir: (ctx) => {
    // abs(value * 2.0 - 1.0)
    const absExpr = call('abs', [
      binary('-',
        binary('*', variable(ctx.inputs.value), literal('float', 2.0), 'float'),
        literal('float', 1.0),
        'float',
      ),
    ], 'float')
    // pow(1.0 - abs(...), 2.0)
    const powExpr = call('pow', [
      binary('-', literal('float', 1.0), absExpr, 'float'),
      literal('float', 2.0),
    ], 'float')

    return {
      statements: [declare(ctx.outputs.result, 'float', powExpr)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
