/**
 * Grayscale — convert color to single float brightness value.
 * Modes: luminance (Rec. 709), average, lightness (HSL L).
 */

import type { NodeDefinition } from '../types'
import { variable, call, declare, binary, literal, swizzle, construct } from '../../compiler/ir/types'

export const grayscaleNode: NodeDefinition = {
  type: 'grayscale',
  label: 'Grayscale',
  category: 'Color',
  description: 'Convert color to grayscale float',

  inputs: [
    { id: 'color', label: 'Color', type: 'vec3', default: [0.5, 0.5, 0.5] },
  ],

  outputs: [
    { id: 'result', label: 'Result', type: 'float' },
  ],

  params: [
    {
      id: 'mode', label: 'Mode', type: 'enum', default: 'luminance',
      options: [
        { value: 'luminance', label: 'Luminance' },
        { value: 'average', label: 'Average' },
        { value: 'lightness', label: 'Lightness' },
      ],
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const mode = (params.mode as string) || 'luminance'

    switch (mode) {
      case 'average':
        return `float ${outputs.result} = (${inputs.color}.r + ${inputs.color}.g + ${inputs.color}.b) / 3.0;`
      case 'lightness':
        return `float ${outputs.result} = (max(max(${inputs.color}.r, ${inputs.color}.g), ${inputs.color}.b) + min(min(${inputs.color}.r, ${inputs.color}.g), ${inputs.color}.b)) * 0.5;`
      default: // luminance (Rec. 709)
        return `float ${outputs.result} = dot(${inputs.color}, vec3(0.2126, 0.7152, 0.0722));`
    }
  },

  ir: (ctx) => {
    const mode = (ctx.params.mode as string) || 'luminance'
    const color = variable(ctx.inputs.color)

    switch (mode) {
      case 'average':
        // (color.r + color.g + color.b) / 3.0
        return {
          statements: [
            declare(ctx.outputs.result, 'float',
              binary('/',
                binary('+',
                  binary('+',
                    swizzle(color, 'r', 'float'),
                    swizzle(color, 'g', 'float'),
                    'float',
                  ),
                  swizzle(color, 'b', 'float'),
                  'float',
                ),
                literal('float', 3.0),
                'float',
              ),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
      case 'lightness':
        // (max(max(r, g), b) + min(min(r, g), b)) * 0.5
        return {
          statements: [
            declare(ctx.outputs.result, 'float',
              binary('*',
                binary('+',
                  call('max', [
                    call('max', [swizzle(color, 'r', 'float'), swizzle(color, 'g', 'float')], 'float'),
                    swizzle(color, 'b', 'float'),
                  ], 'float'),
                  call('min', [
                    call('min', [swizzle(color, 'r', 'float'), swizzle(color, 'g', 'float')], 'float'),
                    swizzle(color, 'b', 'float'),
                  ], 'float'),
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
      default: // luminance (Rec. 709)
        // dot(color, vec3(0.2126, 0.7152, 0.0722))
        return {
          statements: [
            declare(ctx.outputs.result, 'float',
              call('dot', [
                color,
                construct('vec3', [
                  literal('float', 0.2126),
                  literal('float', 0.7152),
                  literal('float', 0.0722),
                ]),
              ], 'float'),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(),
        }
    }
  },
}
