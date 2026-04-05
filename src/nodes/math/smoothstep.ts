/**
 * Smoothstep node - Smooth Hermite interpolation
 * Remaps input through a smooth S-curve between Low and High thresholds.
 * Values below Low → 0, above High → 1.
 */

import type { NodeDefinition } from '../types'
import { variable, call, declare } from '../../compiler/ir/types'

export const smoothstepNode: NodeDefinition = {
  type: 'smoothstep',
  label: 'Smoothstep',
  category: 'Math',
  description: 'Soft clamp — smooth S-curve remap between Low and High thresholds',
  conditionalPreview: true,

  inputs: [
    { id: 'x', label: 'Value', type: 'float', default: 0.5 },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    { id: 'min', label: 'Low', type: 'float', default: 0.0, min: -0.5, max: 1.5, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'max', label: 'High', type: 'float', default: 1.0, min: -0.5, max: 1.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `float ${outputs.result} = smoothstep(${inputs.min}, ${inputs.max}, ${inputs.x});`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.result, 'float',
        call('smoothstep', [
          variable(ctx.inputs.min),
          variable(ctx.inputs.max),
          variable(ctx.inputs.x),
        ], 'float'),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
