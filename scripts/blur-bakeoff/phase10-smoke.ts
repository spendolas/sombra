/**
 * Phase 10 smoke / calibration — proves the rig runs the node's real WGSL and
 * that KNOWN-GOOD controls come back clean before any metric is trusted.
 *
 *   C1 bypass       image -> fragment_output            must equal the stimulus exactly
 *   C2 identity     reeded_glass at ior = 1.0           must equal the stimulus exactly
 *   C3 ssaa(1)      the SSAA wrapper at N=1             must be byte-identical to unwrapped
 *   C4 ssaa(4) vs native 4x render + CPU box downsample, vertical ribs, x-ramp source
 *   C5 same as C4 with horizontal ribs and a y-ramp source (exercises the y offset)
 *   C4b/C5b the same comparison with the wrapper's v_uv y-sign deliberately flipped —
 *           the KNOWN-BAD that the C4/C5 gate has to be able to separate.
 *
 * Ramp sources are used for C4/C5 because a native 4x render also renders the
 * SOURCE pass at 4x; only a source that is resolution-invariant (a linear ramp)
 * makes the two paths comparable, isolating the wrapper itself.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase10-smoke.ts
 */

import { createPhase10Rig } from './phase10-rig'
import { buildReededGraph, IMAGE_SAMPLER } from './phase10-graph'
import type { Rgba8 } from './lib/image'

const W = 1200, H = 800

/** Deterministic asymmetric stimulus — catches flips, offsets and rescales. */
function asymmetric(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const q = (x < w / 2 ? 0 : 1) + (y < h / 2 ? 0 : 2)
      d[i] = [40, 120, 200, 240][q]
      d[i + 1] = (x * 255 / (w - 1)) | 0
      d[i + 2] = (y * 255 / (h - 1)) | 0
      d[i + 3] = 255
    }
  }
  const m = (10 * w + 20) * 4
  d[m] = 255; d[m + 1] = 0; d[m + 2] = 255
  return { width: w, height: h, data: d }
}

function ramp(w: number, h: number, axis: 'x' | 'y'): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const t = axis === 'x' ? x / (w - 1) : y / (h - 1)
      const v = Math.round(t * 255)
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function diff(a: Rgba8, b: Rgba8): { max: number; mean: number; nDiff: number; p999: number } {
  let max = 0, sum = 0, n = 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < a.data.length; i++) {
    if (i % 4 === 3) continue
    const d = Math.abs(a.data[i] - b.data[i])
    if (d > max) max = d
    sum += d
    hist[d]++
    if (d > 0) n++
  }
  const total = a.data.length * 0.75
  let cum = 0, p999 = 0
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= total * 0.999) { p999 = v; break } }
  return { max, mean: sum / total, nDiff: n, p999 }
}

/** Box-average an S x S block down to 1 pixel. */
function boxDown(img: Rgba8, s: number): Rgba8 {
  const w = img.width / s, h = img.height / s
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) {
          const i = ((y * s + dy) * img.width + (x * s + dx)) * 4
          acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2]; acc[3] += img.data[i + 3]
        }
      }
      const o = (y * w + x) * 4
      const n = s * s
      out[o] = Math.round(acc[0] / n); out[o + 1] = Math.round(acc[1] / n)
      out[o + 2] = Math.round(acc[2] / n); out[o + 3] = Math.round(acc[3] / n)
    }
  }
  return { width: w, height: h, data: out }
}

async function main() {
  const rig = await createPhase10Rig()
  console.log('adapter:', rig.adapterInfo)
  const src = asymmetric(W, H)
  const aspect = W / H
  let fails = 0
  const gate = (name: string, ok: boolean, detail: string) => {
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
  }

  try {
    {
      const g = buildReededGraph({}, aspect, { bypass: true })
      const out = await rig.run({ width: W, height: H, dpr: 1, passes: g.passes, images: { [IMAGE_SAMPLER]: src } })
      const d = diff(out, src)
      gate('C1 bypass exact', d.max === 0, `max=${d.max} nDiff=${d.nDiff} passes=${g.passes.length}`)
    }

    {
      const g = buildReededGraph({ ior: 1.0, frost: 0 }, aspect)
      const out = await rig.run({ width: W, height: H, dpr: 1, passes: g.passes, images: { [IMAGE_SAMPLER]: src } })
      const d = diff(out, src)
      gate('C2 identity lens exact', d.max === 0, `max=${d.max} nDiff=${d.nDiff} passes=${g.passes.length}`)
    }

    {
      const a = buildReededGraph({}, aspect)
      const b = buildReededGraph({}, aspect)
      b.passes[b.passes.length - 1].ssaa = 1
      const oa = await rig.run({ width: W, height: H, dpr: 1, passes: a.passes, images: { [IMAGE_SAMPLER]: src } })
      const ob = await rig.run({ width: W, height: H, dpr: 1, passes: b.passes, images: { [IMAGE_SAMPLER]: src } })
      const d = diff(oa, ob)
      gate('C3 ssaa(1) == unwrapped', d.max === 0, `max=${d.max} nDiff=${d.nDiff}`)
    }

    // C4 / C5 — wrapper vs a genuine native 4x render.
    for (const [label, dir, axis] of [['C4 vertical', 'vertical', 'x'], ['C5 horizontal', 'horizontal', 'y']] as const) {
      const stim = ramp(W, H, axis)
      // Oblique seams at a non-pixel-aligned rib width, so the map really does vary
      // inside a pixel and 1-tap vs 16-tap MUST differ. (At ribWidth 80 on a
      // 1200 px canvas every seam lands exactly on a pixel boundary and
      // supersampling is a no-op — which is a finding, not a valid gate.)
      const cfg = { direction: dir as 'vertical' | 'horizontal', frost: 0, ribWidth: 37, srt_rotate: 23 }

      const native = buildReededGraph(cfg, aspect)
      const nat = await rig.run({ width: W * 4, height: H * 4, dpr: 4, passes: native.passes, images: { [IMAGE_SAMPLER]: stim } })
      const natDown = boxDown(nat, 4)

      // KNOWN-BAD for the same gate: a "wrapper" that does not actually
      // supersample (the plain 1-tap render). The gate is relative, because a
      // linear-ramp stimulus only carries 0.21 levels/px so absolute level
      // differences are small by construction.
      const g1 = buildReededGraph(cfg, aspect)
      const out1 = await rig.run({ width: W, height: H, dpr: 1, passes: g1.passes, images: { [IMAGE_SAMPLER]: stim } })
      const d1 = diff(out1, natDown)

      const results: Record<string, ReturnType<typeof diff>> = {}
      for (const bad of [false, true]) {
        const g = buildReededGraph(cfg, aspect)
        const last = g.passes[g.passes.length - 1]
        last.ssaa = 4
        last.ssaaBadSign = bad
        const out = await rig.run({ width: W, height: H, dpr: 1, passes: g.passes, images: { [IMAGE_SAMPLER]: stim } })
        results[bad ? 'bad' : 'good'] = diff(out, natDown)
      }
      const good = results.good
      gate(`${label} ssaa(4) == native4x`, good.max <= 2, `max=${good.max} mean=${good.mean.toFixed(4)}`)
      gate(`${label} gate separates known-bad (1-tap)`, d1.mean > good.mean * 2,
        `1tap mean=${d1.mean.toFixed(4)} (max=${d1.max}) vs ssaa4 mean=${good.mean.toFixed(4)} — ratio ${(d1.mean / good.mean).toFixed(2)}x`)
      console.log(`        flipped-v_uv.y control: mean=${results.bad.mean.toFixed(4)} (${(results.bad.mean / good.mean).toFixed(2)}x good)`)
    }
  } finally {
    await rig.close()
  }
  console.log(fails === 0 ? '\nALL CONTROLS PASS' : `\n${fails} CONTROL(S) FAILED`)
  if (fails) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
