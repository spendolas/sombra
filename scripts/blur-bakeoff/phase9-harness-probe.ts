/**
 * Phase 9 probe — HARNESS AUDIT ONLY. Answers, by measurement, what the frost
 * bench can and cannot rely on in scripts/blur-bakeoff/lib/*.
 *
 * This script decides nothing about frost algorithms. It establishes:
 *   P1  cross-backend bit-hash parity: is `uv` bit-identical in WGSL vs GLSL?
 *   P2  a custom sparse stochastic gather pass compiles + runs on BOTH backends
 *   P3  sampler filter: nearest quantises sub-texel jitter (silent wrong answer)
 *   P4  sampleOrig is hard-wired to a NEAREST sampler on WebGPU
 *   P5  the rgba8unorm intermediate noise floor through ingest/egress
 *   P6  anisotropyScore is BLIND to square-vs-disc footprints (calibration trap)
 *   P7  boxinessKurtosis on a 1D slice does separate box/square from Gaussian
 *   P8  emulating the DPR tier flip by re-rendering at a different device grid,
 *       with the resample floor measured as the control
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-harness-probe.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRig, type Rig, type Backend, type PassSpec } from './lib/gpu-rig'
import { ingestPass, egressPass } from './lib/shaders'
import { createFloat, type Rgba8 } from './lib/image'
import { anisotropyScore, boxinessKurtosis } from './lib/detectors'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')

// ---------------------------------------------------------------------------
// Per-backend source for a bit-hash + an 8-tap stochastic gather.
// The rig's "same body on both backends" contract holds only for expressions;
// loops, var decls and bitcasts differ, so a stochastic gather MUST be emitted
// per backend the way lib/shaders.ts syntax() already does.
// ---------------------------------------------------------------------------
function hashPrelude(backend: Backend): string {
  return backend === 'webgpu'
    ? `
fn reedHash(p: vec2f) -> vec2f {
  var q: vec2u = vec2u(bitcast<u32>(p.x), bitcast<u32>(p.y));
  q = q * 1103515245u + vec2u(12345u);
  q.x = q.x + q.y * 1664525u;
  q.y = q.y + q.x * 1013904223u;
  q = q ^ (q >> vec2u(16u, 16u));
  return vec2f(q) / f32(0xFFFFFFFFu) * 2.0 - 1.0;
}
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
`
}

/** Raw hash of uv, mapped to [0,1] — used to test bit-level cross-backend parity. */
function hashProbePass(backend: Backend): PassSpec {
  return {
    prelude: hashPrelude(backend),
    body: '  return vec4(reedHash(uv) * 0.5 + 0.5, 0.0, 1.0);',
    filter: 'nearest',
  }
}

interface FrostOpts {
  backend: Backend
  taps: number
  /** Half-extent of the jitter square, in TARGET pixels. */
  radiusPx: number
  /** Lattice cells across the full 0..1 uv span. 0 = per-device-pixel seed. */
  latticeCells: number
  filter?: 'linear' | 'nearest'
  /** Read the gather through sampleOrig instead of sampleSrc (P4). */
  viaOrig?: boolean
}

/** The current shipped frost estimator, re-expressed for the rig. */
function frostPass(o: FrostOpts): PassSpec {
  const wg = o.backend === 'webgpu'
  const d = (t: string, n: string, i: string) => (wg ? `  var ${n}: ${t} = ${i};` : `  ${t} ${n} = ${i};`)
  const loopOpen = wg
    ? `  for (var i: i32 = 0; i < ${o.taps}; i = i + 1) {`
    : `  for (int i = 0; i < ${o.taps}; i++) {`
  const fi = wg ? 'f32(i)' : 'float(i)'
  const sample = o.viaOrig ? 'sampleOrig' : 'sampleSrc'
  // Seed: quantised lattice over uv (dpr-invariant, like rg_gc) or the raw
  // fragment index (per-device-pixel, re-rolls on a DPR flip).
  const seed =
    o.latticeCells > 0
      ? `floor(uv * ${o.latticeCells.toFixed(1)})`
      : `floor(uv * U.u_resolution)`
  const lines = [
    d('vec2', 'frad', `vec2(${o.radiusPx.toFixed(4)}) / U.u_resolution`),
    d('vec2', 'gc', seed),
    d('vec3', 'acc', 'vec3(0.0)'),
    d('float', 'aacc', '0.0'),
    loopOpen,
    d('vec2', 'jit', `reedHash(gc + vec2(${fi} * 7.31, ${fi} * -11.13)) * frad`),
    d('vec2', 'tap', 'uv + jit'),
    `    tap = 1.0 - abs(fract(tap * 0.5) * 2.0 - 1.0);`,
    d('vec4', 's', `${sample}(tap)`),
    `    acc = acc + s.rgb * s.a;`,
    `    aacc = aacc + s.a;`,
    `  }`,
    `  return vec4(acc / max(aacc, 1e-5), aacc / ${o.taps.toFixed(1)});`,
  ]
  return { prelude: hashPrelude(o.backend), body: lines.join('\n'), filter: o.filter ?? 'linear' }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function meanMax(a: Rgba8, b: Rgba8): { mean: number; max: number } {
  let s = 0, n = 0, m = 0
  const px = Math.min(a.width * a.height, b.width * b.height)
  for (let p = 0; p < px; p++)
    for (let c = 0; c < 3; c++) {
      const dd = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])
      s += dd; n++; if (dd > m) m = dd
    }
  return { mean: n ? s / n : 0, max: m }
}

function exactDiffPixels(a: Rgba8, b: Rgba8): number {
  let n = 0
  const px = Math.min(a.width * a.height, b.width * b.height)
  for (let p = 0; p < px; p++)
    for (let c = 0; c < 3; c++) if (a.data[p * 4 + c] !== b.data[p * 4 + c]) { n++; break }
  return n
}

/** Std-dev of luma over the image, in 8-bit codes. */
function lumaStd(img: Rgba8): number {
  const n = img.width * img.height
  let s = 0
  const l = new Float64Array(n)
  for (let p = 0; p < n; p++) {
    l[p] = 0.2126 * img.data[p * 4] + 0.7152 * img.data[p * 4 + 1] + 0.0722 * img.data[p * 4 + 2]
    s += l[p]
  }
  const mu = s / n
  let v = 0
  for (let p = 0; p < n; p++) v += (l[p] - mu) ** 2
  return Math.sqrt(v / n)
}

/** Checkerboard with a fixed CSS cell size, rendered on a device grid of scale `dpr`. */
function cssChecker(cssW: number, cssH: number, dpr: number, cellCss: number): Rgba8 {
  const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr)
  const img: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  const cell = cellCss * dpr
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0
      const i = (y * w + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = on ? 235 : 20
      img.data[i + 3] = 255
    }
  return img
}

function flat(w: number, h: number, v: number): Rgba8 {
  const img: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let p = 0; p < w * h; p++) {
    img.data[p * 4] = img.data[p * 4 + 1] = img.data[p * 4 + 2] = v
    img.data[p * 4 + 3] = 255
  }
  return img
}

/** Bilinear resample to a new size (used only to bring two DPR grids onto one). */
function resample(img: Rgba8, w: number, h: number): Rgba8 {
  const out: Rgba8 = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, ((y + 0.5) * img.height) / h - 0.5))
    const y0 = Math.floor(sy), y1 = Math.min(img.height - 1, y0 + 1), fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, ((x + 0.5) * img.width) / w - 0.5))
      const x0 = Math.floor(sx), x1 = Math.min(img.width - 1, x0 + 1), fx = sx - x0
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y0 * img.width + x1) * 4 + c] * fx
        const b = img.data[(y1 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y1 * img.width + x1) * 4 + c] * fx
        out.data[(y * w + x) * 4 + c] = Math.round(a * (1 - fy) + b * fy)
      }
    }
  }
  return out
}

/** Synthetic PSF: filled square vs filled disc of equal area, as a FloatImage. */
function psf(kind: 'square' | 'disc', n: number): ReturnType<typeof createFloat> {
  const img = createFloat(n, n)
  const c = (n - 1) / 2
  const half = n * 0.3
  const rDisc = Math.sqrt((2 * half) ** 2 / Math.PI) // equal area
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = x - c, dy = y - c
      const inside = kind === 'square' ? Math.abs(dx) <= half && Math.abs(dy) <= half : dx * dx + dy * dy <= rDisc * rDisc
      if (inside) img.data[(y * n + x) * 4] = 1
    }
  return img
}

// ---------------------------------------------------------------------------
async function main() {
  const findings: Record<string, unknown> = {}
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ---- P6/P7 are pure CPU; run them first so a rig failure still leaves data.
  {
    const sq = psf('square', 65)
    const dc = psf('disc', 65)
    const aSq = anisotropyScore(sq)
    const aDc = anisotropyScore(dc)
    findings.P6_anisotropy_square_vs_disc = {
      square: +aSq.toFixed(5), disc: +aDc.toFixed(5),
      verdict: Math.abs(aSq - aDc) < 0.01 ? 'BLIND — cannot distinguish square from disc' : 'separates',
      why: 'anisotropyScore compares mxx vs myy; an axis-aligned square and a disc both have mxx==myy',
    }
    console.log(`P6 anisotropy: square=${aSq.toFixed(5)} disc=${aDc.toFixed(5)}`)

    // 1D horizontal slice through the centre of each PSF, plus a Gaussian.
    const slice = (img: ReturnType<typeof createFloat>) => {
      const n = img.width, c = Math.floor(n / 2)
      const out = new Float64Array(n)
      for (let x = 0; x < n; x++) out[x] = img.data[(c * n + x) * 4]
      return out
    }
    const gauss = new Float64Array(65)
    for (let x = 0; x < 65; x++) gauss[x] = Math.exp(-((x - 32) ** 2) / (2 * 8 * 8))
    findings.P7_boxiness = {
      square_slice: +boxinessKurtosis(slice(sq)).toFixed(3),
      disc_slice: +boxinessKurtosis(slice(dc)).toFixed(3),
      gaussian: +boxinessKurtosis(gauss).toFixed(3),
      note: 'a centre slice of a square and of a disc are both flat boxes; boxiness separates box-ish from Gaussian, not square from disc',
    }
    console.log(`P7 boxiness: square=${findings.P7_boxiness && (findings.P7_boxiness as Record<string, number>).square_slice} disc=${(findings.P7_boxiness as Record<string, number>).disc_slice} gauss=${(findings.P7_boxiness as Record<string, number>).gaussian}`)
  }

  let rig: Rig | null = null
  try {
    rig = await createRig()
    console.log(`rig: webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2}`)
    findings.backends = rig.available

    const N = 128
    const src = cssChecker(N, N, 1, 8)

    // ---- P1 cross-backend bit-hash parity ---------------------------------
    const hGpu = await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [hashProbePass('webgpu')] })
    const hGl = await rig.capture({ backend: 'webgl2', width: N, height: N, input: src, passes: [hashProbePass('webgl2')] })
    const hd = meanMax(hGpu, hGl)
    const hDiffPx = exactDiffPixels(hGpu, hGl)
    findings.P1_bit_hash_parity = {
      differing_pixels: hDiffPx, total_pixels: N * N,
      mean_abs_diff_codes: +hd.mean.toFixed(3), max_abs_diff_codes: hd.max,
      verdict: hDiffPx === 0 ? 'bit-identical uv on both backends' : 'uv differs at bit level between backends',
    }
    console.log(`P1 hash parity: ${hDiffPx}/${N * N} px differ, mean ${hd.mean.toFixed(2)} max ${hd.max} codes`)

    // ---- P2 the gather runs on both backends ------------------------------
    const gGpu = await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [frostPass({ backend: 'webgpu', taps: 8, radiusPx: 24, latticeCells: 32 })] })
    const gGl = await rig.capture({ backend: 'webgl2', width: N, height: N, input: src, passes: [frostPass({ backend: 'webgl2', taps: 8, radiusPx: 24, latticeCells: 32 })] })
    const gd = meanMax(gGpu, gGl)
    let nonBlack = 0
    for (let p = 0; p < N * N; p++) if (gGpu.data[p * 4] > 0) nonBlack++
    findings.P2_gather_runs = {
      webgpu_nonblack_px: nonBlack, total: N * N,
      cross_backend_mean_codes: +gd.mean.toFixed(3), cross_backend_max_codes: gd.max,
      webgpu_luma_std_codes: +lumaStd(gGpu).toFixed(2),
      webgl2_luma_std_codes: +lumaStd(gGl).toFixed(2),
    }
    console.log(`P2 gather: webgpu nonblack ${nonBlack}/${N * N}, cross-backend mean ${gd.mean.toFixed(2)} max ${gd.max}`)

    // ---- P3 nearest sampler quantises the jitter ---------------------------
    const gLin = gGpu
    const gNear = await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [frostPass({ backend: 'webgpu', taps: 8, radiusPx: 24, latticeCells: 32, filter: 'nearest' })] })
    const fd = meanMax(gLin, gNear)
    findings.P3_filter_matters = {
      linear_vs_nearest_mean_codes: +fd.mean.toFixed(2), max_codes: fd.max,
      note: 'nearest snaps every tap to a source texel centre, destroying sub-texel jitter; a stochastic gather MUST use filter:"linear"',
    }
    console.log(`P3 linear vs nearest: mean ${fd.mean.toFixed(2)} max ${fd.max} codes`)

    // ---- P4 sampleOrig is NEAREST on WebGPU regardless of pass.filter -------
    const gOrig = await rig.capture({ backend: 'webgpu', width: N, height: N, input: src, passes: [frostPass({ backend: 'webgpu', taps: 8, radiusPx: 24, latticeCells: 32, viaOrig: true, filter: 'linear' })] })
    const od = meanMax(gLin, gOrig)
    const odNear = meanMax(gNear, gOrig)
    findings.P4_sampleOrig_is_nearest = {
      vs_sampleSrc_linear_mean_codes: +od.mean.toFixed(2),
      vs_sampleSrc_nearest_mean_codes: +odNear.mean.toFixed(2),
      verdict: odNear.mean < od.mean ? 'sampleOrig behaves as NEAREST (matches the nearest run)' : 'inconclusive',
      note: 'gpu-rig binds samplers.nearest to origSamp unconditionally (WebGPU) and sets NEAREST on origTex (WebGL2)',
    }
    console.log(`P4 sampleOrig: vs linear ${od.mean.toFixed(2)}, vs nearest ${odNear.mean.toFixed(2)} codes`)

    // ---- P5 rgba8unorm intermediate noise floor ----------------------------
    // Flat mid-grey through ingest -> passthrough -> egress. Any luma spread is
    // pure harness quantisation and sets the floor a speckle metric can resolve.
    const grey = flat(N, N, 128)
    const dark = flat(N, N, 24)
    const bracket = (b: Backend, f16: boolean): PassSpec[] => [
      { ...ingestPass(b), float16: f16 },
      { body: 'return sampleSrc(uv);', filter: 'nearest', float16: f16 },
      egressPass(b),
    ]
    const floors: Record<string, number> = {}
    for (const [name, img] of [['grey128', grey], ['dark24', dark]] as Array<[string, Rgba8]>) {
      for (const f16 of [false, true]) {
        const out = await rig!.capture({ backend: 'webgpu', width: N, height: N, input: img, passes: bracket('webgpu', f16) })
        const inVal = img.data[0]
        let worst = 0
        for (let p = 0; p < N * N; p++) worst = Math.max(worst, Math.abs(out.data[p * 4] - inVal))
        floors[`${name}_${f16 ? 'f16' : 'rgba8'}_max_roundtrip_err_codes`] = worst
      }
    }
    findings.P5_intermediate_floor = {
      ...floors,
      note: 'ingest writes LINEAR premultiplied into the intermediate; at rgba8 that costs codes in the shadows. float16:true on non-final passes removes it.',
    }
    console.log(`P5 floors: ${JSON.stringify(floors)}`)

    // ---- P8 DPR tier flip emulation ---------------------------------------
    // The engine's dpr = min(devicePixelRatio,2) * dprScale, and BOTH the canvas
    // pixel size and u_dpr scale together, so frozen-ref coords are invariant in
    // CSS space. Emulate the flip by rendering the same CSS scene on two device
    // grids and bringing them onto one grid to compare.
    const CSS = 192
    const dprA = 2.0, dprB = 1.5 // static tier vs animated tier at devicePixelRatio 2
    const wA = Math.round(CSS * dprA), wB = Math.round(CSS * dprB)
    const dprRows: Array<Record<string, unknown>> = []
    for (const [label, taps, lattice] of [
      ['sparse8_lattice', 8, 32],
      ['sparse8_perpixel', 8, 0],
      ['dense64_perpixel', 64, 0],
    ] as Array<[string, number, number]>) {
      const capA = await rig!.capture({
        backend: 'webgpu', width: wA, height: wA, input: cssChecker(CSS, CSS, dprA, 12),
        passes: [frostPass({ backend: 'webgpu', taps, radiusPx: 24 * dprA, latticeCells: lattice })],
      })
      const capB = await rig!.capture({
        backend: 'webgpu', width: wB, height: wB, input: cssChecker(CSS, CSS, dprB, 12),
        passes: [frostPass({ backend: 'webgpu', taps, radiusPx: 24 * dprB, latticeCells: lattice })],
      })
      const flip = meanMax(capA, resample(capB, wA, wA))
      // control: the resample floor — same render, round-tripped through the B grid
      const floorImg = resample(resample(capA, wB, wB), wA, wA)
      const floorD = meanMax(capA, floorImg)
      dprRows.push({
        variant: label,
        dpr_flip_mean_codes: +flip.mean.toFixed(2), dpr_flip_max_codes: flip.max,
        resample_floor_mean_codes: +floorD.mean.toFixed(2), resample_floor_max_codes: floorD.max,
        excess_over_floor_mean_codes: +(flip.mean - floorD.mean).toFixed(2),
      })
      console.log(`P8 ${label}: flip ${flip.mean.toFixed(2)}/${flip.max}, resample floor ${floorD.mean.toFixed(2)}/${floorD.max}`)
    }
    findings.P8_dpr_flip = {
      model: 'dpr = min(devicePixelRatio,2) * dprScale; canvas px AND u_dpr both scale, so frozen-ref coords are CSS-invariant',
      tiers: { static: dprA, animated: dprB },
      rows: dprRows,
      note: 'the resample floor is the control: any flip delta at or below it is measurement noise, not a re-roll',
    }
  } finally {
    if (rig) await rig.close()
  }

  fs.writeFileSync(path.join(OUT_DIR, 'harness-probe.json'), JSON.stringify(findings, null, 2))
  console.log(`\nwrote ${path.join(OUT_DIR, 'harness-probe.json')}`)
}

main()
