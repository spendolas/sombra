/**
 * Brightness/Contrast node - Adjust brightness and contrast of a color
 */

import type { NodeDefinition } from '../types'

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
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    // inputs.brightness and inputs.contrast are always GLSL expressions (connectable params)
    return `vec3 ${outputs.result} = (${inputs.color} - 0.5) * (1.0 + ${inputs.contrast}) + 0.5 + ${inputs.brightness};`
  },
}
