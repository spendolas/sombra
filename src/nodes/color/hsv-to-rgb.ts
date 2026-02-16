/**
 * HSV to RGB node - Convert HSV color space to RGB
 * H = Hue (0-1), S = Saturation (0-1), V = Value/Brightness (0-1)
 */

import type { NodeDefinition } from '../types'

export const hsvToRgbNode: NodeDefinition = {
  type: 'hsv_to_rgb',
  label: 'HSV to RGB',
  category: 'Color',
  description: 'Convert HSV color space to RGB',

  inputs: [
    {
      id: 'h',
      label: 'Hue',
      type: 'float',
      default: 0.0,
    },
    {
      id: 's',
      label: 'Saturation',
      type: 'float',
      default: 1.0,
    },
    {
      id: 'v',
      label: 'Value',
      type: 'float',
      default: 1.0,
    },
  ],

  outputs: [
    {
      id: 'rgb',
      label: 'RGB',
      type: 'vec3',
    },
  ],

  params: [],

  glsl: (ctx) => {
    const { inputs, outputs, nodeId, functions } = ctx
    const sanitizedNodeId = nodeId.replace(/-/g, '_')

    // Add HSV to RGB conversion function
    functions.push(`
// HSV to RGB conversion for ${sanitizedNodeId}
vec3 hsv2rgb_${sanitizedNodeId}(float h, float s, float v) {
  vec3 c = vec3(h, s, v);
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`)

    return `vec3 ${outputs.rgb} = hsv2rgb_${sanitizedNodeId}(${inputs.h}, ${inputs.s}, ${inputs.v});`
  },
}
