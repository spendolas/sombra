/**
 * Value Noise 3D - Hash-based noise with trilinear interpolation
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const valueNoiseNode: NodeDefinition = {
  type: 'value_noise',
  label: 'Value Noise',
  category: 'Noise',
  description: '3D hash-based noise with smooth trilinear interpolation',

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
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const scale = params.scale !== undefined ? params.scale : inputs.scale

    addFunction(ctx, 'hash3', `float hash3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`)

    addFunction(ctx, 'vnoise3d', `float vnoise3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
        mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
        mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}`)

    const scaleStr = typeof scale === 'number'
      ? (Number.isInteger(scale) ? `${scale}.0` : `${scale}`)
      : scale

    return `float ${outputs.value} = vnoise3d(vec3(${inputs.coords} * ${scaleStr}, ${inputs.z}));`
  },
}
