/**
 * Shared GLSL noise function registration — used by Noise, FBM, and Domain Warp.
 * Each function registers its GLSL code via addFunction (idempotent / deduped).
 */

import type { GLSLContext } from '../types'
import { addFunction } from '../types'
import { raw } from '../../compiler/ir/types'
import type { IRFunction } from '../../compiler/ir/types'

/** Map noise type enum values to their GLSL function names */
export const NOISE_FUNCTION_MAP: Record<string, string> = {
  simplex: 'snoise3d_01',
  value: 'vnoise3d',
  worley: 'worley3d',
  worley_fast: 'worley3d_fast',
  worley2d: 'worley2d',
  box: 'boxnoise3d',
}

/** Noise type dropdown options — shared by Noise, FBM, and Domain Warp */
export const NOISE_TYPE_OPTIONS = [
  { value: 'simplex', label: 'Simplex' },
  { value: 'value', label: 'Value' },
  { value: 'worley', label: 'Worley 3D' },
  { value: 'worley_fast', label: 'Worley Fast' },
  { value: 'worley2d', label: 'Worley 2D' },
  { value: 'box', label: 'Box' },
]

/** Resolve a noiseType string to its GLSL function name */
export function resolveNoiseFn(noiseType: string): string {
  return NOISE_FUNCTION_MAP[noiseType] || NOISE_FUNCTION_MAP.simplex
}

/** Register GLSL functions for a given noise type. Idempotent. */
export function registerNoiseType(ctx: GLSLContext, noiseType: string): void {
  switch (noiseType) {
    case 'simplex':
      registerSimplex(ctx)
      break
    case 'value':
      registerValueNoise(ctx)
      break
    case 'worley':
      registerWorley(ctx)
      break
    case 'worley_fast':
      registerWorleyFast(ctx)
      break
    case 'worley2d':
      registerWorley2d(ctx)
      break
    case 'box':
      registerBoxNoise(ctx)
      break
    default:
      registerSimplex(ctx)
  }
}

// --- Simplex ---
function registerSimplex(ctx: GLSLContext) {
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

// --- Value Noise ---
function registerValueNoise(ctx: GLSLContext) {
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

// --- Worley ---
function registerWorley(ctx: GLSLContext) {
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
}

// --- Worley Fast (8-cell) ---
function registerWorleyFast(ctx: GLSLContext) {
  addFunction(ctx, 'hash3to3', `vec3 hash3to3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}`)
  addFunction(ctx, 'worley3d_fast', `float worley3d_fast(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float minDist = 1.0;
  for (int z = 0; z <= 1; z++)
  for (int y = 0; y <= 1; y++)
  for (int x = 0; x <= 1; x++) {
    vec3 neighbor = vec3(float(x), float(y), float(z));
    vec3 point = hash3to3(i + neighbor);
    vec3 diff = neighbor + point - f;
    float dist = dot(diff, diff);
    minDist = min(minDist, dist);
  }
  return sqrt(minDist);
}`)
}

// --- Worley 2D ---
function registerWorley2d(ctx: GLSLContext) {
  addFunction(ctx, 'hash12', `float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}`)
  addFunction(ctx, 'worley2d', `float worley2d(vec3 p) {
  vec2 i = floor(p.xy);
  vec2 f = fract(p.xy);
  float minDist = 1.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 cell = i + offset;
      float h1 = hash12(cell + vec2(37.0, 17.0) + floor(p.z));
      float h2 = hash12(cell + vec2(11.0, 29.0) + floor(p.z));
      vec2 r = vec2(
        fract(sin(h1 * 43758.5453 + p.z) * 43758.5453),
        fract(sin(h2 * 24693.173 + p.z) * 43758.5453)
      );
      vec2 d = offset + r - f;
      float dist = dot(d, d);
      minDist = min(minDist, dist);
    }
  }
  return clamp(1.0 - sqrt(minDist), 0.0, 1.0);
}`)
}

// --- Box Noise ---
function registerBoxNoise(ctx: GLSLContext) {
  registerValueNoise(ctx)
  addFunction(ctx, 'boxnoise3d', `float boxnoise3d(vec3 p) {
  return vnoise3d(floor(p));
}`)
}

// ===========================================================================
// IR noise function builders — return IRFunction[] for a given noise type.
// Used by ir() on Noise, FBM, Domain Warp, and Reeded Glass.
// ===========================================================================

function irSimplexFunctions(): IRFunction[] {
  return [
    {
      key: 'mod289_vec3', name: 'mod289',
      params: [{ name: 'x', type: 'vec3' }], returnType: 'vec3',
      body: [raw('return x - floor(x * (1.0 / 289.0)) * 289.0;')],
    },
    {
      key: 'mod289_vec4', name: 'mod289',
      params: [{ name: 'x', type: 'vec4' }], returnType: 'vec4',
      body: [raw('return x - floor(x * (1.0 / 289.0)) * 289.0;')],
    },
    {
      key: 'permute_vec4', name: 'permute',
      params: [{ name: 'x', type: 'vec4' }], returnType: 'vec4',
      body: [raw('return mod289(((x*34.0)+1.0)*x);', 'return mod289_v4(((x*34.0)+1.0)*x);')],
    },
    {
      key: 'taylorInvSqrt', name: 'taylorInvSqrt',
      params: [{ name: 'r', type: 'vec4' }], returnType: 'vec4',
      body: [raw('return 1.79284291400159 - 0.85373472095314 * r;')],
    },
    {
      key: 'snoise3d', name: 'snoise3d',
      params: [{ name: 'v', type: 'vec3' }], returnType: 'float',
      body: [raw(
        // GLSL body
        `const vec2 C = vec2(1.0/6.0, 1.0/3.0);
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
return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));`,
        // Explicit WGSL override — fixes: const syntax, var declarations, mod289→mod289_v3
        `const C: vec2f = vec2f(1.0/6.0, 1.0/3.0);
const D: vec4f = vec4f(0.0, 0.5, 1.0, 2.0);
var i: vec3f = floor(v + dot(v, C.yyy));
var x0: vec3f = v - i + dot(i, C.xxx);
var g: vec3f = step(x0.yzx, x0.xyz);
var l: vec3f = 1.0 - g;
var i1: vec3f = min(g.xyz, l.zxy);
var i2: vec3f = max(g.xyz, l.zxy);
var x1: vec3f = x0 - i1 + C.xxx;
var x2: vec3f = x0 - i2 + C.yyy;
var x3: vec3f = x0 - D.yyy;
i = mod289_v3(i);
var p: vec4f = permute(permute(permute(
  i.z + vec4f(0.0, i1.z, i2.z, 1.0))
+ i.y + vec4f(0.0, i1.y, i2.y, 1.0))
+ i.x + vec4f(0.0, i1.x, i2.x, 1.0));
var n_: f32 = 0.142857142857;
var ns: vec3f = n_ * D.wyz - D.xzx;
var j: vec4f = p - 49.0 * floor(p * ns.z * ns.z);
var x_: vec4f = floor(j * ns.z);
var y_: vec4f = floor(j - 7.0 * x_);
var x: vec4f = x_ * ns.x + ns.yyyy;
var y: vec4f = y_ * ns.x + ns.yyyy;
var h: vec4f = 1.0 - abs(x) - abs(y);
var b0: vec4f = vec4f(x.xy, y.xy);
var b1: vec4f = vec4f(x.zw, y.zw);
var s0: vec4f = floor(b0) * 2.0 + 1.0;
var s1: vec4f = floor(b1) * 2.0 + 1.0;
var sh: vec4f = -step(h, vec4f(0.0));
var a0: vec4f = b0.xzyw + s0.xzyw * sh.xxyy;
var a1: vec4f = b1.xzyw + s1.xzyw * sh.zzww;
var p0: vec3f = vec3f(a0.xy, h.x);
var p1: vec3f = vec3f(a0.zw, h.y);
var p2: vec3f = vec3f(a1.xy, h.z);
var p3: vec3f = vec3f(a1.zw, h.w);
var norm: vec4f = taylorInvSqrt(vec4f(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
var m: vec4f = max(0.6 - vec4f(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), vec4f(0.0));
m = m * m;
return 42.0 * dot(m*m, vec4f(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));`,
      )],
    },
    {
      key: 'snoise3d_01', name: 'snoise3d_01',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw('return snoise3d(p) * 0.5 + 0.5;')],
    },
  ]
}

function irValueNoiseFunctions(): IRFunction[] {
  return [
    {
      key: 'hash3', name: 'hash3',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw(`p = fract(p * 0.1031);
p += dot(p, p.zyx + 31.32);
return fract((p.x + p.y) * p.z);`)],
    },
    {
      key: 'vnoise3d', name: 'vnoise3d',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw(`vec3 i = floor(p);
vec3 f = fract(p);
f = f * f * (3.0 - 2.0 * f);
return mix(
  mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
      mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
  mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
      mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y),
  f.z);`)],
    },
  ]
}

function irWorleyFunctions(): IRFunction[] {
  return [
    {
      key: 'hash3to3', name: 'hash3to3',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'vec3',
      body: [raw(`p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
         dot(p, vec3(269.5, 183.3, 246.1)),
         dot(p, vec3(113.5, 271.9, 124.6)));
return fract(sin(p) * 43758.5453123);`)],
    },
    {
      key: 'worley3d', name: 'worley3d',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw(`vec3 i = floor(p);
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
return sqrt(minDist);`)],
    },
  ]
}

function irWorleyFastFunctions(): IRFunction[] {
  return [
    // hash3to3 is shared with worley — dedup by key
    {
      key: 'hash3to3', name: 'hash3to3',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'vec3',
      body: [raw(`p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
         dot(p, vec3(269.5, 183.3, 246.1)),
         dot(p, vec3(113.5, 271.9, 124.6)));
return fract(sin(p) * 43758.5453123);`)],
    },
    {
      key: 'worley3d_fast', name: 'worley3d_fast',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw(`vec3 i = floor(p);
vec3 f = fract(p);
float minDist = 1.0;
for (int z = 0; z <= 1; z++)
for (int y = 0; y <= 1; y++)
for (int x = 0; x <= 1; x++) {
  vec3 neighbor = vec3(float(x), float(y), float(z));
  vec3 point = hash3to3(i + neighbor);
  vec3 diff = neighbor + point - f;
  float dist = dot(diff, diff);
  minDist = min(minDist, dist);
}
return sqrt(minDist);`)],
    },
  ]
}

function irWorley2dFunctions(): IRFunction[] {
  return [
    {
      key: 'hash12', name: 'hash12',
      params: [{ name: 'p', type: 'vec2' }], returnType: 'float',
      body: [raw('return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);')],
    },
    {
      key: 'worley2d', name: 'worley2d',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw(`vec2 i = floor(p.xy);
vec2 f = fract(p.xy);
float minDist = 1.0;
for (int y = -1; y <= 1; y++) {
  for (int x = -1; x <= 1; x++) {
    vec2 offset = vec2(float(x), float(y));
    vec2 cell = i + offset;
    float h1 = hash12(cell + vec2(37.0, 17.0) + floor(p.z));
    float h2 = hash12(cell + vec2(11.0, 29.0) + floor(p.z));
    vec2 r = vec2(
      fract(sin(h1 * 43758.5453 + p.z) * 43758.5453),
      fract(sin(h2 * 24693.173 + p.z) * 43758.5453)
    );
    vec2 d = offset + r - f;
    float dist = dot(d, d);
    minDist = min(minDist, dist);
  }
}
return clamp(1.0 - sqrt(minDist), 0.0, 1.0);`)],
    },
  ]
}

function irBoxNoiseFunctions(): IRFunction[] {
  return [
    ...irValueNoiseFunctions(),
    {
      key: 'boxnoise3d', name: 'boxnoise3d',
      params: [{ name: 'p', type: 'vec3' }], returnType: 'float',
      body: [raw('return vnoise3d(floor(p));')],
    },
  ]
}

/** Return IRFunction[] for a given noise type string. */
export function getIRNoiseFunctions(noiseType: string): IRFunction[] {
  switch (noiseType) {
    case 'simplex': return irSimplexFunctions()
    case 'value': return irValueNoiseFunctions()
    case 'worley': return irWorleyFunctions()
    case 'worley_fast': return irWorleyFastFunctions()
    case 'worley2d': return irWorley2dFunctions()
    case 'box': return irBoxNoiseFunctions()
    default: return irSimplexFunctions()
  }
}
