/**
 * Stripes — repeating band pattern with configurable angle and edge softness.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, swizzle } from '../../compiler/ir/types'

export const stripesNode: NodeDefinition = {
  type: 'stripes',
  label: 'Stripes',
  category: 'Pattern',
  description: 'Repeating bands — adjustable angle and softness',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const f = `st_f_${id}`
    const lo = `st_lo_${id}`
    const hi = `st_hi_${id}`
    return [
      `float ${f} = fract(${inputs.coords}.x);`,
      `float ${lo} = max(0.25 - ${inputs.softness} * 0.25, 0.001);`,
      `float ${hi} = min(0.25 + ${inputs.softness} * 0.25, 0.499);`,
      `float ${outputs.value} = smoothstep(${lo}, ${hi}, ${f}) - smoothstep(1.0 - ${hi}, 1.0 - ${lo}, ${f});`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const f = `st_f_${id}`
    const lo = `st_lo_${id}`
    const hi = `st_hi_${id}`
    const softness = variable(ctx.inputs.softness)
    return {
      statements: [
        // float f = fract(coords.x)
        declare(f, 'float',
          call('fract', [swizzle(variable(ctx.inputs.coords), 'x', 'float')], 'float'),
        ),
        // float lo = max(0.25 - softness * 0.25, 0.001)
        declare(lo, 'float',
          call('max', [
            binary('-', literal('float', 0.25), binary('*', softness, literal('float', 0.25), 'float'), 'float'),
            literal('float', 0.001),
          ], 'float'),
        ),
        // float hi = min(0.25 + softness * 0.25, 0.499)
        declare(hi, 'float',
          call('min', [
            binary('+', literal('float', 0.25), binary('*', softness, literal('float', 0.25), 'float'), 'float'),
            literal('float', 0.499),
          ], 'float'),
        ),
        // float value = smoothstep(lo, hi, f) - smoothstep(1.0 - hi, 1.0 - lo, f)
        declare(ctx.outputs.value, 'float',
          binary('-',
            call('smoothstep', [variable(lo), variable(hi), variable(f)], 'float'),
            call('smoothstep', [
              binary('-', literal('float', 1.0), variable(hi), 'float'),
              binary('-', literal('float', 1.0), variable(lo), 'float'),
              variable(f),
            ], 'float'),
            'float',
          ),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
