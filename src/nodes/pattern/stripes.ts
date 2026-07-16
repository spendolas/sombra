/**
 * Stripes — repeating band pattern with pixel-accurate width/gap, duty cycle, and A/B colors.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, swizzle } from '../../compiler/ir/types'

export const stripesNode: NodeDefinition = {
  type: 'stripes',
  label: 'Stripes',
  category: 'Pattern',
  description: 'Repeating bands — pixel width/gap, duty cycle, and A/B colors',
  spatial: { transforms: ['scale', 'rotate', 'translate'] } satisfies SpatialConfig,

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'color', label: 'Color', type: 'color' },
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
    { id: 'width', label: 'Width', type: 'float', default: 40, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'gap', label: 'Gap', type: 'float', default: 40, min: 0, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], connectable: true, updateMode: 'uniform' },
    { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_dpr')
    uniforms.add('u_ref_size')
    const id = ctx.nodeId.replace(/-/g, '_')
    const periodPx = `st_periodPx_${id}`
    const period = `st_period_${id}`
    const duty = `st_duty_${id}`
    const t = `st_t_${id}`
    const hw = `st_hw_${id}`
    const aa = `st_aa_${id}`
    const band = `st_band_${id}`
    return [
      `float ${periodPx} = max(${inputs.width} + ${inputs.gap}, 0.0001);`,
      `float ${period} = ${periodPx} / (u_dpr * u_ref_size);`,
      `float ${duty} = clamp(${inputs.width} / ${periodPx}, 0.0, 1.0);`,
      `float ${t} = fract(${inputs.coords}.x / ${period} + 0.5) - 0.5;`,
      `float ${hw} = ${duty} * 0.5;`,
      `float ${aa} = max(${inputs.softness} * 0.5, 0.0001);`,
      `float ${band} = smoothstep(${hw} + ${aa}, ${hw} - ${aa}, abs(${t}));`,
      `float ${outputs.value} = ${band};`,
      `vec4 ${outputs.color} = mix(${inputs.colorB}, ${inputs.colorA}, ${band});`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const periodPx = `st_periodPx_${id}`
    const period = `st_period_${id}`
    const duty = `st_duty_${id}`
    const t = `st_t_${id}`
    const hw = `st_hw_${id}`
    const aa = `st_aa_${id}`
    const band = `st_band_${id}`

    const width = variable(ctx.inputs.width)
    const gap = variable(ctx.inputs.gap)
    const softness = variable(ctx.inputs.softness)
    const coords = variable(ctx.inputs.coords)
    const colorA = variable(ctx.inputs.colorA)
    const colorB = variable(ctx.inputs.colorB)

    return {
      statements: [
        // float periodPx = max(width + gap, 0.0001)
        declare(periodPx, 'float',
          call('max', [
            binary('+', width, gap, 'float'),
            literal('float', 0.0001),
          ], 'float'),
        ),
        // float period = periodPx / (u_dpr * u_ref_size)
        declare(period, 'float',
          binary('/',
            variable(periodPx),
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'float',
          ),
        ),
        // float duty = clamp(width / periodPx, 0.0, 1.0)
        declare(duty, 'float',
          call('clamp', [
            binary('/', width, variable(periodPx), 'float'),
            literal('float', 0.0),
            literal('float', 1.0),
          ], 'float'),
        ),
        // float t = fract(coords.x / period + 0.5) - 0.5
        declare(t, 'float',
          binary('-',
            call('fract', [
              binary('+',
                binary('/', swizzle(coords, 'x', 'float'), variable(period), 'float'),
                literal('float', 0.5),
                'float',
              ),
            ], 'float'),
            literal('float', 0.5),
            'float',
          ),
        ),
        // float hw = duty * 0.5
        declare(hw, 'float', binary('*', variable(duty), literal('float', 0.5), 'float')),
        // float aa = max(softness * 0.5, 0.0001)
        declare(aa, 'float',
          call('max', [
            binary('*', softness, literal('float', 0.5), 'float'),
            literal('float', 0.0001),
          ], 'float'),
        ),
        // float band = smoothstep(hw + aa, hw - aa, abs(t))
        declare(band, 'float',
          call('smoothstep', [
            binary('+', variable(hw), variable(aa), 'float'),
            binary('-', variable(hw), variable(aa), 'float'),
            call('abs', [variable(t)], 'float'),
          ], 'float'),
        ),
        // float value = band
        declare(ctx.outputs.value, 'float', variable(band)),
        // vec4 color = mix(colorB, colorA, band)
        declare(ctx.outputs.color, 'vec4',
          call('mix', [colorB, colorA, variable(band)], 'vec4'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(['u_dpr', 'u_ref_size']),
    }
  },
}
