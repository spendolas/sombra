/**
 * Phase 9 probe C — can the rig reproduce the real node's WGSL uniformity
 * constraint?
 *
 * `frost` is connectable, so `if (frost > 0.001)` can be non-uniform control
 * flow, and WGSL then forbids textureSample (implicit derivatives) inside it —
 * only textureSampleLevel(..., 0.0) is legal. The rig's built-in sampleSrc()
 * uses textureSample, so a bench that gathers inside a non-uniform branch has to
 * declare its own LOD-0 helper in the pass prelude.
 *
 * This checks: (a) does the rig reject textureSample in a non-uniform branch,
 * (b) does a prelude-declared textureSampleLevel helper compile and render.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-wgsl-uniformity.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig } from './lib/gpu-rig'
import type { Rgba8 } from './lib/image'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')

function ramp(n: number): Rgba8 {
  const img: Rgba8 = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round((x / (n - 1)) * 255)
      img.data[i + 3] = 255
    }
  return img
}

/** Per-pixel non-uniform predicate driven by a sampled value, like a wired param. */
const NONUNIFORM = 'sampleSrc(uv).r * 2.0 - 0.5'

/** Illegal on WebGPU: textureSample under non-uniform control flow. */
const BAD = {
  body: `
  if (${NONUNIFORM} > 0.001) {
    return sampleSrc(uv + U.u_texel * 3.0);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);`,
  filter: 'linear' as const,
}

/** Legal: an explicit LOD-0 fetch. srcTex/srcSamp are in scope for the prelude. */
const GOOD = {
  prelude: `
fn sampleSrcL0(p: vec2f) -> vec4f { return textureSampleLevel(srcTex, srcSamp, p, 0.0); }
`,
  body: `
  if (sampleSrcL0(uv).r * 2.0 - 0.5 > 0.001) {
    return sampleSrcL0(uv + U.u_texel * 3.0);
  }
  return vec4(0.0, 0.0, 0.0, 1.0);`,
  filter: 'linear' as const,
}

async function main() {
  const rig = await createRig()
  const N = 32
  const src = ramp(N)
  const out: Record<string, unknown> = {}
  try {
    let badErr = ''
    try {
      await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [BAD] })
    } catch (e) {
      badErr = String((e as Error).message).slice(0, 300)
    }
    out.webgpu_textureSample_in_nonuniform_branch = badErr
      ? { rejected: true, error: badErr }
      : { rejected: false, note: 'this Chrome accepted it — do NOT rely on the rig to catch the engine constraint' }
    console.log(`WGSL textureSample in non-uniform branch: ${badErr ? 'REJECTED — ' + badErr.split('\n')[0] : 'ACCEPTED'}`)

    const good = await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [GOOD] })
    let lit = 0
    for (let p = 0; p < N * N; p++) if (good.data[p * 4] > 0) lit++
    out.webgpu_textureSampleLevel_helper = { compiled: true, lit_pixels: lit, total: N * N }
    console.log(`WGSL textureSampleLevel helper: compiled, ${lit}/${N * N} lit pixels`)

    // The same structure must also work on WebGL2, where texture() has no such rule.
    const glGood = await rig.capture({
      backend: 'webgl2', width: N, height: N, input: src,
      passes: [{ body: BAD.body.replace(/vec4\(/g, 'vec4('), filter: 'linear' }],
    })
    let glLit = 0
    for (let p = 0; p < N * N; p++) if (glGood.data[p * 4] > 0) glLit++
    out.webgl2_same_structure = { compiled: true, lit_pixels: glLit, total: N * N }
    console.log(`WebGL2 same structure: compiled, ${glLit}/${N * N} lit pixels`)
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'wgsl-uniformity.json'), JSON.stringify(out, null, 2))
}

main()
