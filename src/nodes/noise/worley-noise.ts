/**
 * Worley Noise - Cellular/Voronoi distance field
 * 3x3x3 neighbor search for closest cell center
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const worleyNoiseNode: NodeDefinition = {
  type: 'worley_noise',
  label: 'Worley Noise',
  category: 'Noise',
  description: 'Cellular noise producing organic cell patterns',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: [0.0, 0.0] },
    { id: 'z', label: 'Z', type: 'float', default: 0.0 },
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0 },
  ],

  outputs: [
    { id: 'value', label: 'Distance', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0, min: 0.1, max: 20.0, step: 0.1 },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const scale = params.scale !== undefined ? params.scale : inputs.scale

    // hash3to3: maps vec3 -> vec3 of pseudo-random values in [0,1]
    addFunction(ctx, 'hash3to3', `vec3 hash3to3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}`)

    addFunction(ctx, 'worley3d', `float worley3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float minDist = 1.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 neighbor = vec3(float(x), float(y), float(z));
    vec3 point = hash3to3(i + neighbor);
    vec3 diff = neighbor + point - f;
    float dist = dot(diff, diff);
    minDist = min(minDist, dist);
  }
  return sqrt(minDist);
}`)

    const scaleStr = typeof scale === 'number'
      ? (Number.isInteger(scale) ? `${scale}.0` : `${scale}`)
      : scale

    return `float ${outputs.value} = worley3d(vec3(${inputs.coords} * ${scaleStr}, ${inputs.z}));`
  },
}
