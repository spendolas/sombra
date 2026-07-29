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

interface Probe { id: string; what: string; body: (b: Backend) => string; prelude?: (b: Backend) => string }

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
        filter: 'nearest',
      })
      const gpu = await rig.capture({ backend: 'webgpu', width: W, height: H, input: blank, passes: [mk('webgpu')] })
      const gl = await rig.capture({ backend: 'webgl2', width: W, height: H, input: blank, passes: [mk('webgl2')] })
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
