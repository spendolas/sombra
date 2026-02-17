/**
 * Domain Warp - Distorts coordinates using a wirable noise function.
 * When unconnected, falls back to value noise (vnoise3d).
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const domainWarpNode: NodeDefinition = {
  type: 'domain_warp',
  label: 'Domain Warp',
  category: 'Noise',
  description: 'Distorts UV coordinates using noise for organic warping effects',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: [0.0, 0.0] },
    { id: 'z', label: 'Z', type: 'float', default: 0.0 },
    { id: 'noiseFn', label: 'Noise Fn', type: 'fnref', default: 'vnoise3d' },
  ],

  outputs: [
    { id: 'warped', label: 'Warped', type: 'vec2' },
  ],

  params: [
    { id: 'strength', label: 'Strength', type: 'float', default: 0.3, min: 0.0, max: 2.0, step: 0.01, connectable: true },
    { id: 'frequency', label: 'Frequency', type: 'float', default: 4.0, min: 0.5, max: 20.0, step: 0.5, connectable: true },
  ],

  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    const noiseFn = inputs.noiseFn // function name from fnref

    // Register value noise fallback (idempotent — for when noiseFn input is unconnected)
    registerValueNoiseFallback(ctx)

    // inputs.strength and inputs.frequency are always GLSL expressions (connectable params)
    const prefix = outputs.warped
    return [
      `float ${prefix}_x = ${noiseFn}(vec3(${inputs.coords} * ${inputs.frequency}, ${inputs.z})) * 2.0 - 1.0;`,
      `float ${prefix}_y = ${noiseFn}(vec3(${inputs.coords} * ${inputs.frequency} + 100.0, ${inputs.z})) * 2.0 - 1.0;`,
      `vec2 ${outputs.warped} = ${inputs.coords} + vec2(${prefix}_x, ${prefix}_y) * ${inputs.strength};`,
    ].join('\n  ')
  },
}

/**
 * Register value noise functions as fallback for unconnected fnref input.
 */
function registerValueNoiseFallback(ctx: import('../types').GLSLContext) {
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
}
