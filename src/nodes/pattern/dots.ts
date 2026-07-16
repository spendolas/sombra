/**
 * Dots — regular grid of circles, pixel-accurate gap X/Y, shape-only aspect, and A/B colors.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, swizzle, construct } from '../../compiler/ir/types'

export const dotsNode: NodeDefinition = {
  type: 'dots',
  label: 'Dots',
  category: 'Pattern',
  description: 'Grid of circles — pixel gap X/Y, shape-only aspect, and A/B colors',
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
    { id: 'gapX', label: 'Gap X', type: 'float', default: 60, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'gapY', label: 'Gap Y', type: 'float', default: 60, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'radius', label: 'Radius', type: 'float', default: 20, min: 1, max: 256, step: 1, connectable: true, updateMode: 'uniform' },
    { id: 'aspect', label: 'Aspect', type: 'float', default: 1.0, min: 0.25, max: 4.0, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.05, min: 0.0, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
    { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], connectable: true, updateMode: 'uniform' },
    { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], connectable: true, updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms } = ctx
    uniforms.add('u_dpr')
    uniforms.add('u_ref_size')
    const id = ctx.nodeId.replace(/-/g, '_')
    const gapU = `dt_gapU_${id}`
    const rel = `dt_rel_${id}`
    const rpx = `dt_rpx_${id}`
    const d = `dt_d_${id}`
    return [
      `vec2 ${gapU} = vec2(${inputs.gapX}, ${inputs.gapY}) / (u_dpr * u_ref_size);`,
      `vec2 ${rel} = ${inputs.coords} - (floor(${inputs.coords} / ${gapU}) + vec2(0.5, 0.5)) * ${gapU};`,
      `float ${rpx} = ${inputs.radius} / (u_dpr * u_ref_size);`,
      `float ${d} = length(vec2(${rel}.x * ${inputs.aspect}, ${rel}.y));`,
      `float ${outputs.value} = 1.0 - smoothstep(${rpx} - ${inputs.softness} * ${rpx}, ${rpx} + ${inputs.softness} * ${rpx}, ${d});`,
      `vec4 ${outputs.color} = mix(${inputs.colorB}, ${inputs.colorA}, ${outputs.value});`,
    ].join('\n  ')
  },

  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const gapU = `dt_gapU_${id}`
    const rel = `dt_rel_${id}`
    const rpx = `dt_rpx_${id}`
    const d = `dt_d_${id}`

    const coords = variable(ctx.inputs.coords)
    const gapX = variable(ctx.inputs.gapX)
    const gapY = variable(ctx.inputs.gapY)
    const radius = variable(ctx.inputs.radius)
    const aspect = variable(ctx.inputs.aspect)
    const softness = variable(ctx.inputs.softness)
    const colorA = variable(ctx.inputs.colorA)
    const colorB = variable(ctx.inputs.colorB)

    return {
      statements: [
        // vec2 gap_u = vec2(gapX, gapY) / (u_dpr * u_ref_size)
        declare(gapU, 'vec2',
          binary('/',
            construct('vec2', [gapX, gapY]),
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'vec2',
          ),
        ),
        // vec2 rel = coords - (floor(coords / gap_u) + 0.5) * gap_u
        declare(rel, 'vec2',
          binary('-',
            coords,
            binary('*',
              binary('+',
                call('floor', [binary('/', coords, variable(gapU), 'vec2')], 'vec2'),
                literal('vec2', [0.5, 0.5]),
                'vec2',
              ),
              variable(gapU),
              'vec2',
            ),
            'vec2',
          ),
        ),
        // float rpx = radius(px) / (u_dpr * u_ref_size)  → dot radius in coord units
        declare(rpx, 'float',
          binary('/',
            radius,
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'float',
          ),
        ),
        // float d = length(vec2(rel.x * aspect, rel.y))
        declare(d, 'float',
          call('length', [
            construct('vec2', [
              binary('*', swizzle(variable(rel), 'x', 'float'), aspect, 'float'),
              swizzle(variable(rel), 'y', 'float'),
            ]),
          ], 'float'),
        ),
        // float value = 1.0 - smoothstep(rpx - softness * rpx, rpx + softness * rpx, d)
        declare(ctx.outputs.value, 'float',
          binary('-',
            literal('float', 1.0),
            call('smoothstep', [
              binary('-', variable(rpx), binary('*', softness, variable(rpx), 'float'), 'float'),
              binary('+', variable(rpx), binary('*', softness, variable(rpx), 'float'), 'float'),
              variable(d),
            ], 'float'),
            'float',
          ),
        ),
        // vec4 color = mix(colorB, colorA, value)
        declare(ctx.outputs.color, 'vec4',
          call('mix', [colorB, colorA, variable(ctx.outputs.value)], 'vec4'),
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(['u_dpr', 'u_ref_size']),
    }
  },
}
