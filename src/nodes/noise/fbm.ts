/**
 * FBM (Fractal Brownian Motion) - Multi-octave fractal accumulator
 * Accepts any noise function via fnref input port.
 * When unconnected, falls back to simplex noise (snoise3d_01).
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const fbmNode: NodeDefinition = {
  type: 'fbm',
  label: 'FBM',
  category: 'Noise',
  description: 'Multi-octave fractal noise with wirable noise function and fractal mode',

  inputs: [
    { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
    { id: 'phase', label: 'Phase', type: 'float', default: 0.0 },
    { id: 'noiseFn', label: 'Noise Fn', type: 'fnref', default: 'snoise3d_01' },
  ],

  outputs: [
    { id: 'value', label: 'Value', type: 'float' },
  ],

  params: [
    { id: 'scale', label: 'Scale', type: 'float', default: 5.0, min: 0.1, max: 20.0, step: 0.1, connectable: true },
    {
      id: 'fractalMode', label: 'Fractal Mode', type: 'enum', default: 'standard',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'turbulence', label: 'Turbulence' },
        { value: 'ridged', label: 'Ridged' },
      ],
    },
    { id: 'octaves', label: 'Octaves', type: 'float', default: 4, min: 1, max: 8, step: 1, connectable: true },
    { id: 'lacunarity', label: 'Lacunarity', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.1, connectable: true },
    { id: 'gain', label: 'Gain', type: 'float', default: 0.5, min: 0.1, max: 0.9, step: 0.05, connectable: true },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const fractalMode = (params.fractalMode as string) || 'standard'
    const noiseFn = inputs.noiseFn // function name from fnref

    // Register simplex fallback (idempotent — safe even when connected to another noise)
    registerSimplexFallback(ctx)

    // Unique FBM function per node instance
    const sanitizedId = ctx.nodeId.replace(/-/g, '_')
    const fbmKey = `fbm_${sanitizedId}`

    let loopBody: string
    if (fractalMode === 'turbulence') {
      loopBody = `      total += abs(${noiseFn}(p) * 2.0 - 1.0) * amp;`
    } else if (fractalMode === 'ridged') {
      loopBody = `      float n = 1.0 - abs(${noiseFn}(p) * 2.0 - 1.0);\n      total += n * n * amp;`
    } else {
      loopBody = `      total += ${noiseFn}(p) * amp;`
    }

    // octaves, lacunarity, and gain are function args (connectable params)
    // GLSL requires constant loop bounds — use max (8) with early break for runtime octaves
    addFunction(ctx, fbmKey, `float ${fbmKey}(vec3 p, float oct, float lac, float g) {
  float total = 0.0;
  float amp = 0.5;
  float maxAmp = 0.0;
  for (int i = 0; i < 8; i++) {
      if (float(i) >= oct) break;
${loopBody}
      maxAmp += amp;
      p *= lac;
      amp *= g;
  }
  return total / maxAmp;
}`)

    // inputs.scale, inputs.octaves, inputs.lacunarity, inputs.gain are GLSL expressions (connectable params)
    return `float ${outputs.value} = ${fbmKey}(vec3(${inputs.coords} * ${inputs.scale}, ${inputs.phase}), ${inputs.octaves}, ${inputs.lacunarity}, ${inputs.gain});`
  },
}

/**
 * Register simplex noise functions as fallback for unconnected fnref input.
 * All calls are idempotent via addFunction.
 */
function registerSimplexFallback(ctx: import('../types').GLSLContext) {
  addFunction(ctx, 'mod289_vec3', `vec3 mod289(vec3 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}`)
  addFunction(ctx, 'mod289_vec4', `vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0;
}`)
  addFunction(ctx, 'permute_vec4', `vec4 permute(vec4 x) {
  return mod289(((x*34.0)+1.0)*x);
}`)
  addFunction(ctx, 'taylorInvSqrt', `vec4 taylorInvSqrt(vec4 r) {
  return 1.79284291400159 - 0.85373472095314 * r;
}`)
  addFunction(ctx, 'snoise3d', `float snoise3d(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
  + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}`)
  addFunction(ctx, 'snoise3d_01', `float snoise3d_01(vec3 p) {
  return snoise3d(p) * 0.5 + 0.5;
}`)
}
