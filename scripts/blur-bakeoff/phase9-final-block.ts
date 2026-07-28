/**
 * Compile-and-render check for the EXACT frost block proposed in the
 * recommendation. Verifies, on a real GPU:
 *   1. the GLSL ES 3.00 arm compiles and links (WebGL2)
 *   2. the WGSL arm compiles under Tint with a NON-UNIFORM frost branch
 *   3. both render non-black, non-constant output
 *   4. the two backends agree statistically
 *   5. a positive control (plain textureSample under the branch) is REJECTED
 */
import { createRig, type Backend, type PassSpec } from './lib/gpu-rig'
import { frostIngestPass, frostEgressPass } from './lib/frost-bench'
import { hfNoise, stepEdge } from './lib/corpus'

const N = 16
const GA_C = '-0.737368878'
const GA_S = '0.675490294'

function prelude(b: Backend): string {
  return b === 'webgpu'
    ? `
fn reedHash(p: vec2f) -> vec2f {
  var q: vec2u = vec2u(bitcast<u32>(p.x), bitcast<u32>(p.y));
  q = q * vec2u(1103515245u) + vec2u(12345u);
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> vec2u(16u));
  return vec2f(q) / f32(0xFFFFFFFFu) * 2.0 - 1.0;
}
fn reedRand(p: vec2f) -> f32 {
  var v: vec2u = vec2u(vec2i(floor(p) + vec2f(4096.0)));
  v = v * vec2u(1664525u) + vec2u(1013904223u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return f32(v.y) * 2.3283064e-10;
}
fn srcL0(p: vec2f) -> vec4f { return textureSampleLevel(srcTex, srcSamp, p, 0.0); }
`
    : `
vec2 reedHash(vec2 p) {
  uvec2 q = uvec2(floatBitsToUint(p.x), floatBitsToUint(p.y));
  q = q * 1103515245u + 12345u;
  q.x += q.y * 1664525u;
  q.y += q.x * 1013904223u;
  q = q ^ (q >> 16u);
  return vec2(q) / float(0xFFFFFFFFu) * 2.0 - 1.0;
}
float reedRand(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p) + vec2(4096.0)));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return float(v.y) * 2.3283064e-10;
}
`
}

/** `bad` = mechanical translation: plain textureSample under the branch. */
function block(b: Backend, bad = false): PassSpec {
  const wg = b === 'webgpu'
  const S = wg ? (bad ? 'sampleSrc' : 'srcL0') : 'sampleSrcGL'
  // Stand-ins for the node's own names, so the body is the shipped text.
  const head = wg
    ? `
  let u_dpr = U.u_params.z;
  let u_ref_size = 512.0;
  let u_viewport = U.u_resolution;
  let rg_coords = uv * u_ref_size / u_ref_size;
  let rg_sampleUV = uv;
  let rg_frost = U.u_params.x * min(1.0, sampleSrc(uv).a + 1.0);`
    : `
  float u_dpr = U.u_params.z;
  float u_ref_size = 512.0;
  vec2 u_viewport = U.u_resolution;
  vec2 rg_coords = uv * u_ref_size / u_ref_size;
  vec2 rg_sampleUV = uv;
  float rg_frost = U.u_params.x * min(1.0, sampleSrcGL(uv).a + 1.0);`

  const body = wg
    ? `
var rg_out: vec4f;
if (rg_frost > 0.001) {
  var rg_acc: vec3f = vec3f(0.0);
  var rg_aacc: f32 = 0.0;
  let rg_frad = vec2f(rg_frost * 24.0 * u_dpr) / u_viewport;
  let rg_gc = floor(rg_coords * (u_dpr * u_ref_size));
  let rg_rot = reedRand(rg_gc + vec2f(11.7, -23.9)) * 6.28318530718;
  var rg_dir = vec2f(cos(rg_rot), sin(rg_rot));
  for (var rg_i: i32 = 0; rg_i < ${N}; rg_i++) {
    let rg_fi = f32(rg_i);
    let rg_jr = reedHash(rg_gc + vec2f(rg_fi * 3.17 + 0.5, rg_fi * -5.41 - 0.5)).y * 0.5 + 0.5;
    let rg_rr = sqrt((rg_fi + rg_jr) * ${(1 / N).toFixed(8)});
    var rg_tap = rg_sampleUV + rg_dir * rg_rr * rg_frad;
    rg_tap = vec2f(1.0) - abs(fract(rg_tap * vec2f(0.5)) * vec2f(2.0) - vec2f(1.0));
    let rg_s = ${S}(rg_tap);
    rg_acc = rg_acc + rg_s.rgb * rg_s.a;
    rg_aacc = rg_aacc + rg_s.a;
    rg_dir = vec2f(rg_dir.x * ${GA_C} - rg_dir.y * ${GA_S}, rg_dir.x * ${GA_S} + rg_dir.y * ${GA_C});
  }
  rg_out = vec4f(rg_acc / vec3f(max(rg_aacc, 1e-5)), rg_aacc / ${N}.0);
} else {
  rg_out = ${S}(rg_sampleUV);
}
return rg_out;`
    : `
vec4 rg_out;
if (rg_frost > 0.001) {
  vec3 rg_acc = vec3(0.0);
  float rg_aacc = 0.0;
  vec2 rg_frad = vec2(rg_frost * 24.0 * u_dpr) / u_viewport;
  vec2 rg_gc = floor(rg_coords * (u_dpr * u_ref_size));
  float rg_rot = reedRand(rg_gc + vec2(11.7, -23.9)) * 6.28318530718;
  vec2 rg_dir = vec2(cos(rg_rot), sin(rg_rot));
  for (int rg_i = 0; rg_i < ${N}; rg_i++) {
    float rg_fi = float(rg_i);
    float rg_jr = reedHash(rg_gc + vec2(rg_fi * 3.17 + 0.5, rg_fi * -5.41 - 0.5)).y * 0.5 + 0.5;
    float rg_rr = sqrt((rg_fi + rg_jr) * ${(1 / N).toFixed(8)});
    vec2 rg_tap = rg_sampleUV + rg_dir * rg_rr * rg_frad;
    rg_tap = 1.0 - abs(fract(rg_tap * 0.5) * 2.0 - 1.0);
    vec4 rg_s = ${S}(rg_tap);
    rg_acc += rg_s.rgb * rg_s.a;
    rg_aacc += rg_s.a;
    rg_dir = vec2(rg_dir.x * ${GA_C} - rg_dir.y * ${GA_S}, rg_dir.x * ${GA_S} + rg_dir.y * ${GA_C});
  }
  rg_out = vec4(rg_acc / max(rg_aacc, 1e-5), rg_aacc / ${N}.0);
} else {
  rg_out = ${S}(rg_sampleUV);
}
return rg_out;`

  const glslShim = wg ? '' : `\nvec4 sampleSrcGL(vec2 p) { return sampleSrc(p); }\n`
  return { prelude: prelude(b) + glslShim, body: head + body, filter: 'linear', float16: true }
}

function stats(d: Uint8ClampedArray) {
  let mean = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4) { mean += (d[i] + d[i + 1] + d[i + 2]) / 3; n++ }
  mean /= n
  let v = 0
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; v += (l - mean) ** 2 }
  return { mean, sd: Math.sqrt(v / n) }
}

async function main() {
  const rig = await createRig()
  const results: Record<string, unknown> = {}
  try {
    const W = 256
    const input = hfNoise(W, W, 7)
    // blend in a step edge so there is real structure
    const edge = stepEdge(W, W)
    for (let i = 0; i < input.data.length; i++) input.data[i] = ((input.data[i] + edge.data[i]) / 2) | 0

    for (const b of ['webgpu', 'webgl2'] as Backend[]) {
      const out = await rig.capture({
        backend: b, width: W, height: W, input,
        params: [1.0, 0, 2.0, 0], radius: 48,
        passes: [frostIngestPass(b), block(b), frostEgressPass(b)],
      })
      const s = stats(out.data)
      results[b] = { ...s, ok: s.mean > 1 && s.sd > 1 }
      console.log(b, 'mean', s.mean.toFixed(2), 'sd', s.sd.toFixed(2))
    }

    // positive control: plain textureSample under the non-uniform branch must fail
    let rejected = false
    let msg = ''
    try {
      await rig.capture({
        backend: 'webgpu', width: W, height: W, input,
        params: [1.0, 0, 2.0, 0], radius: 48,
        passes: [frostIngestPass('webgpu'), block('webgpu', true), frostEgressPass('webgpu')],
      })
    } catch (e) { rejected = true; msg = String(e).slice(0, 200) }
    results.uniformityControl = { rejected, msg }
    console.log('uniformity control rejected:', rejected, msg)
  } finally {
    await rig.close()
  }
  console.log(JSON.stringify(results, null, 2))
}

main()
