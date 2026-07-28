/**
 * Phase 12 — measure the SHIPPED analytic seam-coverage AA (the working-tree
 * `reeded-glass.ts`) against the phase-10b ground truth, on both backends.
 *
 * WHY A NEW FILE AND WHY IT IS SHAPED LIKE THIS
 * ---------------------------------------------
 * phase-10b's published columns (`reports/blur-bakeoff/phase10/worst/look-worst.json`)
 * were produced with the AA implemented as a SOURCE REWRITE of the node's own
 * shader (candidate `A4`), against a ground truth `A8` = 16x16 box supersample of
 * the SAME rewrite machinery applied to the PRE-change node. Now that the AA
 * lives inside the node, two things break naive comparison:
 *
 *   1. `A8` on the CURRENT node super-samples a shader that already box-filters
 *      itself across each seam — a double filter. That GT is ~1 px blurrier along
 *      the seam normal than the published GT, so every candidate would score
 *      against a different target and the columns would not be comparable.
 *   2. The published `A0` column is the PRE-change node at 1 sample/px. There is
 *      no candidate in phase-10b that reproduces it from the current tree.
 *
 * So this script compiles BOTH nodes in one process: the working-tree definition
 * (SHIPPED) and the `HEAD` definition (PRE), the latter loaded by extracting it
 * with `git show` and overriding the node registry. GT and the error-bearing band
 * are then built from PRE exactly as phase-10b built them, and SHIPPED is scored
 * against that same GT with the same statistic. Gate P1..P3 refuse to report
 * anything unless PRE reproduces the published A0/A4/A3 numbers.
 *
 * Nothing about the metric is re-invented: `worstWindow`, `residualModes`, the
 * >=8-code band, `dmax` and the stimuli are byte-copies of
 * `phase10-look-worst.ts`, and `staircase`/`decodeSeamField` are imported from
 * `lib/edge-metrics.ts`. `buildGraph` / `candidatePasses` / `CONFIGS` /
 * `CANDIDATE_BY_ID` are imported from `phase10-reed-aa.ts`.
 *
 * Read-only w.r.t. `src/`. Writes only `reports/blur-bakeoff/phase12/` plus a
 * generated PRE module in the OS temp dir.
 *
 * Run:
 *   npx tsx scripts/blur-bakeoff/phase12-shipped-aa.ts             # everything
 *   npx tsx scripts/blur-bakeoff/phase12-shipped-aa.ts --stage=emit
 *   ... --stage=main|geom|stair|clamp
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { registerNode } from '../../src/nodes/registry'
import { reededGlassNode as shippedReededGlass } from '../../src/nodes/transform/reeded-glass'
import type { NodeDefinition } from '../../src/nodes/types'

import {
  buildGraph, candidatePasses, seamProbePasses, CANDIDATE_BY_ID, CONFIGS,
  type BenchConfig, type Candidate, type ReedCfg, type StimulusId, type BuiltGraph,
} from './phase10-reed-aa.ts'
import { createAaRig, type AaRig, type Backend } from './phase10-aa-rig.ts'
import type { Rgba8 } from './lib/image.ts'
import { encodePng } from './lib/png.ts'
import { decodeSeamField, staircase } from './lib/edge-metrics.ts'

const REPO = process.cwd()
const OUT = path.join(REPO, 'reports', 'blur-bakeoff', 'phase12')
const SCRATCH = path.join(os.tmpdir(), 'sombra-phase12')
const W = 1200
const H = 800
const MARGIN = 12
/** git ref the PRE (pre-change) node is read from */
const PRE_REF = 'HEAD'
/** Probe encodes signed seam distance over +-SEAM_RANGE_PX (phase-10b value). */
const SEAM_RANGE_PX = 8

const arg = (k: string): string | undefined => {
  const a = process.argv.find((s) => s.startsWith(`--${k}=`))
  return a ? a.slice(k.length + 3) : undefined
}
const STAGE = arg('stage') ?? 'all'
const wants = (s: string): boolean => STAGE === 'all' || STAGE === s

// ===========================================================================
// PRE node — the pre-change definition, compiled in this same process
// ===========================================================================

/**
 * Extract `<ref>:src/nodes/transform/reeded-glass.ts`, rewrite its five relative
 * imports to absolute paths so it can live outside `src/`, and load it. The
 * module is byte-identical to the committed node apart from those import paths,
 * which is asserted below.
 */
async function loadPreNode(): Promise<{ def: NodeDefinition; file: string; sha: string }> {
  fs.mkdirSync(SCRATCH, { recursive: true })
  const rel = 'src/nodes/transform/reeded-glass.ts'
  const src = execFileSync('git', ['show', `${PRE_REF}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24 })
  const sha = execFileSync('git', ['rev-parse', `${PRE_REF}:${rel}`], { cwd: REPO, encoding: 'utf8' }).trim()
  const p = (...s: string[]): string => path.join(REPO, ...s).replace(/\\/g, '/')
  const subs: Array<[RegExp, string]> = [
    [/from '\.\.\/types'/g, `from '${p('src', 'nodes', 'types')}'`],
    [/from '\.\.\/noise\/noise-functions'/g, `from '${p('src', 'nodes', 'noise', 'noise-functions')}'`],
    [/from '\.\.\/\.\.\/compiler\/ir\/types'/g, `from '${p('src', 'compiler', 'ir', 'types')}'`],
  ]
  let out = src
  let n = 0
  for (const [re, to] of subs) {
    const before = out
    out = out.replace(re, to)
    if (out !== before) n += (before.match(re) ?? []).length
  }
  if (n !== 5) throw new Error(`loadPreNode: expected to rewrite 5 imports, rewrote ${n}`)
  if (/from '\.\.?\//.test(out)) throw new Error('loadPreNode: a relative import survived the rewrite')
  const file = path.join(SCRATCH, 'pre-reeded-glass.ts')
  fs.writeFileSync(file, out)
  const mod = await import(file) as { reededGlassNode?: NodeDefinition }
  if (!mod.reededGlassNode) throw new Error('loadPreNode: module has no reededGlassNode export')
  if (mod.reededGlassNode.type !== 'reeded_glass') throw new Error('loadPreNode: wrong node type')
  return { def: mod.reededGlassNode, file, sha }
}

let PRE: NodeDefinition
type Which = 'pre' | 'shipped'
let current: Which = 'shipped'

/** Swap the registry entry. `buildGraph` reads the registry at compile time. */
function selectNode(which: Which): void {
  const warn = console.warn
  console.warn = () => {}
  registerNode(which === 'pre' ? PRE : shippedReededGlass)
  console.warn = warn
  current = which
}

function build(which: Which, cfg: ReedCfg, aspect: number): BuiltGraph {
  if (current !== which) selectNode(which)
  return buildGraph(cfg, aspect)
}

// ===========================================================================
// Stimuli — verbatim from phase10-look-worst.ts
// ===========================================================================

function ramp(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = Math.round((x / (w - 1)) * 255)
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function hfNoise(w: number, h: number, seed = 1): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  let s = seed >>> 0
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const v = Math.round(rnd() * 255)
    d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
  }
  return { width: w, height: h, data: d }
}

function thinLines(w: number, h: number, spacing = 9): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = (x % spacing === 0 || y % spacing === 4) ? 245 : 10
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function stepImg(w: number, h: number): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const v = x < w / 2 ? 25 : 230
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function coverCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const s = Math.max(w / img.width, h / img.height)
  const sw = Math.max(1, Math.round(img.width * s))
  const sh = Math.max(1, Math.round(img.height * s))
  const ox = Math.floor((sw - w) / 2)
  const oy = Math.floor((sh - h) / 2)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = (y + oy + 0.5) / s - 0.5
    const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(sy)))
    const y1 = Math.min(img.height - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < w; x++) {
      const sx = (x + ox + 0.5) / s - 0.5
      const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(sx)))
      const x1 = Math.min(img.width - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y0 * img.width + x1) * 4 + c] * fx
        const b = img.data[(y1 * img.width + x0) * 4 + c] * (1 - fx) + img.data[(y1 * img.width + x1) * 4 + c] * fx
        out[o + c] = Math.round(a * (1 - fy) + b * fy)
      }
    }
  }
  return { width: w, height: h, data: out }
}

async function loadStimuli(rig: AaRig): Promise<Map<StimulusId, Rgba8>> {
  const m = new Map<StimulusId, Rgba8>()
  const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')))
  m.set('photo', coverCrop(await rig.decodeImage(bytes, 'image/jpeg', 2048), W, H))
  m.set('noise', hfNoise(W, H))
  m.set('lines', thinLines(W, H))
  m.set('ramp-x', ramp(W, H))
  m.set('step', stepImg(W, H))
  return m
}

// ===========================================================================
// Image + metric helpers — verbatim from phase10-look-worst.ts
// ===========================================================================

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(img.height - 1, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(img.width - 1, x0 + x))
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

function upscaleNearest(img: Rgba8, k: number): Rgba8 {
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4
      out.set(img.data.subarray(s, s + 4), (y * w + x) * 4)
    }
  }
  return { width: w, height: h, data: out }
}

function hstack(imgs: Rgba8[], gap = 6): Rgba8 {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1)
  const out = new Uint8ClampedArray(w * h * 4).fill(0)
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  let x0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        out.set(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4), (y * w + x0 + x) * 4)
      }
    }
    x0 += im.width
    if (x0 < w) {
      for (let y = 0; y < h; y++) {
        for (let g = 0; g < gap; g++) {
          const o = (y * w + x0 + g) * 4
          out[o] = 255; out[o + 1] = 0; out[o + 2] = 128; out[o + 3] = 255
        }
      }
      x0 += gap
    }
  }
  return { width: w, height: h, data: out }
}

function boxDown(img: Rgba8, s: number): Rgba8 {
  const w = Math.floor(img.width / s)
  const h = Math.floor(img.height / s)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let j = 0; j < s; j++) {
        for (let i = 0; i < s; i++) {
          const o = ((y * s + j) * img.width + (x * s + i)) * 4
          for (let c = 0; c < 4; c++) acc[c] += img.data[o + c]
        }
      }
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / (s * s))
    }
  }
  return { width: w, height: h, data: out }
}

function writePng(name: string, img: Rgba8): string {
  const p = path.join(OUT, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, encodePng(img))
  return p
}

function dmax(a: Rgba8, b: Rgba8, i: number): number {
  const o = i * 4
  return Math.max(
    Math.abs(a.data[o] - b.data[o]),
    Math.abs(a.data[o + 1] - b.data[o + 1]),
    Math.abs(a.data[o + 2] - b.data[o + 2]),
  )
}

/** window (size x size) maximising the mean of |a - b|; the loser's worst place */
function worstWindow(a: Rgba8, b: Rgba8, size: number): { x: number; y: number; score: number } {
  let best = { x: MARGIN, y: MARGIN, score: -1 }
  for (let y = MARGIN; y + size < H - MARGIN; y += 4) {
    for (let x = MARGIN; x + size < W - MARGIN; x += 4) {
      let s = 0
      for (let j = 0; j < size; j += 2) {
        for (let i = 0; i < size; i += 2) s += dmax(a, b, (y + j) * W + (x + i))
      }
      if (s > best.score) best = { x, y, score: s }
    }
  }
  best.score /= (size / 2) ** 2
  return best
}

function residualModes(cand: Rgba8, gt: Rgba8, band: Uint8Array): { modes: number; top: number[] } {
  const hist = new Map<number, number>()
  let n = 0
  for (let i = 0; i < W * H; i++) {
    if (!band[i]) continue
    const q = Math.round(dmax(cand, gt, i) / 4) * 4
    hist.set(q, (hist.get(q) ?? 0) + 1)
    n++
  }
  const kept = [...hist.entries()].filter(([, c]) => c / n > 0.02).sort((p, q) => q[1] - p[1])
  return { modes: kept.length, top: kept.slice(0, 8).map(([v]) => v) }
}

interface Stat { mean: number; max: number; p999: number }

function statOf(cand: Rgba8, gt: Rgba8, band: Uint8Array): Stat {
  const v: number[] = []
  let s = 0
  let m = 0
  for (let i = 0; i < W * H; i++) {
    if (!band[i]) continue
    const d = dmax(cand, gt, i)
    v.push(d); s += d; if (d > m) m = d
  }
  if (v.length === 0) return { mean: 0, max: 0, p999: 0 }
  v.sort((p, q) => p - q)
  return { mean: s / v.length, max: m, p999: v[Math.floor(v.length * 0.999)] }
}

/** max |Δ| in 8-bit codes over the whole frame (RGB), plus where it happens */
function frameMaxDelta(a: Rgba8, b: Rgba8): { max: number; x: number; y: number; nGt1: number } {
  let mx = 0
  let at = 0
  let nGt1 = 0
  for (let i = 0; i < W * H; i++) {
    const d = dmax(a, b, i)
    if (d > 1) nGt1++
    if (d > mx) { mx = d; at = i }
  }
  return { max: mx, x: at % W, y: Math.floor(at / W), nGt1 }
}

// ===========================================================================
// Rendering
// ===========================================================================

function periodPx(cfg: ReedCfg, dpr: number): number {
  return (cfg.ribWidth ?? 80) * dpr * (cfg.srt_scale ?? 1)
}

function candCtx(bc: BenchConfig): { frostRadiusPx: number; periodPx: number } {
  return { frostRadiusPx: (bc.cfg.frost ?? 0) * 24 * bc.dpr, periodPx: periodPx(bc.cfg, bc.dpr) }
}

// ---------------------------------------------------------------------------
// Local candidates: whole-source rewrites of the SHIPPED shader used as PROBES
// and as one control. None of them changes a metric definition — they read out
// the node's own variables, or neutralise exactly one line of it.
// ---------------------------------------------------------------------------

/** Replace the final colour statement (WGSL `return …;` / GLSL `fragColor = …;`). */
function replaceFinalOutput(src: string, kind: 'wgsl' | 'glsl', block: string): string {
  const anchor = kind === 'wgsl' ? 'return ' : 'fragColor = '
  const i = src.lastIndexOf(anchor)
  if (i < 0) throw new Error(`probe: ${kind} final output statement not found`)
  const end = src.indexOf(';', i)
  if (end < 0) throw new Error(`probe: ${kind} final output has no terminator`)
  return src.slice(0, i) + block + src.slice(end + 1)
}

/** The `<id>` suffix the node stamps on its variables, read off the source. */
function nodeSfx(src: string): string {
  const m = /rg_ss_(\w+)/.exec(src)
  if (!m) throw new Error('probe: rg_ss_* not found — the node emits no seam geometry')
  return m[1]
}

/** 24-bit log2(1 + value) encoder; never saturates for a finite value < 2^32. */
function encodeLogPx(kind: 'wgsl' | 'glsl', expr: string): string {
  if (kind === 'wgsl') {
    return [
      `let pb_r: f32 = ${expr};`,
      '  var pb_v: f32 = 1.0;',
      '  if (pb_r == pb_r) { pb_v = clamp(log2(1.0 + max(pb_r, 0.0)) / 32.0, 0.0, 1.0); }',
      '  let pb_q: u32 = u32(pb_v * 16777215.0 + 0.5);',
      '  return vec4f(f32(pb_q & 255u) / 255.0, f32((pb_q >> 8u) & 255u) / 255.0, f32((pb_q >> 16u) & 255u) / 255.0, 1.0);',
    ].join('\n')
  }
  return [
    `float pb_r = ${expr};`,
    '  float pb_v = (pb_r == pb_r) ? clamp(log2(1.0 + max(pb_r, 0.0)) / 32.0, 0.0, 1.0) : 1.0;',
    '  uint pb_q = uint(pb_v * 16777215.0 + 0.5);',
    '  fragColor = vec4(float(pb_q & 255u) / 255.0, float((pb_q >> 8u) & 255u) / 255.0, float((pb_q >> 16u) & 255u) / 255.0, 1.0);',
  ].join('\n')
}

const NOSPLIT_RE = /(rg_split_\w+(?::\s*bool)?\s*=\s*)abs\([^;]*;/

function deltaProbe(id: string, pick: (s: string, res: string) => string, noClamp: boolean): Candidate {
  return {
    id, label: `probe: |delta| in device px${noClamp ? ', gm clamp removed' : ''}`,
    nominalFetches: 1, raw: true,
    patchPrelude: (src0, kind) => {
      let src = src0
      if (noClamp) {
        const { out, n } = stripClamp(src)
        if (n !== 1) throw new Error(`${id}: expected exactly 1 gm clamp to strip, found ${n}`)
        src = out
      }
      const s = nodeSfx(src)
      const res = kind === 'wgsl' ? 'uniforms.u_resolution' : 'u_resolution'
      return replaceFinalOutput(src, kind, encodeLogPx(kind, pick(s, res)))
    },
  }
}

const LOCAL_CANDIDATES: Record<string, Candidate> = {
  /**
   * Control: the shipped shader with the split predicate forced false. Must be
   * byte-identical to the PRE node — that is what proves the emitter refactor
   * left the single-tap path alone, and it is the only reason the PRE-node GT is
   * a legitimate target for the shipped node.
   */
  NOSPLIT: {
    id: 'NOSPLIT', label: 'shipped node with rg_split forced false', nominalFetches: 1, raw: true,
    patchPrelude: (src, kind) => {
      if (!NOSPLIT_RE.test(src)) throw new Error(`NOSPLIT: rg_split assignment not found in ${kind}`)
      const out = src.replace(NOSPLIT_RE, '$1false;')
      if ((out.match(/rg_split_\w+(?::\s*bool)?\s*=\s*false;/) ?? []).length !== 1) {
        throw new Error(`NOSPLIT: patch did not apply exactly once in ${kind}`)
      }
      return out
    },
  },
  /** The node's own analytic seam distance + normal, in the bench's encoding. */
  SEAMPROBE: {
    id: 'SEAMPROBE', label: "probe: the node's own rg_ss / rg_n", nominalFetches: 1, raw: true,
    patchPrelude: (src, kind) => {
      const s = nodeSfx(src)
      const v = `clamp(rg_ss_${s} / ${(2 * SEAM_RANGE_PX).toFixed(1)} + 0.5, 0.0, 1.0)`
      const block = kind === 'wgsl'
        ? `return vec4f(${v}, rg_n_${s}.x * 0.5 + 0.5, rg_n_${s}.y * 0.5 + 0.5, 1.0);`
        : `fragColor = vec4(${v}, rg_n_${s}.x * 0.5 + 0.5, rg_n_${s}.y * 0.5 + 0.5, 1.0);`
      return replaceFinalOutput(src, kind, block)
    },
  },
  DELTAPROBE: deltaProbe('DELTAPROBE', (s, res) => `length(rg_d_${s} * ${res})`, false),
  DELTAPROBE_NOCLAMP: deltaProbe('DELTAPROBE_NOCLAMP', (s, res) => `length(rg_d_${s} * ${res})`, true),
  DELTAPROBE_ALL: deltaProbe('DELTAPROBE_ALL',
    (s, res) => `max(length(rg_d_${s} * ${res}), max(length(rg_d_a_${s} * ${res}), length(rg_d_b_${s} * ${res})))`, false),
  DELTAPROBE_ALL_NOCLAMP: deltaProbe('DELTAPROBE_ALL_NOCLAMP',
    (s, res) => `max(length(rg_d_${s} * ${res}), max(length(rg_d_a_${s} * ${res}), length(rg_d_b_${s} * ${res})))`, true),
}

/**
 * Render one (node, candidate) pair. `which` selects the node definition; the
 * candidate is a phase-10b candidate applied to whatever that node emits, so
 * `('shipped', 'A0')` is the untouched working-tree shader and
 * `('pre', 'A8')` is the published ground truth.
 */
async function render(
  rig: AaRig, stimuli: Map<StimulusId, Rgba8>, bc: BenchConfig,
  which: Which, candId: string, backend: Backend,
  mode: 'color' | 'count' | 'count-broken' = 'color',
): Promise<Rgba8> {
  const cand = LOCAL_CANDIDATES[candId] ?? CANDIDATE_BY_ID[candId]
  if (!cand) throw new Error(`unknown candidate ${candId}`)
  const k = cand.renderScale ?? 1
  const g = build(which, bc.cfg, W / H)
  const passes = candidatePasses(g, cand, W * k, H * k, candCtx(bc), mode)
  const r = await rig.run({
    backend, width: W * k, height: H * k, dpr: bc.dpr * k,
    passes, images: { [g.imageSampler]: stimuli.get(bc.stimulus)! },
  })
  return k === 1 ? r.image : boxDown(r.image, k)
}

function decodeCount(img: Rgba8): { mean: number; min: number; max: number; hist: Record<number, number> } {
  const np = img.width * img.height
  let sum = 0
  let mn = Infinity
  let mx = -Infinity
  const hist: Record<number, number> = {}
  for (let i = 0; i < np; i++) {
    const o = i * 4
    const c = img.data[o] + img.data[o + 1] * 256
    sum += c
    hist[c] = (hist[c] ?? 0) + 1
    if (c < mn) mn = c
    if (c > mx) mx = c
  }
  return { mean: sum / np, min: mn, max: mx, hist }
}

// ===========================================================================
// Calibration gates (W1..W4 verbatim from phase10-look-worst.ts)
// ===========================================================================

interface Gate { id: string; what: string; good: string; bad: string; pass: boolean }

function gateWorstWindow(): Gate[] {
  const mk = (): Rgba8 => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) })
  const a = mk(); const b = mk()
  for (let i = 3; i < a.data.length; i += 4) { a.data[i] = 255; b.data[i] = 255 }
  const BX = 700; const BY = 300
  for (let y = BY; y < BY + 24; y++) {
    for (let x = BX; x < BX + 24; x++) {
      const o = (y * W + x) * 4
      a.data[o] = 200; a.data[o + 1] = 200; a.data[o + 2] = 200
    }
  }
  const hit = worstWindow(a, b, 24)
  const found = Math.abs(hit.x - BX) <= 4 && Math.abs(hit.y - BY) <= 4
  const flat = worstWindow(b, b, 24)
  return [
    { id: 'W1', what: 'worst-window locator finds an injected 24x24 block',
      good: `found (${hit.x},${hit.y}) score=${hit.score.toFixed(1)}`,
      bad: `truth (${BX},${BY})`, pass: found && hit.score > 60 },
    { id: 'W2', what: 'locator scores 0 on an identical pair',
      good: `score=${flat.score.toFixed(3)}`, bad: 'nonzero would mean noise floor', pass: flat.score === 0 },
  ]
}

function gateModes(): Gate[] {
  const band = new Uint8Array(W * H)
  for (let y = 100; y < 700; y++) for (let x = 100; x < 1100; x++) band[y * W + x] = 1
  const mk = (f: (x: number, y: number) => number): Rgba8 => {
    const d = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4
        const v = f(x, y)
        d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
      }
    }
    return { width: W, height: H, data: d }
  }
  const zero = mk(() => 0)
  const twoLevel = mk((x) => (x % 2 === 0 ? 0 : 60))
  const rampR = mk((x) => (x - 100) % 61)
  const q2 = residualModes(twoLevel, zero, band)
  const qr = residualModes(rampR, zero, band)
  return [
    { id: 'W3', what: 'residual-mode count: 2-level known-bad reads few modes',
      good: `modes=${q2.modes} top=${q2.top.join(',')}`, bad: 'a smooth residual must read more', pass: q2.modes <= 3 },
    { id: 'W4', what: 'residual-mode count: continuous known-good reads many modes',
      good: `modes=${qr.modes}`, bad: `2-level reads ${q2.modes}`, pass: qr.modes >= 8 },
  ]
}

// ===========================================================================
// Published reference columns (reports/blur-bakeoff/phase10/worst/look-worst.json)
// ===========================================================================

const PUBLISHED: Record<string, { A0: [number, number]; A4: [number, number]; A3: [number, number] }> = {
  misaligned: { A0: [20.570150824272186, 94], A4: [1.8374254647492108, 24], A3: [4.312346545071905, 30] },
  rot15: { A0: [22.276206962877477, 117], A4: [3.8615118291979225, 21], A3: [6.886708982496634, 54] },
  'wave-sine': { A0: [22.115614493836382, 124], A4: [4.968621591333583, 30], A3: [6.424168845722824, 68] },
  rot45: { A0: [23.085354025218233, 116], A4: [7.71988360814743, 27], A3: [8.53423860329777, 48] },
  ior2p5: { A0: [11.259473564783299, 53], A4: [11.259813932380304, 53], A3: [1.0715906512366689, 9] },
  curv1p5: { A0: [18.20304805349645, 142], A4: [18.201544761806023, 142], A3: [3.723472085428438, 55] },
  default: { A0: [9.3646408839779, 22], A4: [9.3646408839779, 22], A3: [0.85451197053407, 3] },
}

/** configs A4 is documented as a NO-OP on — the split branch must not fire */
const NOOP_CONFIGS = ['default', 'ior2p5', 'curv1p5']
const TARGETS = ['curv1p5', 'misaligned', 'rot45', 'wave-sine', 'rot15', 'ior2p5', 'default']

// ===========================================================================
// main
// ===========================================================================

const results: Record<string, unknown> = {}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const pre = await loadPreNode()
  // Trigger phase10-reed-aa's own initNodes() BEFORE the first override,
  // otherwise its lazy registerNodes(ALL_NODES) would clobber the PRE entry.
  build('shipped', {}, W / H)
  PRE = pre.def
  results.preNode = { ref: PRE_REF, blobSha: pre.sha, module: pre.file }

  const gates: Gate[] = [...gateWorstWindow(), ...gateModes()]
  for (const g of gates) console.log(`${g.pass ? 'PASS' : 'FAIL'} ${g.id}: ${g.what} | ${g.good} | ${g.bad}`)
  if (gates.some((g) => !g.pass)) throw new Error('calibration gate failed — metrics not trustworthy')
  results.gates = gates

  if (wants('emit')) await stageEmit()

  const needRig = wants('main') || wants('regress') || wants('frostgap') || wants('gtcheck') || wants('geom') || wants('stair') || wants('clamp')
  if (needRig) {
    const rig = await createAaRig()
    console.log(`adapter: ${rig.adapterInfo}  webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2}`)
    results.adapter = rig.adapterInfo
    try {
      const stimuli = await loadStimuli(rig)
      if (wants('main')) await stageMain(rig, stimuli)
      if (wants('regress')) await stageRegress(rig, stimuli)
      if (wants('frostgap')) await stageFrostGap(rig, stimuli)
      if (wants('gtcheck')) await stageGtCheck(rig, stimuli)
      if (wants('geom')) await stageGeom(rig, stimuli)
      if (wants('stair')) await stageStair(rig, stimuli)
      if (wants('clamp')) await stageClamp(rig, stimuli)
    } finally {
      await rig.close()
    }
  }

  const p = path.join(OUT, `phase12-${STAGE}.json`)
  fs.writeFileSync(p, JSON.stringify(results, null, 2))
  console.log(`\nwrote ${p}`)
}

// --- stage: emit ------------------------------------------------------------

async function stageEmit(): Promise<void> {
  const dir = path.join(OUT, 'emit')
  fs.mkdirSync(dir, { recursive: true })
  const cases: Array<[string, ReedCfg]> = [
    ['default', {}],
    ['rot15', { srt_rotate: 15, ribWidth: 73 }],
    ['wave-sine', { ribType: 'wave', waveShape: 'sine', ribWidth: 73 }],
    ['circular', { ribType: 'circular', ribWidth: 73 }],
    ['noise', { ribType: 'noise', noiseType: 'simplex', ribWidth: 73 }],
  ]
  const info: Record<string, unknown> = {}
  for (const [name, cfg] of cases) {
    for (const which of ['shipped', 'pre'] as Which[]) {
      const g = build(which, cfg, W / H)
      const last = g.passes[g.passes.length - 1]
      fs.writeFileSync(path.join(dir, `${name}.${which}.wgsl`), last.wgsl)
      fs.writeFileSync(path.join(dir, `${name}.${which}.frag`), last.glslFrag)
    }
  }
  // static checks on the shipped emission
  const shapes: Record<string, unknown> = {}
  for (const [name, cfg] of cases) {
    const g = build('shipped', cfg, W / H)
    const last = g.passes[g.passes.length - 1]
    shapes[name] = {
      wgslClamp: (last.wgsl.match(/max\(rg_gm_\w+, -0\.75\)/g) ?? []).length,
      glslClamp: (last.glslFrag.match(/max\(rg_gm_\w+, -0\.75\)/g) ?? []).length,
      wgslGmZero: /rg_gm_\w+\s*(?::\s*f32)?\s*=\s*0\.0/.test(last.wgsl),
      wgslSampleLevel: (last.wgsl.match(/textureSampleLevel/g) ?? []).length,
      wgslOtherSample: (last.wgsl.match(/textureSample\(/g) ?? []).length,
      glslTexture: (last.glslFrag.match(/texture\(/g) ?? []).length,
      wgslSplit: (last.wgsl.match(/rg_split_\w+/g) ?? []).length,
      wgslNegations: (last.wgsl.match(/vec2f\(rg_n_\w+\.x, -rg_n_\w+\.y\)/g) ?? []).length,
    }
  }
  results.emit = { dir, shapes, info }
  console.log('emit shapes:', JSON.stringify(shapes, null, 2))
}

// ===========================================================================
// stage: main — the published matrix, SHIPPED vs PRE vs the published GT
// ===========================================================================

const BACKENDS: Backend[] = ['webgpu', 'webgl2']
/** column -> (node, candidate) */
const COLS: Array<[string, Which, string]> = [
  ['PRE', 'pre', 'A0'],
  ['A4', 'pre', 'A4'],
  ['A3', 'pre', 'A3'],
  ['GT', 'pre', 'A8'],
  ['SHIPPED', 'shipped', 'A0'],
  ['SHIPPED_NOSPLIT', 'shipped', 'NOSPLIT'],
]

async function stageMain(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const configs: Record<string, unknown> = {}
  for (const id of TARGETS) {
    const bc = CONFIGS.find((c) => c.id === id)
    if (!bc) throw new Error(`config ${id} not in CONFIGS`)
    const imgs: Record<Backend, Record<string, Rgba8>> = { webgpu: {}, webgl2: {} }
    for (const backend of BACKENDS) {
      for (const [col, which, cand] of COLS) {
        imgs[backend][col] = await render(rig, stimuli, bc, which, cand, backend)
      }
    }

    const perBackend: Record<string, unknown> = {}
    for (const backend of BACKENDS) {
      const im = imgs[backend]
      const gt = im.GT
      // the published error-bearing band: |PRE - GT| >= 8 codes, frame margin off
      const band = new Uint8Array(W * H)
      let nb = 0
      for (let i = 0; i < W * H; i++) {
        const y = Math.floor(i / W); const x = i % W
        if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
        if (dmax(im.PRE, gt, i) >= 8) { band[i] = 1; nb++ }
      }
      const stat: Record<string, Stat> = {}
      const modes: Record<string, unknown> = {}
      for (const [col] of COLS) { stat[col] = statOf(im[col], gt, band); modes[col] = residualModes(im[col], gt, band) }
      stat.GT = statOf(gt, gt, band)

      // does SHIPPED ever exceed PRE anywhere in the frame? (regression check)
      let worseN = 0
      let worseMax = 0
      let worseAt = 0
      for (let i = 0; i < W * H; i++) {
        if (!band[i]) continue
        const d = dmax(im.SHIPPED, gt, i) - dmax(im.PRE, gt, i)
        if (d > 0) worseN++
        if (d > worseMax) { worseMax = d; worseAt = i }
      }

      perBackend[backend] = {
        bandPx: nb, bandFrac: nb / (W * H), stat, modes,
        worstSHIPPEDWindow: worstWindow(im.SHIPPED, gt, 24),
        worstPREWindow: worstWindow(im.PRE, gt, 24),
        // SHIPPED with the split predicate forced false must equal PRE exactly:
        // proves the refactor did not move the single-tap path.
        noSplitVsPre: frameMaxDelta(im.SHIPPED_NOSPLIT, im.PRE),
        shippedVsA4: frameMaxDelta(im.SHIPPED, im.A4),
        regressionInBand: {
          pixelsWorseThanPre: worseN,
          fracWorseThanPre: nb === 0 ? 0 : worseN / nb,
          maxWorseCodes: worseMax,
          at: { x: worseAt % W, y: Math.floor(worseAt / W) },
        },
      }
    }

    // backend parity — the SAME experiment on both backends (raw node shader,
    // no bench source surgery, no per-backend sample pattern)
    const parity: Record<string, unknown> = {}
    for (const [col] of COLS) parity[col] = frameMaxDelta(imgs.webgpu[col], imgs.webgl2[col])

    // fetch counts (webgpu; count-mode shader is identical on both)
    const fetches: Record<string, unknown> = {}
    for (const [col, which, cand] of [['SHIPPED', 'shipped', 'A0'], ['PRE', 'pre', 'A0'], ['A4', 'pre', 'A4']] as Array<[string, Which, string]>) {
      const cimg = await render(rig, stimuli, bc, which, cand, 'webgpu', 'count')
      const c = decodeCount(cimg)
      fetches[col] = { mean: c.mean, min: c.min, max: c.max, hist: c.hist }
    }
    const broken = decodeCount(await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu', 'count-broken'))
    fetches.SHIPPED_brokenCounterKnownBad = { mean: broken.mean, min: broken.min, max: broken.max }

    // PNGs from webgpu (the backend the published columns were produced on)
    const g = imgs.webgpu
    const ZCOLS = ['PRE', 'A4', 'SHIPPED', 'GT']
    writePng(`full-${id}-PRE.png`, g.PRE)
    writePng(`full-${id}-SHIPPED.png`, g.SHIPPED)
    writePng(`full-${id}-GT.png`, g.GT)
    const wp = (perBackend.webgpu as { worstPREWindow: { x: number; y: number } }).worstPREWindow
    const ws = (perBackend.webgpu as { worstSHIPPEDWindow: { x: number; y: number } }).worstSHIPPEDWindow
    writePng(`worstPRE-${id}.png`, hstack(ZCOLS.map((c) => upscaleNearest(crop(g[c], wp.x, wp.y, 24, 24), 14))))
    writePng(`worstSHIPPED-${id}.png`, hstack(ZCOLS.map((c) => upscaleNearest(crop(g[c], ws.x, ws.y, 24, 24), 14))))

    configs[id] = { note: bc.note ?? '', cfg: bc.cfg, dpr: bc.dpr, stimulus: bc.stimulus,
      periodPx: periodPx(bc.cfg, bc.dpr), perBackend, parity, fetches,
      published: PUBLISHED[id] ?? null, zoomColumns: ZCOLS }

    const s = (perBackend.webgpu as { stat: Record<string, Stat>; bandFrac: number })
    console.log(`${id}: band=${(s.bandFrac * 100).toFixed(2)}%  ` +
      COLS.map(([c]) => `${c} ${s.stat[c].mean.toFixed(2)}/${s.stat[c].max}`).join('  '))
    console.log(`   published PRE(A0) ${PUBLISHED[id]?.A0.join('/')}  A4 ${PUBLISHED[id]?.A4.join('/')}  A3 ${PUBLISHED[id]?.A3.join('/')}` +
      `   parity SHIPPED max|d|=${(parity.SHIPPED as { max: number }).max}  fetch ${JSON.stringify((fetches.SHIPPED as { mean: number; min: number; max: number }))}`)
  }

  // comparability gates
  const gates: Gate[] = []
  const tol = (a: number, b: number, rel: number, abs: number): boolean =>
    Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b))
  for (const id of TARGETS) {
    const pub = PUBLISHED[id]
    const got = (configs[id] as { perBackend: Record<string, { stat: Record<string, Stat> }> }).perBackend.webgpu.stat
    for (const k of ['A0', 'A4', 'A3'] as const) {
      const col = k === 'A0' ? 'PRE' : k
      const [m, mx] = pub[k]
      gates.push({
        id: `P1.${id}.${k}`,
        what: `PRE-node ${k} reproduces the published column`,
        good: `mean ${got[col].mean.toFixed(4)} max ${got[col].max}`,
        bad: `published mean ${m.toFixed(4)} max ${mx}`,
        pass: tol(got[col].mean, m, 0.02, 0.05) && Math.abs(got[col].max - mx) <= 2,
      })
    }
  }
  for (const id of NOOP_CONFIGS) {
    const pb = (configs[id] as { perBackend: Record<string, { stat: Record<string, Stat> }> }).perBackend
    for (const backend of BACKENDS) {
      const st = pb[backend].stat
      gates.push({
        id: `P2.${id}.${backend}`,
        what: 'A4 is a documented NO-OP here, so SHIPPED must read the PRE number',
        good: `SHIPPED ${st.SHIPPED.mean.toFixed(4)}/${st.SHIPPED.max} vs PRE ${st.PRE.mean.toFixed(4)}/${st.PRE.max}`,
        bad: 'a difference means the new branch fires where the bench says it cannot',
        pass: tol(st.SHIPPED.mean, st.PRE.mean, 0.02, 0.05) && Math.abs(st.SHIPPED.max - st.PRE.max) <= 2,
      })
    }
  }
  for (const id of TARGETS) {
    const pb = (configs[id] as { perBackend: Record<string, { noSplitVsPre: { max: number } }> }).perBackend
    gates.push({
      id: `P3.${id}`,
      what: 'SHIPPED with the split predicate forced false is byte-identical to PRE',
      good: `webgpu max|d|=${pb.webgpu.noSplitVsPre.max}  webgl2 max|d|=${pb.webgl2.noSplitVsPre.max}`,
      bad: 'nonzero means the refactor moved the single-tap path too',
      pass: pb.webgpu.noSplitVsPre.max <= 1 && pb.webgl2.noSplitVsPre.max <= 1,
    })
  }
  for (const g of gates) console.log(`${g.pass ? 'PASS' : 'FAIL'} ${g.id}: ${g.what} | ${g.good} | ${g.bad}`)
  results.main = { configs, gates, comparable: gates.every((g) => g.pass) }
}

// ===========================================================================
// stage: regress — the FULL phase-10b config matrix (all 26), whole-frame as
// well as in-band, because "nothing got worse" has to cover the pixels the band
// excludes too. GT on webgpu only; SHIPPED on both, for parity.
// ===========================================================================

async function stageRegress(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const rows: Array<Record<string, unknown>> = []
  for (const bc of CONFIGS) {
    const pre = await render(rig, stimuli, bc, 'pre', 'A0', 'webgpu')
    const ship = await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu')
    const gt = await render(rig, stimuli, bc, 'pre', 'A8', 'webgpu')
    const shipGl = await render(rig, stimuli, bc, 'shipped', 'A0', 'webgl2')
    const preGl = await render(rig, stimuli, bc, 'pre', 'A0', 'webgl2')

    const band = new Uint8Array(W * H)
    let nb = 0
    for (let i = 0; i < W * H; i++) {
      const y = Math.floor(i / W); const x = i % W
      if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
      if (dmax(pre, gt, i) >= 8) { band[i] = 1; nb++ }
    }
    // whole-frame (margin-trimmed) fidelity and the per-pixel regression
    let sp = 0
    let ss = 0
    let mp = 0
    let ms = 0
    let n = 0
    let worseMax = 0
    let worseAt = 0
    let worse8 = 0
    for (let i = 0; i < W * H; i++) {
      const y = Math.floor(i / W); const x = i % W
      if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
      const ep = dmax(pre, gt, i)
      const es = dmax(ship, gt, i)
      sp += ep; ss += es; n++
      if (ep > mp) mp = ep
      if (es > ms) ms = es
      const d = es - ep
      if (d > worseMax) { worseMax = d; worseAt = i }
      if (d >= 8) worse8++
    }
    const cnt = decodeCount(await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu', 'count'))
    rows.push({
      config: bc.id, cfg: bc.cfg, dpr: bc.dpr, stimulus: bc.stimulus,
      periodPx: periodPx(bc.cfg, bc.dpr), note: bc.note ?? '',
      bandPx: nb,
      band: { PRE: statOf(pre, gt, band), SHIPPED: statOf(ship, gt, band) },
      frame: {
        meanPRE: sp / n, meanSHIPPED: ss / n, maxPRE: mp, maxSHIPPED: ms, n,
        maxShippedMinusPre: worseMax, at: { x: worseAt % W, y: Math.floor(worseAt / W) },
        pixelsWorseBy8Plus: worse8,
      },
      parity: { SHIPPED: frameMaxDelta(ship, shipGl), PRE: frameMaxDelta(pre, preGl) },
      fetches: { mean: cnt.mean, min: cnt.min, max: cnt.max, hist: cnt.hist },
    })
    const r = rows[rows.length - 1] as { band: { PRE: Stat; SHIPPED: Stat }; frame: Record<string, number> }
    console.log(`${bc.id.padEnd(15)} band ${nb.toString().padStart(7)}px  ` +
      `PRE ${r.band.PRE.mean.toFixed(2)}/${r.band.PRE.max}  SHIPPED ${r.band.SHIPPED.mean.toFixed(2)}/${r.band.SHIPPED.max}  ` +
      `frame ${r.frame.meanPRE.toFixed(3)}->${r.frame.meanSHIPPED.toFixed(3)} max ${r.frame.maxPRE}->${r.frame.maxSHIPPED}  ` +
      `worstDelta +${r.frame.maxShippedMinusPre}  parity ${(rows[rows.length - 1] as { parity: { SHIPPED: { max: number } } }).parity.SHIPPED.max}  ` +
      `fetch ${cnt.mean.toFixed(4)} [${cnt.min},${cnt.max}]`)
  }
  results.regress = { rows }
}

// ===========================================================================
// stage: gtcheck — quantify the double-filter this script exists to avoid:
// A8 (16x16) applied to the SHIPPED node super-samples a shader that already
// box-filters itself across each seam, so it is NOT the published GT.
// ===========================================================================

async function stageGtCheck(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const rows: Array<Record<string, unknown>> = []
  for (const id of ['misaligned', 'rot15', 'rot45', 'default']) {
    const bc = CONFIGS.find((c) => c.id === id)!
    const gtPre = await render(rig, stimuli, bc, 'pre', 'A8', 'webgpu')
    const gtShip = await render(rig, stimuli, bc, 'shipped', 'A8', 'webgpu')
    const pre = await render(rig, stimuli, bc, 'pre', 'A0', 'webgpu')
    const ship = await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu')
    const band = new Uint8Array(W * H)
    let nb = 0
    for (let i = 0; i < W * H; i++) {
      const y = Math.floor(i / W); const x = i % W
      if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
      if (dmax(pre, gtPre, i) >= 8) { band[i] = 1; nb++ }
    }
    const r = {
      config: id, bandPx: nb,
      gtShippedVsGtPre: frameMaxDelta(gtShip, gtPre),
      inBand_gtShippedVsGtPre: statOf(gtShip, gtPre, band),
      shippedScoredAgainst: {
        publishedGT_fromPreNode: statOf(ship, gtPre, band),
        wrongGT_fromShippedNode: statOf(ship, gtShip, band),
      },
    }
    rows.push(r)
    console.log(`gtcheck ${id.padEnd(11)} GT(shipped) vs GT(pre): frame max ${r.gtShippedVsGtPre.max} codes, ` +
      `in-band mean ${r.inBand_gtShippedVsGtPre.mean.toFixed(3)}/max ${r.inBand_gtShippedVsGtPre.max}  |  ` +
      `SHIPPED scored vs published GT ${r.shippedScoredAgainst.publishedGT_fromPreNode.mean.toFixed(3)}/` +
      `${r.shippedScoredAgainst.publishedGT_fromPreNode.max}  vs self-GT ` +
      `${r.shippedScoredAgainst.wrongGT_fromShippedNode.mean.toFixed(3)}/${r.shippedScoredAgainst.wrongGT_fromShippedNode.max}`)
  }
  results.gtcheck = { rows }
}

// ===========================================================================
// stage: frostgap — the seam-coverage branch is an `else if` AFTER the frost
// branch, so any frost > 0.001 disables it. The published matrix only carries
// frost 0 and frost 0.3 (where the 7.2 px jitter hides the seam anyway), so it
// cannot see whether a SMALL frost re-exposes the staircase with the AA off.
// Radius is frost * 24 * u_dpr px, i.e. sub-pixel below frost ~0.04.
// ===========================================================================

async function stageFrostGap(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const rows: Array<Record<string, unknown>> = []
  for (const frost of [0, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.3]) {
    const bc: BenchConfig = {
      id: `frost${frost}`, cfg: { ribWidth: 73, srt_rotate: 15, frost }, dpr: 1, stimulus: 'photo',
    }
    const pre = await render(rig, stimuli, bc, 'pre', 'A0', 'webgpu')
    const ship = await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu')
    const gt = await render(rig, stimuli, bc, 'pre', 'A8', 'webgpu')
    const band = new Uint8Array(W * H)
    let nb = 0
    for (let i = 0; i < W * H; i++) {
      const y = Math.floor(i / W); const x = i % W
      if (x < MARGIN || y < MARGIN || x >= W - MARGIN || y >= H - MARGIN) continue
      if (dmax(pre, gt, i) >= 8) { band[i] = 1; nb++ }
    }
    const cnt = decodeCount(await render(rig, stimuli, bc, 'shipped', 'A0', 'webgpu', 'count'))
    const r = {
      frost, frostRadiusPx: frost * 24 * bc.dpr, bandPx: nb,
      band: { PRE: statOf(pre, gt, band), SHIPPED: statOf(ship, gt, band) },
      fetches: { mean: cnt.mean, min: cnt.min, max: cnt.max },
      aaActive: cnt.max === 2,
    }
    rows.push(r)
    console.log(`frost ${frost.toString().padEnd(6)} radius ${r.frostRadiusPx.toFixed(3).padStart(6)}px  band ${nb.toString().padStart(6)}px  ` +
      `PRE ${r.band.PRE.mean.toFixed(2)}/${r.band.PRE.max}  SHIPPED ${r.band.SHIPPED.mean.toFixed(2)}/${r.band.SHIPPED.max}  ` +
      `fetch ${cnt.mean.toFixed(4)} [${cnt.min},${cnt.max}]  seamAAactive=${r.aaActive}`)
  }
  results.frostgap = { rows }
}

// ===========================================================================
// stage: geom — is the node's own seam geometry the same geometry the bench
// measured with finite differences?
// ===========================================================================

async function stageGeom(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const out: Record<string, unknown> = {}
  for (const id of ['misaligned', 'rot15', 'rot45', 'wave-sine', 'default']) {
    const bc = CONFIGS.find((c) => c.id === id)!
    const per: Record<string, unknown> = {}
    for (const backend of BACKENDS) {
      // bench probe: central differences of the node's own rib phase
      const gp = build('pre', bc.cfg, W / H)
      const bench = decodeSeamField(
        (await rig.run({
          backend, width: W, height: H, dpr: bc.dpr,
          passes: seamProbePasses(gp, W, H, SEAM_RANGE_PX),
          images: { [gp.imageSampler]: stimuli.get(bc.stimulus)! },
        })).image, SEAM_RANGE_PX)
      // node probe: the shipped node's own analytic rg_ss / rg_n
      const node = decodeSeamField(
        await render(rig, stimuli, bc, 'shipped', 'SEAMPROBE', backend), SEAM_RANGE_PX)

      // The bench probe offsets in fragCoord space, which is y-DOWN on WebGPU and
      // y-UP on WebGL2, so its normal's y flips between backends. The node's
      // rg_n is always y-UP (it is consumed as gl_FragCoord + n, and negated in
      // the WGSL emission). Compare like with like.
      const flipY = backend === 'webgpu' ? -1 : 1
      let nDist = 0
      let nNx = 0
      let nNy = 0
      let cnt = 0
      let mDist = 0
      let mNx = 0
      let mNy = 0
      for (let i = 0; i < W * H; i++) {
        const y = Math.floor(i / W); const x = i % W
        if (x < 20 || y < 20 || x >= W - 20 || y >= H - 20) continue
        // only where the bench probe is unsaturated (a real seam is nearby)
        if (Math.abs(bench.dist[i]) > 4) continue
        const dd = Math.abs(node.dist[i] - bench.dist[i])
        const dx = Math.abs(node.nx[i] - bench.nx[i])
        const dy = Math.abs(node.ny[i] * flipY - bench.ny[i])
        nDist += dd; nNx += dx; nNy += dy; cnt++
        if (dd > mDist) mDist = dd
        if (dx > mNx) mNx = dx
        if (dy > mNy) mNy = dy
      }
      per[backend] = cnt === 0 ? { n: 0 } : {
        n: cnt,
        signedDistPx: { mean: nDist / cnt, max: mDist },
        normalX: { mean: nNx / cnt, max: mNx },
        normalY: { mean: nNy / cnt, max: mNy },
        note: 'normal components are quantised to 1/127.5 by the 8-bit probe encoding',
      }
    }
    out[id] = per
    console.log(`geom ${id}: ${JSON.stringify(out[id])}`)
  }
  results.geom = out
}

// ===========================================================================
// stage: stair — the published staircase metric
// ===========================================================================

const STAIR_TARGETS = ['stair-rot0', 'stair-rot7', 'stair-noise', 'stair-circular']
const PUBLISHED_STAIR: Record<string, Record<string, { webgpu: number | null; webgl2: number | null }>> = {
  'stair-rot0': { A0: { webgpu: 0, webgl2: 0 }, A4: { webgpu: 0, webgl2: 0 }, A8: { webgpu: 0, webgl2: 0 } },
  'stair-rot7': {
    A0: { webgpu: 0.25932222100953733, webgl2: 0.2582654216899757 },
    A4: { webgpu: 0.09273574757577228, webgl2: 0.08973546738705585 },
    A8: { webgpu: 0.08642816864576855, webgl2: 0.08320175189156274 },
  },
  'stair-noise': {
    A0: { webgpu: 0.26892345697927017, webgl2: 0.26790610644084417 },
    A4: { webgpu: 0.059956979213609145, webgl2: 0.05520793815754734 },
    A8: { webgpu: 0.05463273596364738, webgl2: 0.049311840014671635 },
  },
  'stair-circular': {
    A0: { webgpu: 0.2684602387763562, webgl2: 0.2674212849105039 },
    A4: { webgpu: null, webgl2: null },
    A8: { webgpu: 0.06100668934406514, webgl2: 0.05635660907559467 },
  },
}

/** phase10-reed-aa.ts#floorConfig — the estimator's own noise floor */
function floorConfig(bc: BenchConfig): BenchConfig {
  return { ...bc, id: `${bc.id}__floor`, cfg: { ...bc.cfg, srt_rotate: 0, ribType: 'straight' } }
}

async function stageStair(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  const out: Record<string, unknown> = {}
  const cols: Array<[string, Which, string]> = [
    ['PRE', 'pre', 'A0'], ['A4', 'pre', 'A4'], ['SHIPPED', 'shipped', 'A0'], ['GT', 'pre', 'A8'],
  ]
  for (const id of STAIR_TARGETS) {
    const bc = CONFIGS.find((c) => c.id === id)!
    const fbc = floorConfig(bc)
    const per: Record<string, unknown> = {}
    for (const backend of BACKENDS) {
      const gp = build('pre', bc.cfg, W / H)
      const field = decodeSeamField((await rig.run({
        backend, width: W, height: H, dpr: bc.dpr,
        passes: seamProbePasses(gp, W, H, SEAM_RANGE_PX),
        images: { [gp.imageSampler]: stimuli.get(bc.stimulus)! },
      })).image, SEAM_RANGE_PX)
      const gf = build('pre', fbc.cfg, W / H)
      const floorField = decodeSeamField((await rig.run({
        backend, width: W, height: H, dpr: fbc.dpr,
        passes: seamProbePasses(gf, W, H, SEAM_RANGE_PX),
        images: { [gf.imageSampler]: stimuli.get(fbc.stimulus)! },
      })).image, SEAM_RANGE_PX)

      const rows: Record<string, unknown> = {}
      for (const [col, which, cand] of cols) {
        const sc = staircase(await render(rig, stimuli, bc, which, cand, backend), field)
        const fl = staircase(await render(rig, stimuli, fbc, which, cand, backend), floorField)
        const valid = sc.valid && fl.valid
        rows[col] = {
          staircasePx: valid ? Math.sqrt(Math.max(sc.rmsPx ** 2 - fl.rmsPx ** 2, 0)) : null,
          rawPx: sc.rmsPx, floorPx: fl.rmsPx, n: sc.n, rejected: sc.rejected,
          valid, scanAxis: sc.scanAxis,
          published: PUBLISHED_STAIR[id]?.[col === 'PRE' ? 'A0' : col]?.[backend] ?? null,
        }
      }
      per[backend] = rows
    }
    out[id] = per
    console.log(`stair ${id}: ` + BACKENDS.map((b) => `${b} ` + cols.map(([c]) =>
      `${c}=${JSON.stringify((((per[b] as Record<string, { staircasePx: number | null }>)[c]).staircasePx))}`).join(' ')).join(' | '))
  }
  results.stair = out
}

// ===========================================================================
// stage: clamp — is `gm = max(gm, -0.75)` a no-op at the defaults, and is it
// enough to bound |delta| over the whole amplitude x wavelength range?
// ===========================================================================

const CLAMP_RE = /(rg_gm_\w+)\s*=\s*max\(\1,\s*-0\.75\);?/g

function stripClamp(src: string): { out: string; n: number } {
  let n = 0
  const out = src.replace(CLAMP_RE, () => { n++; return '' })
  return { out, n }
}

const AMPS = [0, 5, 10, 20, 32, 50, 80, 120, 160, 200]
const WLS = [10, 25, 50, 100, 150, 200, 300, 500, 1000]

async function stageClamp(rig: AaRig, stimuli: Map<StimulusId, Rgba8>): Promise<void> {
  // (i) structural: which rib types emit the clamp at all
  const structural: Record<string, { clampGlsl: number; clampWgsl: number; gmZero: boolean }> = {}
  const variants: Array<[string, ReedCfg]> = [
    ['straight', { ribType: 'straight' }],
    ...['sine', 'triangle', 'square', 'sawtooth', 'chevron', 'u_shape'].map(
      (s) => [`wave-${s}`, { ribType: 'wave' as const, waveShape: s }] as [string, ReedCfg]),
    ['circular', { ribType: 'circular' }],
    ...['simplex', 'value', 'worley'].map(
      (s) => [`noise-${s}`, { ribType: 'noise' as const, noiseType: s }] as [string, ReedCfg]),
  ]
  for (const [name, cfg] of variants) {
    const g = build('shipped', cfg, W / H)
    const last = g.passes[g.passes.length - 1]
    structural[name] = {
      clampGlsl: (last.glslFrag.match(CLAMP_RE) ?? []).length,
      clampWgsl: (last.wgsl.match(CLAMP_RE) ?? []).length,
      gmZero: /rg_gm_\w+(?::\s*f32)?\s*=\s*0\.0\s*;/.test(last.glslFrag),
    }
  }
  console.log('clamp structural:', JSON.stringify(structural))

  // (ii) numeric: max |delta| over the frame, with and without the clamp
  const sweep: Array<Record<string, unknown>> = []
  const PROBES: Array<[string, string]> = [
    ['clamped', 'DELTAPROBE'], ['unclamped', 'DELTAPROBE_NOCLAMP'],
    ['clampedAll', 'DELTAPROBE_ALL'], ['unclampedAll', 'DELTAPROBE_ALL_NOCLAMP'],
  ]
  for (const rib of ['circular', 'noise'] as const) {
    for (const amplitude of AMPS) {
      for (const wavelength of WLS) {
        const cfg: ReedCfg = { ribType: rib, noiseType: 'simplex', amplitude, wavelength, ribWidth: 73 }
        const bc: BenchConfig = { id: `${rib}-a${amplitude}-w${wavelength}`, cfg, dpr: 1, stimulus: 'photo' }
        const row: Record<string, unknown> = { rib, amplitude, wavelength }
        for (const [label, candId] of PROBES) {
          row[label] = decodeLogPx(await render(rig, stimuli, bc, 'shipped', candId, 'webgpu'))
        }
        sweep.push(row)
      }
    }
    const worst = sweep.filter((r) => r.rib === rib)
      .sort((a, b) => (b.unclamped as { max: number }).max - (a.unclamped as { max: number }).max)[0]
    console.log(`clamp sweep ${rib}: worst unclamped ${JSON.stringify(worst)}`)
  }
  const maxOf = (k: string, rib: string): number => Math.max(...sweep.filter((r) => r.rib === rib)
    .map((r) => (r[k] as { max: number }).max))
  const summary = {
    circular: {
      clamped: maxOf('clamped', 'circular'), unclamped: maxOf('unclamped', 'circular'),
      clampedAll: maxOf('clampedAll', 'circular'), unclampedAll: maxOf('unclampedAll', 'circular'),
    },
    noise: {
      clamped: maxOf('clamped', 'noise'), unclamped: maxOf('unclamped', 'noise'),
      clampedAll: maxOf('clampedAll', 'noise'), unclampedAll: maxOf('unclampedAll', 'noise'),
    },
  }
  console.log('clamp summary (max |delta| device px):', JSON.stringify(summary))
  results.clamp = { structural, amps: AMPS, wls: WLS, sweep, summary }
}

/** decode the 24-bit log2(1+px) encoding written by the delta probe */
function decodeLogPx(img: Rgba8): { max: number; mean: number; nSat: number } {
  let mx = 0
  let sum = 0
  let nSat = 0
  const n = img.width * img.height
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const q = img.data[o] + img.data[o + 1] * 256 + img.data[o + 2] * 65536
    if (q >= 16777215) nSat++
    const px = 2 ** ((q / 16777215) * 32) - 1
    sum += px
    if (px > mx) mx = px
  }
  return { max: mx, mean: sum / n, nSat }
}

void main()
