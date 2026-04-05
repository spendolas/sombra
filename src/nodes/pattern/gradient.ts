/**
 * Gradient — procedural gradient pattern with multiple modes.
 * Outputs float 0–1 (unclamped for radial/diamond to allow > 1 at corners).
 */

import type { NodeDefinition } from '../types'
import { variable, call, binary, literal, declare, swizzle } from '../../compiler/ir/types'

export const gradientNode: NodeDefinition = {
  type: 'gradient',
  label: 'Gradient',
  category: 'Pattern',
  description: 'Procedural gradient — linear, radial, angular, or diamond',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    {
      id: 'gradientType', label: 'Type', type: 'enum', default: 'linear',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'radial', label: 'Radial' },
        { value: 'angular', label: 'Angular' },
        { value: 'diamond', label: 'Diamond' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const gradType = (params.gradientType as string) || 'linear'

    switch (gradType) {
      case 'radial':
        return `float ${outputs.value} = clamp(length(${inputs.coords} - 0.5) * 2.0, 0.0, 1.0);`
      case 'angular':
        return `float ${outputs.value} = atan(${inputs.coords}.y - 0.5, ${inputs.coords}.x - 0.5) * (1.0 / 6.28318530718) + 0.5;`
      case 'diamond':
        return `float ${outputs.value} = clamp((abs(${inputs.coords}.x - 0.5) + abs(${inputs.coords}.y - 0.5)) * 2.0, 0.0, 1.0);`
      default: // linear
        return `float ${outputs.value} = ${inputs.coords}.x;`
    }
  },

  ir: (ctx) => {
    const gradType = (ctx.params.gradientType as string) || 'linear'
    const coords = variable(ctx.inputs.coords)

    switch (gradType) {
      case 'radial':
        // clamp(length(coords - 0.5) * 2.0, 0.0, 1.0)
        return {
          statements: [
            declare(ctx.outputs.value, 'float',
              call('clamp', [
                binary('*',
                  call('length', [
                    binary('-', coords, literal('vec2', [0.5, 0.5]), 'vec2'),
                  ], 'float'),
                  literal('float', 2.0),
                  'float',
                ),
                literal('float', 0.0),
                literal('float', 1.0),
              ], 'float'),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
      case 'angular':
        // atan(coords.y - 0.5, coords.x - 0.5) * (1.0 / 6.28318530718) + 0.5
        return {
          statements: [
            declare(ctx.outputs.value, 'float',
              binary('+',
                binary('*',
                  call('atan', [
                    binary('-', swizzle(coords, 'y', 'float'), literal('float', 0.5), 'float'),
                    binary('-', swizzle(coords, 'x', 'float'), literal('float', 0.5), 'float'),
                  ], 'float'),
                  literal('float', 1.0 / 6.28318530718),
                  'float',
                ),
                literal('float', 0.5),
                'float',
              ),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
      case 'diamond':
        // clamp((abs(coords.x - 0.5) + abs(coords.y - 0.5)) * 2.0, 0.0, 1.0)
        return {
          statements: [
            declare(ctx.outputs.value, 'float',
              call('clamp', [
                binary('*',
                  binary('+',
                    call('abs', [
                      binary('-', swizzle(coords, 'x', 'float'), literal('float', 0.5), 'float'),
                    ], 'float'),
                    call('abs', [
                      binary('-', swizzle(coords, 'y', 'float'), literal('float', 0.5), 'float'),
                    ], 'float'),
                    'float',
                  ),
                  literal('float', 2.0),
                  'float',
                ),
                literal('float', 0.0),
                literal('float', 1.0),
              ], 'float'),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
      default: // linear
        // coords.x
        return {
          statements: [
            declare(ctx.outputs.value, 'float',
              swizzle(coords, 'x', 'float'),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
    }
  },
}
