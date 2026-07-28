/**
 * Phase 9 probe B — confirm/refute a suspected gpu-rig bug.
 *
 * Suspicion: in the WebGL2 path, pass 0's source texture IS origTex (same GL
 * object). captureWebGL sets the pass filter on srcTex at TEXTURE0, then
 * immediately binds origTex at TEXTURE1 and forces NEAREST on it. GL texture
 * filter state lives on the texture OBJECT, not the binding point, so on pass 0
 * that second call overwrites the first: `filter:'linear'` is silently NEAREST.
 *
 * Harmless for the existing suites (they all start with ingestPass, which is
 * nearest by design). Fatal for a sparse stochastic gather, whose whole premise
 * is sub-texel tap placement.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-webgl-filter-bug.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig } from './lib/gpu-rig'
import type { Rgba8 } from './lib/image'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')

/** Half-texel diagonal offset: LINEAR must blend 4 texels, NEAREST must not. */
const HALF_TEXEL = { body: '  return sampleSrc(uv + U.u_texel * 0.5);', filter: 'linear' as const }
const HALF_TEXEL_NEAREST = { body: '  return sampleSrc(uv + U.u_texel * 0.5);', filter: 'nearest' as const }
const PASSTHRU_NEAREST = { body: '  return sampleSrc(uv);', filter: 'nearest' as const }

function checker(n: number): Rgba8 {
  const img: Rgba8 = { width: n, height: n, data: new Uint8ClampedArray(n * n * 4) }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = (x + y) % 2 === 0 ? 255 : 0
      const i = (y * n + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  return img
}

/** Fraction of interior pixels that are neither 0 nor 255 — i.e. actually blended. */
function blendedFraction(img: Rgba8): number {
  let n = 0, tot = 0
  for (let y = 1; y < img.height - 1; y++)
    for (let x = 1; x < img.width - 1; x++) {
      const v = img.data[(y * img.width + x) * 4]
      tot++
      if (v > 8 && v < 247) n++
    }
  return tot ? n / tot : 0
}

async function main() {
  const rig = await createRig()
  const N = 64
  const src = checker(N)
  const out: Record<string, unknown> = {}
  try {
    for (const backend of ['webgpu', 'webgl2'] as const) {
      // A: gather is pass 0 (source == the uploaded input texture)
      const a = await rig.capture({ backend, width: N, height: N, input: src, passes: [HALF_TEXEL] })
      // B: gather is pass 1, behind a nearest passthrough (source is an FBO texture)
      const b = await rig.capture({ backend, width: N, height: N, input: src, passes: [PASSTHRU_NEAREST, HALF_TEXEL] })
      // C: explicitly nearest at pass 0 — the expected "no blending" control
      const c = await rig.capture({ backend, width: N, height: N, input: src, passes: [HALF_TEXEL_NEAREST] })
      out[backend] = {
        pass0_linear_blended_fraction: +blendedFraction(a).toFixed(4),
        pass1_linear_blended_fraction: +blendedFraction(b).toFixed(4),
        pass0_nearest_blended_fraction: +blendedFraction(c).toFixed(4),
      }
      console.log(
        `${backend}: pass0 linear=${blendedFraction(a).toFixed(3)}  pass1 linear=${blendedFraction(b).toFixed(3)}  pass0 nearest=${blendedFraction(c).toFixed(3)}`,
      )
    }
  } finally {
    await rig.close()
  }

  const gl = out.webgl2 as Record<string, number>
  out.verdict =
    gl.pass0_linear_blended_fraction < 0.05 && gl.pass1_linear_blended_fraction > 0.9
      ? 'CONFIRMED: WebGL2 pass 0 ignores filter:"linear" (origTex NEAREST clobbers it); pass 1+ is fine'
      : 'not reproduced'
  console.log(out.verdict)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'webgl-filter-bug.json'), JSON.stringify(out, null, 2))
}

main()
