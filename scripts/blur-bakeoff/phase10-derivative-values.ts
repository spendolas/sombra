/**
 * Phase 10c — what does a hardware derivative actually RETURN inside this node?
 *
 * Legality (phase10-derivative-legality.ts) says where `fwidth` may be written.
 * It says nothing about whether the number it returns is usable. The lens chain
 * runs a continuous screen coordinate through `mod`/`floor`/`fract`, so several
 * of the quantities a fix might naively differentiate have jump discontinuities.
 * At a jump the 2x2 quad straddles it and the derivative reports the JUMP, not
 * the slope — exactly at the seam, which is exactly where an AA fix needs a
 * trustworthy number.
 *
 * This measures it. The node's REAL emitted GLSL pass is taken verbatim and only
 * its final `fragColor =` line is replaced with a 16-bit encoded probe, so the
 * whole lens chain above the probe is byte-identical to what ships.
 *
 * CALIBRATION: probe P0 differentiates `v_uv.x`, whose exact derivative is known
 * (1/width in UV, i.e. 1.0 px per px). If P0 does not read 1.000 the encoder or
 * the rig is wrong and no other number in the run may be trusted.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase10-derivative-values.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { createRig } from './lib/gpu-rig'
import type { Rgba8 } from './lib/image'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase10')
const SIZE = 512
const DPR = 1
const VMAX = 256 // probe encoding full-scale, in device px

interface Probe { id: string; what: string; expr: string; expectNote: string }

const PROBES: Probe[] = [
  {
    id: 'P0-calib-vuv',
    what: 'fwidth(v_uv.x) * u_resolution.x  — known-good control',
    expr: 'fwidth(v_uv.x) * u_resolution.x',
    expectNote: 'exactly 1.000 px/px everywhere',
  },
  {
    id: 'P1-main-continuous',
    what: 'fwidth(rg_wm_scr_rg) * u_resolution.x  — pattern main coord (continuous for straight ribs)',
    expr: 'fwidth(rg_wm_scr_rg) * u_resolution.x',
    expectNote: 'flat ~1.000 px/px, no seam spike',
  },
  {
    id: 'P2-lens-folded',
    what: 'fwidth(rg_lens_scr_rg.x) * u_resolution.x  — lens output (mod/floor/fract folded)',
    expr: 'fwidth(rg_lens_scr_rg.x) * u_resolution.x',
    expectNote: 'spikes to ~0.667*ribWidth*dpr at each seam',
  },
  {
    id: 'P3-sampleuv',
    what: 'fwidth(rg_sampleUV_rg.x) * u_viewport.x  — the sample position a fix would differentiate',
    expr: 'fwidth(rg_sampleUV_rg.x) * u_viewport.x',
    expectNote: 'same seam spike; |slope| < 1 everywhere else',
  },
  {
    id: 'P4-local-phase',
    what: 'fwidth(mod(rg_wm_scr_rg, rg_ribUV_scr_rg) / rg_ribUV_scr_rg) * u_rg_ribWidth * u_dpr — rib phase',
    expr: 'fwidth(mod(rg_wm_scr_rg, rg_ribUV_scr_rg) / rg_ribUV_scr_rg) * u_rg_ribWidth * u_dpr',
    expectNote: 'flat ~1 px/px away from seams, spikes to ~ribWidth at the mod() wrap',
  },
  {
    id: 'P5-analytic-rate',
    what: 'analytic ribs-per-pixel * ribWidth*dpr — no derivative at all',
    expr: '(1.0 / (rg_ribUV_scr_rg * u_resolution.x)) * u_rg_ribWidth * u_dpr / u_rg_srt_scale',
    expectNote: 'exactly 1.000, uniform, and legal anywhere',
  },
]

function graph(params: Record<string, unknown> = {}): { nodes: Node[]; edges: Edge[] } {
  const nodes = [
    { id: 'img', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params: { imageData: '', fitMode: 'cover' } } },
    { id: 'rg', type: 'shaderNode', position: { x: 200, y: 0 }, data: { type: 'reeded_glass', params } },
    { id: 'out', type: 'shaderNode', position: { x: 400, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ] as unknown as Node[]
  const edges = [
    { id: 'e1', source: 'img', sourceHandle: 'color', target: 'rg', targetHandle: 'source' },
    { id: 'e2', source: 'rg', sourceHandle: 'color', target: 'out', targetHandle: 'color' },
  ] as unknown as Edge[]
  return { nodes, edges }
}

/** Replace the final `fragColor = ...;` with a 16-bit encode of `expr`. */
function makeProbeShader(src: string, expr: string): string {
  const i = src.lastIndexOf('  fragColor =')
  if (i < 0) throw new Error('final fragColor assignment not found')
  const end = src.indexOf('\n', i)
  const encode =
    `  float pr_v = ${expr};\n` +
    `  float pr_t = clamp(pr_v / ${VMAX.toFixed(1)}, 0.0, 1.0);\n` +
    `  float pr_q = floor(pr_t * 65535.0 + 0.5);\n` +
    `  float pr_hi = floor(pr_q / 256.0);\n` +
    `  fragColor = vec4(pr_hi / 255.0, (pr_q - pr_hi * 256.0) / 255.0, 0.0, 1.0);`
  return src.slice(0, i) + encode + src.slice(end)
}

function decode(img: Rgba8): Float64Array {
  const out = new Float64Array(img.width * img.height)
  for (let p = 0; p < out.length; p++) {
    const q = img.data[p * 4] * 256 + img.data[p * 4 + 1]
    out[p] = (q / 65535) * VMAX
  }
  return out
}

function stats(v: Float64Array, w: number, h: number) {
  // Sample the middle row band, away from the frame edge where the quad
  // derivative is one-sided.
  const vals: number[] = []
  for (let y = Math.floor(h * 0.4); y < Math.floor(h * 0.6); y++) {
    for (let x = 4; x < w - 4; x++) vals.push(v[y * w + x])
  }
  const sorted = [...vals].sort((a, b) => a - b)
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
  return {
    min: +sorted[0].toFixed(4),
    p50: +q(0.5).toFixed(4),
    p99: +q(0.99).toFixed(4),
    max: +sorted[sorted.length - 1].toFixed(4),
  }
}

/** Columns in the mid row whose value exceeds `thr`, and their spacing. */
function spikeColumns(v: Float64Array, w: number, h: number, thr: number) {
  const y = Math.floor(h / 2)
  const cols: number[] = []
  for (let x = 2; x < w - 2; x++) if (v[y * w + x] > thr) cols.push(x)
  const gaps: number[] = []
  for (let i = 1; i < cols.length; i++) gaps.push(cols[i] - cols[i - 1])
  return { count: cols.length, cols: cols.slice(0, 24), gaps: gaps.slice(0, 24) }
}

async function main(): Promise<void> {
  initializeNodeLibrary()
  const g0 = graph()
  const plan = compileGraph(g0.nodes, g0.edges)
  if ((plan.errors ?? []).length) throw new Error(`compile errors: ${JSON.stringify(plan.errors)}`)
  const pass0 = plan.passes[0]
  const pass1 = plan.passes[1]

  const rig = await createRig()
  if (!rig.available.webgl2) throw new Error('WebGL2 unavailable')

  // A flat grey source — the probe never samples it, but pass 0 must still run.
  const input: Rgba8 = {
    width: 64, height: 64,
    data: new Uint8ClampedArray(64 * 64 * 4).fill(128),
  }
  for (let p = 0; p < 64 * 64; p++) input.data[p * 4 + 3] = 255

  const ribPx = 80 * DPR
  console.log(`size ${SIZE}x${SIZE}, dpr ${DPR}, ribWidth ${ribPx} device px, defaults ior 1.5 / curvature 0.8`)
  console.log(`predicted seam jump in sampled position = 0.667 * ribW = ${(0.667 * ribPx).toFixed(1)} px\n`)

  const out: Array<Record<string, unknown>> = []
  let calibOk = false

  for (const probe of PROBES) {
    const img = await rig.captureRawGlsl({
      width: SIZE, height: SIZE, dpr: DPR, input,
      passes: [
        {
          fragmentShader: pass0.fragmentShader, vertexShader: pass0.vertexShader,
          sampler: (pass0.inputTextures?.[0] as string) ?? 'u_pass0_tex',
          userUniforms: pass0.userUniforms as never,
        },
        {
          fragmentShader: makeProbeShader(pass1.fragmentShader, probe.expr),
          vertexShader: pass1.vertexShader,
          sampler: (pass1.inputTextures?.[0] as string) ?? 'u_pass0_tex',
          userUniforms: pass1.userUniforms as never,
        },
      ],
    })
    const v = decode(img)
    const s = stats(v, img.width, img.height)
    const sp = spikeColumns(v, img.width, img.height, Math.max(4, s.p50 * 8))
    console.log(`${probe.id}`)
    console.log(`   ${probe.what}`)
    console.log(`   expect: ${probe.expectNote}`)
    console.log(`   px/px  min ${s.min}  median ${s.p50}  p99 ${s.p99}  MAX ${s.max}`)
    console.log(`   spike columns in mid row: n=${sp.count} at ${JSON.stringify(sp.cols)} gaps ${JSON.stringify(sp.gaps)}\n`)
    out.push({ ...probe, stats: s, spikes: sp })
    if (probe.id === 'P0-calib-vuv') {
      calibOk = Math.abs(s.p50 - 1) < 0.01 && Math.abs(s.max - 1) < 0.01
    }
  }

  // -------------------------------------------------------------------------
  // Sub-pixel seam-alignment sweep.
  //
  // A 2x2 quad derivative can only SEE a jump that falls strictly inside the
  // quad. At the defaults (anchor 0.5, 512 px, ribWidth 80, dpr 1) the seams
  // land on x = 255.5 + 80k — exactly on the boundary between quad columns —
  // so no quad straddles them and every probe above reads as if the map were
  // continuous. That is an alignment accident, not an absence of the jump.
  // Slide the pattern by sub-pixel amounts and the jump must appear.
  // -------------------------------------------------------------------------
  console.log('--- sub-pixel seam alignment sweep (probe P3, fwidth of sample UV) ---')
  const sweep: Array<Record<string, unknown>> = []
  const SWEEP_PROBES: Array<[string, string]> = [
    ['sampleUV(discontinuous)', 'fwidth(rg_sampleUV_rg.x) * u_viewport.x'],
    ['mainScr(continuous)', 'fwidth(rg_wm_scr_rg) * u_resolution.x'],
    ['localPhase(mod-folded)', 'fwidth(mod(rg_wm_scr_rg, rg_ribUV_scr_rg) / rg_ribUV_scr_rg) * u_rg_ribWidth * u_dpr'],
  ]
  for (let tx = 0; tx <= 2.0001; tx += 0.125) {
    const gg = graph({ srt_translateX: tx })
    const pl = compileGraph(gg.nodes, gg.edges)
    const p0 = pl.passes[0], p1 = pl.passes[1]
    const row: Record<string, unknown> = { translateX: +tx.toFixed(3) }
    const cells: string[] = []
    for (const [label, expr] of SWEEP_PROBES) {
      const img = await rig.captureRawGlsl({
        width: SIZE, height: SIZE, dpr: DPR, input,
        passes: [
          { fragmentShader: p0.fragmentShader, vertexShader: p0.vertexShader, sampler: (p0.inputTextures?.[0] as string) ?? 'u_pass0_tex', userUniforms: p0.userUniforms as never },
          { fragmentShader: makeProbeShader(p1.fragmentShader, expr), vertexShader: p1.vertexShader, sampler: (p1.inputTextures?.[0] as string) ?? 'u_pass0_tex', userUniforms: p1.userUniforms as never },
        ],
      })
      const v = decode(img)
      const s = stats(v, img.width, img.height)
      const sp = spikeColumns(v, img.width, img.height, 4)
      row[label] = { stats: s, spikeCount: sp.count, cols: sp.cols.slice(0, 6) }
      cells.push(`${label} max ${String(s.max).padStart(8)} (n=${String(sp.count).padStart(2)})`)
    }
    console.log(`  tx ${tx.toFixed(3)} px | ${cells.join(' | ')}`)
    sweep.push(row)
  }
  const sweepMax = Math.max(...sweep.map((s) => ((s as Record<string, { stats: { max: number } }>)["sampleUV(discontinuous)"]).stats.max))
  const predicted = 0.6667 * ribPx
  const sweepOk = sweepMax > 0.5 * predicted
  console.log(`\n  sweep max ${sweepMax.toFixed(1)} px/px vs analytic seam jump ${predicted.toFixed(1)} px`)
  console.log(sweepOk
    ? '  CONFIRMED: the jump is real and the flat reading at translateX=0 is a quad-alignment artifact.'
    : '  *** the jump never appeared — investigate before trusting any conclusion here ***')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'derivative-values.json'), JSON.stringify({ calibOk, sweepOk, size: SIZE, dpr: DPR, ribPx, probes: out, alignmentSweep: sweep }, null, 2))
  console.log(calibOk
    ? '\nCALIBRATED: P0 read 1.000 px/px as required.'
    : '\n*** UNCALIBRATED: P0 did not read 1.000 px/px — no number above is trustworthy. ***')

  await rig.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
