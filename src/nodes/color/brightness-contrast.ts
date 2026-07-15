/**
 * Brightness/Contrast node - Adjust brightness and contrast of a color
 */

import type { NodeDefinition } from '../types'
import { variable, binary, literal, declare, construct, swizzle } from '../../compiler/ir/types'

export const brightnessContrastNode: NodeDefinition = {
  type: 'brightness_contrast',
  label: 'Brightness/Contrast',
  category: 'Color',
  description: 'Adjust brightness and contrast of a color',

  inputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'color',
      default: [0.5, 0.5, 0.5],
    },
  ],

  outputs: [
    {
      id: 'result',
      label: 'Result',
      type: 'color',
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
    {
      id: 'preserveAlpha', label: 'Preserve Alpha', type: 'bool', default: false,
      updateMode: 'recompile',
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const preserveAlpha = params.preserveAlpha === true
    // inputs.brightness and inputs.contrast are always GLSL expressions (connectable params)
    // Applies to all four channels, including alpha (channel transform — see rgba-node-audit.md).
    // preserveAlpha=true adjusts rgb only, passing input alpha through untouched.
    if (preserveAlpha) {
      return `vec4 ${outputs.result} = vec4((${inputs.color}.rgb - 0.5) * (1.0 + ${inputs.contrast}) + 0.5 + ${inputs.brightness}, ${inputs.color}.a);`
    }
    return `vec4 ${outputs.result} = (${inputs.color} - 0.5) * (1.0 + ${inputs.contrast}) + 0.5 + ${inputs.brightness};`
  },

  ir: (ctx) => {
    const preserveAlpha = ctx.params.preserveAlpha === true
    const color = variable(ctx.inputs.color)
    const contrast = variable(ctx.inputs.contrast)
    const brightness = variable(ctx.inputs.brightness)

    // (color - 0.5) * (1.0 + contrast) + 0.5 + brightness
    const value = preserveAlpha
      ? construct('vec4', [
          binary('+',
            binary('+',
              binary('*',
                binary('-', swizzle(color, 'rgb', 'vec3'), literal('float', 0.5), 'vec3'),
                binary('+', literal('float', 1.0), contrast, 'float'),
                'vec3',
              ),
              literal('float', 0.5),
              'vec3',
            ),
            brightness,
            'vec3',
          ),
          swizzle(color, 'a', 'float'),
        ])
      : binary('+',
          binary('+',
            binary('*',
              binary('-', color, literal('float', 0.5), 'vec4'),
              binary('+', literal('float', 1.0), contrast, 'float'),
              'vec4',
            ),
            literal('float', 0.5),
            'vec4',
          ),
          brightness,
          'vec4',
        )

    return {
      statements: [declare(ctx.outputs.result, 'vec4', value)],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
}
