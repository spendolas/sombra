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
    },
    {
      id: 'contrast',
      label: 'Contrast',
      type: 'float',
      default: 0.0,
      min: -1.0,
      max: 1.0,
      step: 0.01,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const brightness = params.brightness !== undefined ? params.brightness : 0.0
    const contrast = params.contrast !== undefined ? params.contrast : 0.0

    // Format as float literals
    const brightnessStr = typeof brightness === 'number'
      ? (Number.isInteger(brightness) ? `${brightness}.0` : `${brightness}`)
      : `${brightness}`
    const contrastStr = typeof contrast === 'number'
      ? (Number.isInteger(contrast) ? `${contrast}.0` : `${contrast}`)
      : `${contrast}`

    // Apply brightness and contrast
    // Brightness: add to RGB
    // Contrast: scale around midpoint (0.5)
    return `vec3 ${outputs.result} = (${inputs.color} - 0.5) * (1.0 + ${contrastStr}) + 0.5 + ${brightnessStr};`
  },
}
