/**
 * Simplex Noise node - Generates smooth gradient noise
 * Based on Stefan Gustavson's implementation
 */

import type { NodeDefinition } from '../types'

export const simplexNoiseNode: NodeDefinition = {
  type: 'simplex_noise',
  label: 'Simplex Noise',
  category: 'Noise',
  description: 'Smooth gradient noise for organic patterns',

  inputs: [
    {
      id: 'coords',
      label: 'Coords',
      type: 'vec2',
      default: [0.0, 0.0],
    },
    {
      id: 'scale',
      label: 'Scale',
      type: 'float',
      default: 5.0,
    },
  ],

  outputs: [
    {
      id: 'value',
      label: 'Value',
      type: 'float',
    },
  ],

  params: [
    {
      id: 'scale',
      label: 'Scale',
      type: 'float',
      default: 5.0,
      min: 0.1,
      max: 20.0,
      step: 0.1,
    },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params, nodeId, functions } = ctx
    const scale = params.scale !== undefined ? params.scale : inputs.scale
    // Sanitize nodeId for GLSL (replace hyphens with underscores)
    const sanitizedNodeId = nodeId.replace(/-/g, '_')

    // Add helper functions to global scope (only once per node instance)
    functions.push(`
// Simplex noise helper functions for ${sanitizedNodeId}
vec3 mod289_${sanitizedNodeId}(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec2 mod289_${sanitizedNodeId}(vec2 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}

vec3 permute_${sanitizedNodeId}(vec3 x) {
  return mod289_${sanitizedNodeId}(((x*34.0)+1.0)*x);
}

float snoise_${sanitizedNodeId}(vec2 v) {
  const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                      0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                     -0.577350269189626,  // -1.0 + 2.0 * C.x
                      0.024390243902439); // 1.0 / 41.0
  vec2 i  = floor(v + dot(v, C.yy) );
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1;
  i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289_${sanitizedNodeId}(i);
  vec3 p = permute_${sanitizedNodeId}( permute_${sanitizedNodeId}( i.y + vec3(0.0, i1.y, 1.0 ))
    + i.x + vec3(0.0, i1.x, 1.0 ));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m ;
  m = m*m ;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`)

    // Format scale value - if it's a number from params, ensure it's a float literal
    const scaleStr = typeof scale === 'number'
      ? (Number.isInteger(scale) ? `${scale}.0` : `${scale}`)
      : scale

    // Return only the variable declaration that uses the functions
    return `float ${outputs.value} = snoise_${sanitizedNodeId}(${inputs.coords} * ${scaleStr}) * 0.5 + 0.5;`
  },
}
