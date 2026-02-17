/**
 * Box Noise - Quantized value noise with adjustable box frequency
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const boxNoiseNode: NodeDefinition = {
  type: 'box_noise',
  label: 'Box Noise',
  category: 'Noise',
  description: 'Quantized value noise producing blocky patterns',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: [0.0, 0.0] },
    { id: 'z', label: 'Z', type: 'float', default: 0.0 },
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0 },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0, min: 0.1, max: 20.0, step: 0.1 },
    { id: 'boxFreq', label: 'Box Freq', type: 'float', default: 1.0, min: 0.5, max: 8.0, step: 0.5 },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const scale = params.scale !== undefined ? params.scale : inputs.scale
    const boxFreq = params.boxFreq !== undefined ? params.boxFreq : 1.0

    addFunction(ctx, 'hash3', `float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`)

    addFunction(ctx, 'boxnoise3d', `float boxnoise3d(vec3 p, float boxFreq) {
  vec3 q = floor(p * boxFreq) / boxFreq;
  return hash3(q);
}`)

    const scaleStr = typeof scale === 'number'
      ? (Number.isInteger(scale) ? `${scale}.0` : `${scale}`)
      : scale
    const boxFreqStr = typeof boxFreq === 'number'
      ? (Number.isInteger(boxFreq) ? `${boxFreq}.0` : `${boxFreq}`)
      : boxFreq

    return `float ${outputs.value} = boxnoise3d(vec3(${inputs.coords} * ${scaleStr}, ${inputs.z}), ${boxFreqStr});`
  },
}
