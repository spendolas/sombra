/**
 * Brightness/Contrast node - Adjust brightness and contrast of a color
 */

import type { NodeDefinition } from '../types'
import { variable, binary, literal, declare } from '../../compiler/ir/types'

export const brightnessContrastNode: NodeDefinition = {
  type: 'brightness_contrast',
  label: 'Brightness/Contrast',
  category: 'Color',
  description: 'Adjust brightness and contrast of a color',

  inputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'vec3',
      default: [0.5, 0.5, 0.5],
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'vec3',
    },
  ],

  params: [
    {
      id: 'brightness',
      label: 'Brightness',
      type: 'float',
      default: 0.0,
      min: -1.0,
      max: 1.0,
      step: 0.01,
      connectable: true,
      updateMode: 'uniform',
    },
    {
      id: 'contrast',
      label: 'Contrast',
      type: 'float',
      default: 0.0,
      min: -1.0,
      max: 1.0,
      step: 0.01,
      connectable: true,
      updateMode: 'uniform',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    // inputs.brightness and inputs.contrast are always GLSL expressions (connectable params)
    return `vec3 ${outputs.result} = (${inputs.color} - 0.5) * (1.0 + ${inputs.contrast}) + 0.5 + ${inputs.brightness};`
  },

  ir: (ctx) => ({
    statements: [
      // (color - 0.5) * (1.0 + contrast) + 0.5 + brightness
      declare(ctx.outputs.result, 'vec3',
        binary('+',
          binary('+',
            binary('*',
              binary('-', variable(ctx.inputs.color), literal('float', 0.5), 'vec3'),
              binary('+', literal('float', 1.0), variable(ctx.inputs.contrast), 'float'),
              'vec3',
            ),
            literal('float', 0.5),
            'vec3',
          ),
          variable(ctx.inputs.brightness),
          'vec3',
        ),
      ),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
}
