/**
 * Checkerboard — alternating grid pattern, Tile Mode (Cell Size ⟷ Density), softness AA, A/B colors.
 *
 * Soft-XOR construction: per-axis triangle waves (period = 2 cells) fed through a
 * smoothstep threshold at 0.5, combined via XOR. The triangle-wave input is phase-shifted
 * by +0.25 (i.e. evaluated at g*0.5 + 0.25 instead of g*0.5) so that at softness = 0 the
 * hard threshold lands exactly on integer cell boundaries — reproducing the original
 * `mod(floor(g).x + floor(g).y, 2.0)` checker bit-for-bit (no half-cell offset). Without
 * this shift the naive `g*0.5` form flips at half-integers instead of integers.
 */

import type { NodeDefinition, SpatialConfig } from '../types'
import { getSpatialParams } from '../types'
import { variable, call, binary, literal, declare, swizzle } from '../../compiler/ir/types'

export const checkerboardNode: NodeDefinition = {
  type: 'checkerboard',
  label: 'Checkerboard',
  category: 'Pattern',
  description: 'Alternating grid pattern — cell size/density tile modes, softness, and A/B colors',
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
    {
      id: 'tileMode', label: 'Tile Mode', type: 'enum', default: 'cellSize',
      options: [
        { value: 'cellSize', label: 'Cell Size' },
        { value: 'density', label: 'Density' },
      ],
      updateMode: 'recompile',
    },
    // Non-connectable so they render in declared order under Tile Mode (connectable
    // params render in a separate section above the regular ones). Still uniforms → live drag.
    { id: 'cellSize', label: 'Cell Size', type: 'float', default: 40, min: 1, max: 512, step: 1, updateMode: 'uniform', showWhen: { tileMode: 'cellSize' } },
    { id: 'density', label: 'Density', type: 'float', default: 8, min: 1, max: 128, step: 1, updateMode: 'uniform', showWhen: { tileMode: 'density' } },
    { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 0.5, step: 0.01, updateMode: 'uniform' },
    { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], updateMode: 'uniform' },
    { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], updateMode: 'uniform' },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, uniforms, params } = ctx
    uniforms.add('u_dpr')
    uniforms.add('u_ref_size')
    const tileMode = (params.tileMode as string) || 'cellSize'
    const id = ctx.nodeId.replace(/-/g, '_')
    const cell = `cb_cell_${id}`
    const g = `cb_g_${id}`
    const f = `cb_f_${id}`
    const e = `cb_e_${id}`
    const a = `cb_a_${id}`
    const b = `cb_b_${id}`

    const lines: string[] = []
    if (tileMode === 'density') {
      lines.push(`float ${cell} = 1.0 / ${inputs.density};`)
    } else {
      lines.push(`float ${cell} = ${inputs.cellSize} / (u_dpr * u_ref_size);`)
    }
    lines.push(`vec2 ${g} = ${inputs.coords} / ${cell};`)
    // Soft XOR of per-axis triangle waves, phase-shifted by +0.25 so softness=0
    // aligns exactly with the original floor(g)-parity checker (see header comment).
    lines.push(`vec2 ${f} = abs(fract(${g} * 0.5 + vec2(0.25, 0.25)) - vec2(0.5, 0.5)) * 2.0;`)
    lines.push(`float ${e} = ${inputs.softness} + 0.0001;`)
    lines.push(`float ${a} = smoothstep(0.5 - ${e}, 0.5 + ${e}, ${f}.x);`)
    lines.push(`float ${b} = smoothstep(0.5 - ${e}, 0.5 + ${e}, ${f}.y);`)
    lines.push(`float ${outputs.value} = ${a} * (1.0 - ${b}) + (1.0 - ${a}) * ${b};`)
    lines.push(`vec4 ${outputs.color} = mix(${inputs.colorB}, ${inputs.colorA}, ${outputs.value});`)
    return lines.join('\n  ')
  },

  ir: (ctx) => {
    const tileMode = (ctx.params.tileMode as string) || 'cellSize'
    const id = ctx.nodeId.replace(/-/g, '_')
    const cell = `cb_cell_${id}`
    const g = `cb_g_${id}`
    const f = `cb_f_${id}`
    const e = `cb_e_${id}`
    const a = `cb_a_${id}`
    const b = `cb_b_${id}`

    const coords = variable(ctx.inputs.coords)
    const softness = variable(ctx.inputs.softness)
    const colorA = variable(ctx.inputs.colorA)
    const colorB = variable(ctx.inputs.colorB)

    const cellDecl = tileMode === 'density'
      ? declare(cell, 'float',
          binary('/', literal('float', 1.0), variable(ctx.inputs.density), 'float'),
        )
      : declare(cell, 'float',
          binary('/',
            variable(ctx.inputs.cellSize),
            binary('*', variable('u_dpr'), variable('u_ref_size'), 'float'),
            'float',
          ),
        )

    return {
      statements: [
        cellDecl,
        // vec2 g = coords / cell
        declare(g, 'vec2', binary('/', coords, variable(cell), 'vec2')),
        // vec2 f = abs(fract(g * 0.5 + vec2(0.25, 0.25)) - vec2(0.5, 0.5)) * 2.0
        declare(f, 'vec2',
          binary('*',
            call('abs', [
              binary('-',
                call('fract', [
                  binary('+',
                    binary('*', variable(g), literal('float', 0.5), 'vec2'),
                    literal('vec2', [0.25, 0.25]),
                    'vec2',
                  ),
                ], 'vec2'),
                literal('vec2', [0.5, 0.5]),
                'vec2',
              ),
            ], 'vec2'),
            literal('float', 2.0),
            'vec2',
          ),
        ),
        // float e = softness + 0.0001
        declare(e, 'float', binary('+', softness, literal('float', 0.0001), 'float')),
        // float a = smoothstep(0.5 - e, 0.5 + e, f.x)
        declare(a, 'float',
          call('smoothstep', [
            binary('-', literal('float', 0.5), variable(e), 'float'),
            binary('+', literal('float', 0.5), variable(e), 'float'),
            swizzle(variable(f), 'x', 'float'),
          ], 'float'),
        ),
        // float b = smoothstep(0.5 - e, 0.5 + e, f.y)
        declare(b, 'float',
          call('smoothstep', [
            binary('-', literal('float', 0.5), variable(e), 'float'),
            binary('+', literal('float', 0.5), variable(e), 'float'),
            swizzle(variable(f), 'y', 'float'),
          ], 'float'),
        ),
        // float value = a * (1.0 - b) + (1.0 - a) * b
        declare(ctx.outputs.value, 'float',
          binary('+',
            binary('*', variable(a), binary('-', literal('float', 1.0), variable(b), 'float'), 'float'),
            binary('*', binary('-', literal('float', 1.0), variable(a), 'float'), variable(b), 'float'),
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
