/**
 * phase15 — is `reedPcg` bit-identical across backends?
 *
 * The frost0p3 cross-backend divergence bisects to the TAP POSITIONS, not the
 * accumulate arithmetic: parity scales monotonically with gather radius (1 code at
 * radius 0, 51 codes at 7.2 px), which is the signature of an angular error times a
 * lever arm. Taps are placed at `rot + i * goldenAngle` with
 * `rot = reedPcg(seed).x * 2pi`, so either the hash or the trig differs.
 *
 * This isolates the hash. It renders reedPcg over an integer grid on BOTH backends
 * with nothing else in the shader — no lens, no texture, no node — and compares the
 * bytes. Three controls run alongside so a null result cannot be mistaken for a
 * broken probe.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase15-hash-parity.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Backend, type PassSpec } from './lib/gpu-rig'
import type { Rgba8 } from './lib/image'

const OUT = path.join('reports', 'blur-bakeoff', 'phase15')
const W = 256
const H = 256

/** The node's reedPcg, verbatim apart from the alias-friendly signature. */
function pcgPrelude(b: Backend): string {
  return b === 'wgsl' || b === 'webgpu'
    ? `fn reedPcg(p: vec2f) -> vec2f {
  // vec2u / vec2i, not vec2<u32>: the RIG aliases \`vec2\` to vec2f, so the
  // templated spelling the node uses would become vec2f<u32> here. Harness
  // artifact only — the node's own WGSL has no such alias and is unchanged.
  var v: vec2u = vec2u(vec2i(floor(p))) * vec2u(1664525u) + vec2u(1013904223u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return vec2f(v) / 4294967296.0;
}`
    : `vec2 reedPcg(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p))) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return vec2(v) / 4294967296.0;
}`
}

/** Pack two [0,1) floats into RGBA8 at ~16 bits each, so a hash difference well
 *  below 1/255 still shows. Per-backend: the rig aliases the vector TYPES but
 *  function-declaration syntax still differs. */
function packPrelude(b: Backend): string {
  return b === 'webgpu'
    ? `fn _hi(v: float) -> float { return floor(v * 255.0) / 255.0; }
fn _lo(v: float) -> float { return fract(v * 255.0); }`
    : `float _hi(float v) { return floor(v * 255.0) / 255.0; }
float _lo(float v) { return fract(v * 255.0); }`
}

/** The rig aliases the vector TYPES across backends but not declaration syntax:
 *  WGSL wants `let x = ...`, GLSL wants `vec2 x = ...`. */
const dv = (b: Backend, t: string, name: string, expr: string): string =>
  b === 'webgpu' ? `  let ${name} = ${expr};` : `  ${t} ${name} = ${expr};`


/** The node's sRGB pair, so the encode's amplification near black is in scope. */
function srgbPrelude(b: Backend): string {
  return b === 'webgpu'
    ? `fn _toLin(c: float) -> float { return select(pow((c + 0.055) / 1.055, 2.4), c / 12.92, c < 0.04045); }
fn _toSrgb(c: float) -> float { let v = max(c, 0.0); return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, v * 12.92, v < 0.0031308); }`
    : `float _toLin(float c) { return c < 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float _toSrgb(float c) { float v = max(c, 0.0); return v < 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }`
}

/** A 16-tap premultiplied accumulate with NO texture anywhere — the exact shape of
 *  the frost gather's inner loop, fed synthetic values. `acc = acc + x * a` is a
 *  textbook fuse candidate, and ANGLE and Tint lower to different native ISA. */
function sum16(b: Backend, spread: string, encode: boolean): string {
  const L = (t: string, n: string, e: string) => dv(b, t, n, e)
  const loop = b === 'webgpu'
    ? `for (var i: i32 = 0; i < 16; i++) {`
    : `for (int i = 0; i < 16; i++) {`
  const f = b === 'webgpu' ? 'f32' : 'float'
  return [
    L('vec2', 'g', 'floor(uv * U.u_resolution)'),
    L('vec2', 'h', 'reedPcg(g)'),
    b === 'webgpu' ? '  var acc: float = 0.0;' : '  float acc = 0.0;',
    b === 'webgpu' ? '  var aacc: float = 0.0;' : '  float aacc = 0.0;',
    loop,
    `    ${b === 'webgpu' ? 'let' : 'float'} t = fract(h.x + ${f}(i) * 0.618034);`,
    `    ${b === 'webgpu' ? 'let' : 'float'} c = ${spread};`,
    `    ${b === 'webgpu' ? 'let' : 'float'} a = 0.5 + 0.5 * fract(h.y + ${f}(i) * 0.31);`,
    `    acc = acc + ${encode ? '_toLin(c)' : 'c'} * a;`,
    '    aacc = aacc + a;',
    '  }',
    L('float', 'outv', `${encode ? '_toSrgb(acc / max(aacc, 1e-5))' : 'acc / max(aacc, 1e-5)'}`),
    '  return vec4(_hi(outv), _lo(outv), _hi(outv), _lo(outv));',
  ].join('\n')
}

interface Probe {
  id: string
  what: string
  body: (b: Backend) => string
  prelude?: (b: Backend) => string
  /** Source texture. Every probe above is texture-FREE; the bilinear ones are not. */
  input?: () => Rgba8
  filter?: 'linear' | 'nearest'
}

/** 1px checkerboard — the highest texel-to-texel gradient available, so any
 *  difference in bilinear weighting shows at full amplitude. */
function checker(): Rgba8 {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const v = ((i % W) + Math.floor(i / W)) % 2 ? 255 : 0
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255
  }
  return { width: W, height: H, data: d }
}

/** Flat grey — the control. Bilinear on a constant field is constant, so ANY
 *  difference here means the probe itself is unsound. */
function flat(): Rgba8 {
  const d = new Uint8ClampedArray(W * H * 4).fill(255)
  for (let i = 0; i < W * H; i++) { d[i * 4] = 128; d[i * 4 + 1] = 128; d[i * 4 + 2] = 128 }
  return { width: W, height: H, data: d }
}

/** The frost gather's tap loop, sampling a REAL texture at a Vogel disc. */
function gather(b: Backend, radiusPx: string): string {
  const f = b === 'webgpu' ? 'f32' : 'float'
  const kw = b === 'webgpu' ? 'let' : 'float'
  return [
    dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution)'),
    dv(b, 'vec2', 'h', 'reedPcg(g)'),
    dv(b, 'float', 'rot', 'h.x * 6.28318530718'),
    b === 'webgpu' ? '  var acc: vec3 = vec3(0.0);' : '  vec3 acc = vec3(0.0);',
    b === 'webgpu' ? 'for (var i: i32 = 0; i < 16; i++) {' : 'for (int i = 0; i < 16; i++) {',
    `    ${kw} a = rot + ${f}(i) * 2.39996323;`,
    `    ${kw} r = ${radiusPx} * sqrt((${f}(i) + 0.5) / 16.0);`,
    '    acc = acc + sampleSrc(uv + vec2(cos(a), sin(a)) * r / U.u_resolution).rgb;',
    '  }',
    dv(b, 'vec3', 'o', 'acc / 16.0'),
    '  return vec4(_hi(o.x), _lo(o.x), _hi(o.y), _lo(o.y));',
  ].join('\n')
}

const PROBES: Probe[] = [
  {
    id: 'pcg-positive',
    what: 'reedPcg over a POSITIVE integer grid',
    prelude: pcgPrelude,
    body: (b) => [
      dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution)'),
      dv(b, 'vec2', 'h', 'reedPcg(g)'),
      '  return vec4(_hi(h.x), _lo(h.x), _hi(h.y), _lo(h.y));',
    ].join('\n'),
  },
  {
    id: 'pcg-negative',
    what: 'reedPcg over a grid shifted NEGATIVE (the node reaches about -128)',
    prelude: pcgPrelude,
    body: (b) => [
      dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution) - vec2(200.0)'),
      dv(b, 'vec2', 'h', 'reedPcg(g)'),
      '  return vec4(_hi(h.x), _lo(h.x), _hi(h.y), _lo(h.y));',
    ].join('\n'),
  },
  {
    id: 'rot-trig',
    what: 'cos/sin at rot + i*goldenAngle — the OTHER tap-placement suspect',
    prelude: pcgPrelude,
    body: (b) => [
      dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution)'),
      dv(b, 'float', 'rot', 'reedPcg(g).x * 6.28318530718'),
      dv(b, 'float', 'a', 'rot + 7.0 * 2.39996323'),
      dv(b, 'vec2', 'd', 'vec2(cos(a), sin(a)) * 0.5 + 0.5'),
      '  return vec4(_hi(d.x), _lo(d.x), _hi(d.y), _lo(d.y));',
    ].join('\n'),
  },
  {
    id: 'control-identity',
    what: 'CONTROL: plain fragcoord round-trip, must be identical',
    body: (b) => [
      dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution) / U.u_resolution'),
      '  return vec4(_hi(g.x), _lo(g.x), _hi(g.y), _lo(g.y));',
    ].join('\n'),
  },
  {
    id: 'control-pow',
    what: 'CONTROL: pow(x,2.4) — is transcendental precision backend-stable?',
    body: (b) => [
      dv(b, 'vec2', 'g', 'floor(uv * U.u_resolution) / U.u_resolution'),
      dv(b, 'float', 'v', 'pow(g.x, 2.4)'),
      dv(b, 'float', 'w', 'pow(g.y, 1.0 / 2.4)'),
      '  return vec4(_hi(v), _lo(v), _hi(w), _lo(w));',
    ].join('\n'),
  },
  {
    id: 'sum16-lowvar',
    what: 'ARITH: 16-tap premultiplied sum, near-equal summands (tiny-radius analogue)',
    prelude: (b) => pcgPrelude(b) + '\n' + srgbPrelude(b),
    body: (b) => sum16(b, '0.5 + 0.01 * t', false),
  },
  {
    id: 'sum16-highvar',
    what: 'ARITH: same sum, summands spanning 0..1 (wide-radius analogue)',
    prelude: (b) => pcgPrelude(b) + '\n' + srgbPrelude(b),
    body: (b) => sum16(b, 't', false),
  },
  {
    id: 'sum16-highvar-srgb',
    what: 'ARITH: wide-spread sum THROUGH linear light — does the encode amplify?',
    prelude: (b) => pcgPrelude(b) + '\n' + srgbPrelude(b),
    body: (b) => sum16(b, 't', true),
  },
  {
    id: 'bilin-1tap-checker',
    what: 'TEXTURE: one bilinear fetch at a fixed sub-texel offset, 1px checkerboard',
    prelude: pcgPrelude,
    input: checker,
    filter: 'linear',
    body: (b) => [
      dv(b, 'vec4', 't', 'sampleSrc(uv + vec2(0.37, 0.21) / U.u_resolution)'),
      '  return vec4(_hi(t.x), _lo(t.x), _hi(t.y), _lo(t.y));',
    ].join('\n'),
  },
  {
    id: 'bilin-16tap-checker',
    what: 'TEXTURE: the frost gather at radius 7.2px on a 1px checkerboard',
    prelude: pcgPrelude,
    input: checker,
    filter: 'linear',
    body: (b) => gather(b, '7.2'),
  },
  {
    id: 'bilin-16tap-flat',
    what: 'CONTROL: same gather on a FLAT field — must be identical',
    prelude: pcgPrelude,
    input: flat,
    filter: 'linear',
    body: (b) => gather(b, '7.2'),
  },
]

/**
 * Channels are packed hi,lo,hi,lo. The LOW byte is `fract(v*255)`, which WRAPS —
 * a 1-ULP difference straddling a 1/255 boundary flips it 254 -> 0 and reads as a
 * full-scale 255 difference. Reporting them together would turn float noise into
 * an alarming number, so they are split: `maxHi` is the real magnitude (in units
 * of 1/255 of the packed value), `maxLo` is sub-1/255 noise.
 */
function diff(a: Rgba8, b: Rgba8): {
  maxHi: number; maxLo: number; nHi: number; nAny: number; frac: number; firstHi: string
} {
  let maxHi = 0, maxLo = 0, nHi = 0, nAny = 0, firstHi = '—'
  for (let i = 0; i < a.data.length; i += 4) {
    const hi = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 2] - b.data[i + 2]))
    const lo = Math.max(Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 3] - b.data[i + 3]))
    if (hi > 0) {
      nHi++
      if (firstHi === '—') firstHi = `(${(i / 4) % W},${Math.floor(i / 4 / W)})`
    }
    if (hi > 0 || lo > 0) nAny++
    maxHi = Math.max(maxHi, hi)
    maxLo = Math.max(maxLo, lo)
  }
  return { maxHi, maxLo, nHi, nAny, frac: nHi / (a.data.length / 4), firstHi }
}

async function main(): Promise<void> {
  const rig = await createRig()
  const rows: Array<Record<string, unknown>> = []
  try {
    const blank: Rgba8 = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }
    for (const p of PROBES) {
      const mk = (b: Backend): PassSpec => ({
        body: p.body(b),
        prelude: (p.prelude ? p.prelude(b) + '\n' : '') + packPrelude(b),
        filter: p.filter ?? 'nearest',
      })
      const src = p.input ? p.input() : blank
      const gpu = await rig.capture({ backend: 'webgpu', width: W, height: H, input: src, passes: [mk('webgpu')] })
      const gl = await rig.capture({ backend: 'webgl2', width: W, height: H, input: src, passes: [mk('webgl2')] })
      const d = diff(gpu, gl)
      rows.push({ id: p.id, what: p.what, ...d })
      const verdict = d.nAny === 0
        ? 'IDENTICAL'
        : d.nHi === 0
          ? `sub-1/255 only  (lo byte differs on ${d.nAny} px, hi byte identical)`
          : `DIFFERS  hi max ${d.maxHi}/255 on ${d.nHi} px (${(d.frac * 100).toFixed(2)}%)  first ${d.firstHi}`
      console.log(`  ${p.id.padEnd(18)} ${verdict}`)
      console.log(`      ${p.what}`)
    }
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'phase15.json'), JSON.stringify({ rows }, null, 2))
  console.log(`\n  wrote ${path.join(OUT, 'phase15.json')}`)
}

main()
