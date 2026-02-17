/**
 * FBM (Fractal Brownian Motion) - Multi-octave fractal accumulator
 * Embeds all 4 noise types internally because the fractal loop must
 * re-sample at different frequencies per octave.
 */

import type { NodeDefinition } from '../types'
import { addFunction } from '../types'

export const fbmNode: NodeDefinition = {
  type: 'fbm',
  label: 'FBM',
  category: 'Noise',
  description: 'Multi-octave fractal noise with selectable noise type and fractal mode',

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
    {
      id: 'noiseType', label: 'Noise Type', type: 'enum', default: 'simplex',
      options: [
        { value: 'value', label: 'Value' },
        { value: 'simplex', label: 'Simplex' },
        { value: 'worley', label: 'Worley' },
        { value: 'box', label: 'Box' },
      ],
    },
    {
      id: 'fractalMode', label: 'Fractal Mode', type: 'enum', default: 'standard',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'turbulence', label: 'Turbulence' },
        { value: 'ridged', label: 'Ridged' },
      ],
    },
    { id: 'octaves', label: 'Octaves', type: 'float', default: 4, min: 1, max: 8, step: 1 },
    { id: 'lacunarity', label: 'Lacunarity', type: 'float', default: 2.0, min: 1.0, max: 4.0, step: 0.1 },
    { id: 'gain', label: 'Gain', type: 'float', default: 0.5, min: 0.1, max: 0.9, step: 0.05 },
  ],

  glsl: (ctx) => {
    const { inputs, outputs, params } = ctx
    const scale = params.scale !== undefined ? params.scale : inputs.scale
    const noiseType = (params.noiseType as string) || 'simplex'
    const fractalMode = (params.fractalMode as string) || 'standard'
    const octaves = Math.floor(Number(params.octaves ?? 4))
    const lacunarity = params.lacunarity ?? 2.0
    const gain = params.gain ?? 0.5

    // Register all noise primitives (shared, deduplicated)
    registerNoiseFunctions(ctx)

    // Register the FBM function for this noise+mode combination
    const fbmKey = `fbm_${noiseType}_${fractalMode}_${octaves}`
    const noiseFn = NOISE_FN_MAP[noiseType] || 'vnoise3d'

    const lacStr = formatFloat(lacunarity)
    const gainStr = formatFloat(gain)

    let loopBody: string
    if (fractalMode === 'turbulence') {
      loopBody = `      total += abs(${noiseFn}(p) * 2.0 - 1.0) * amp;`
    } else if (fractalMode === 'ridged') {
      loopBody = `      float n = 1.0 - abs(${noiseFn}(p) * 2.0 - 1.0);\n      total += n * n * amp;`
    } else {
      loopBody = `      total += ${noiseFn}(p) * amp;`
    }

    addFunction(ctx, fbmKey, `float ${fbmKey}(vec3 p) {
  float total = 0.0;
  float amp = 0.5;
  float maxAmp = 0.0;
  for (int i = 0; i < ${octaves}; i++) {
${loopBody}
      maxAmp += amp;
      p *= ${lacStr};
      amp *= ${gainStr};
  }
  return total / maxAmp;
}`)

    const scaleStr = formatFloat(scale)

    return `float ${outputs.value} = ${fbmKey}(vec3(${inputs.coords} * ${scaleStr}, ${inputs.z}));`
  },
}

const NOISE_FN_MAP: Record<string, string> = {
  value: 'vnoise3d',
  simplex: 'snoise3d_01',
  worley: 'worley3d',
  box: 'boxnoise3d_default',
}

function formatFloat(v: unknown): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `${v}.0` : `${v}`
  }
  return String(v)
}

/**
 * Register all noise primitive functions needed by FBM.
 * Each is deduplicated via addFunction.
 */
function registerNoiseFunctions(ctx: import('../types').GLSLContext) {
  // Value noise
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

  // Simplex 3D (0-1 normalized wrapper)
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
  // 0-1 normalized wrapper for simplex (raw range is roughly -1..1)
  addFunction(ctx, 'snoise3d_01', `float snoise3d_01(vec3 p) {
  return snoise3d(p) * 0.5 + 0.5;
}`)

  // Worley
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

  // Box noise (default boxFreq = 1.0)
  addFunction(ctx, 'boxnoise3d_default', `float boxnoise3d_default(vec3 p) {
  vec3 q = floor(p);
  return hash3(q);
}`)
}
