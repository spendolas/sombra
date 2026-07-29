/**
 * Phase 10b — Reeded Glass rib-edge antialiasing bake-off.
 *
 * Every candidate is a SOURCE REWRITE of the node's OWN emitted shader, on both
 * backends. Nothing about `reedLens`, the SRT, the rib wave field, the
 * `emitScreenDelta` gradient inverse, the y-flip on `sampleUV` or the
 * premultiplied frost accumulation is reimplemented here: the bench splits the
 * compiler's output at the entry point, turns the body into a callable
 * `sombra_inner(fragCoord, uv)`, and drives it at sub-pixel offsets. A candidate
 * therefore CANNOT drift from the node — if the node changes, the candidate
 * changes with it.
 *
 * The two things the bench does synthesise are both derived from the node's own
 * variables, not from a paraphrase of them:
 *   - `sombra_phi()` is the same body truncated at `rg_wm_scr_*`, returning
 *     `rg_wm_scr_* / rg_ribUV_scr_*` — the real rib index. Truncating at the
 *     pre-fold, pre-`mod` quantity is required: phase-10a measured that
 *     differentiating `rg_sampleUV` returns the 52.6 px JUMP instead of the
 *     0.5 px slope, and only on ~50% of sub-pixel phases.
 *   - `sombraTapRaw()` wraps the one texture call so fetches per fragment are
 *     MEASURED, not asserted.
 *
 * No hardware derivative is used anywhere (no `fwidth`/`dFdx`/`dpdx`): the rib
 * rate comes from finite differences of `sombra_phi` in screen space, at uniform
 * control flow, which sidesteps the WGSL `derivative_uniformity` rule entirely
 * and needs no mechanical-translation rule that does not exist.
 *
 *   npx tsx scripts/blur-bakeoff/phase10-reed-aa.ts --validate   (default)
 *   npx tsx scripts/blur-bakeoff/phase10-reed-aa.ts --sweep
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'
import type { NodeData, EdgeData } from '../../src/nodes/types'
import { createAaRig, type AaRig, type AaPass, type Backend } from './phase10-aa-rig'
import type { Rgba8 } from './lib/image'
import { encodePng } from './lib/png'
import {
  maskedDiff, globalFidelity, decodeSeamField, seamBand, maskFraction,
  staircase, temporalCrawl, syntheticObliqueEdge, offsetCodes, boxBlur3,
  seamSpacing, maskCount,
  type SeamField,
} from './lib/edge-metrics'

const REPO = process.cwd()
const OUT_DIR = path.join(REPO, 'reports', 'blur-bakeoff', 'phase10')
const PNG_DIR = path.join(OUT_DIR, 'aa')

/** Probe encodes signed seam distance over +-SEAM_RANGE_PX. */
const SEAM_RANGE_PX = 8
/** Half-width of the seam band the roughness metric is restricted to. */
const SEAM_BAND_PX = 3
/** Frame margin excluded from every masked statistic (clamp-to-edge fringe). */
const MASK_MARGIN = 12
/** Ground-truth supersample factor: GT_SS x GT_SS box per fragment. */
const GT_SS = 16

// ===========================================================================
// Graph construction — the real compiler, both backends, one call
// ===========================================================================

export interface ReedCfg {
  ribWidth?: number
  ior?: number
  curvature?: number
  bow?: number
  frost?: number
  direction?: 'vertical' | 'horizontal'
  ribType?: 'straight' | 'wave' | 'circular' | 'noise'
  waveShape?: string
  noiseType?: string
  amplitude?: number
  wavelength?: number
  srt_scale?: number
  srt_rotate?: number
  srt_translateX?: number
  srt_translateY?: number
}

export interface BuiltGraph {
  passes: AaPass[]
  imageSampler: string
  /** sampler through which the final pass reads the intermediate */
  texSampler: string
}

let nodesReady = false
function initNodes(): void {
  if (!nodesReady) { initializeNodeLibrary(); nodesReady = true }
}

const IMAGE_SAMPLER = 'u_img_image'

/**
 * `image -> reeded_glass -> fragment_output`, compiled through BOTH real
 * compilers. imageAspect must equal the stimulus aspect or the image node's
 * contain-fit rescales and the identity controls stop being identities.
 */
export function buildGraph(
  cfg: ReedCfg,
  imageAspect: number,
  opts?: { bypass?: boolean; imageTranslateX?: number },
): BuiltGraph {
  initNodes()
  const nodes: Node<NodeData>[] = [
    {
      id: 'img', type: 'shaderNode', position: { x: 0, y: 0 },
      data: {
        type: 'image',
        params: {
          imageData: 'x', imageAspect, fitMode: 'contain',
          srt_translateX: opts?.imageTranslateX ?? 0,
        },
      },
    },
    { id: 'rg', type: 'shaderNode', position: { x: 1, y: 0 }, data: { type: 'reeded_glass', params: { ...cfg } as Record<string, unknown> } },
    { id: 'out', type: 'shaderNode', position: { x: 2, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ]
  const edge = (s: string, t: string, sh: string, th: string): Edge<EdgeData> => ({
    id: `${s}-${sh}-${t}-${th}`, source: s, target: t, sourceHandle: sh, targetHandle: th,
    type: 'typed', data: { sourcePort: sh, targetPort: th, sourcePortType: 'color' },
  })
  const edges: Edge<EdgeData>[] = opts?.bypass
    ? [edge('img', 'out', 'color', 'color')]
    : [edge('img', 'rg', 'color', 'source'), edge('rg', 'out', 'color', 'color')]
  const useNodes = opts?.bypass ? [nodes[0], nodes[2]] : nodes

  const glsl = compileGraph(useNodes, edges)
  if (!glsl.success) throw new Error(`GLSL compile failed: ${glsl.errors.map((e) => e.message).join('; ')}`)
  const ir = compileGraphIR(useNodes, edges)
  if (!ir) throw new Error('IR compile returned null')
  if (ir.passes.length !== glsl.passes.length) {
    throw new Error(`pass count mismatch: glsl ${glsl.passes.length} vs wgsl ${ir.passes.length}`)
  }

  const passes: AaPass[] = ir.passes.map((p, i) => ({
    wgsl: p.shaderCode,
    glslFrag: glsl.passes[i].fragmentShader,
    glslVert: glsl.passes[i].vertexShader,
    uniformOffsets: Object.fromEntries(p.uniformLayout.offsets),
    uniformTotalSize: p.uniformLayout.totalSize,
    textureBindings: p.textureBindings,
    inputTextures: p.inputTextures,
    userUniforms: glsl.passes[i].userUniforms.map((u) => ({ name: u.name, glslType: u.glslType, value: u.value })),
    filter: p.textureFilter,
  }))

  const last = passes[passes.length - 1]
  const texSampler = last.inputTextures[0]?.samplerName ?? IMAGE_SAMPLER
  return { passes, imageSampler: IMAGE_SAMPLER, texSampler }
}

// ===========================================================================
// Shader surgery
// ===========================================================================

interface Split {
  prelude: string
  bodyLines: string[]
  wmVar: string
  ribVar: string
  /** last body line index needed to have `wmVar` in scope */
  cutIdx: number
}

const WGSL_SIG = /@fragment\s+fn\s+fs_main\s*\(\s*in\s*:\s*VertexOutput\s*\)\s*->\s*@location\(0\)\s*vec4f\s*\{/
const GLSL_SIG = /void\s+main\s*\(\s*\)\s*\{/

function splitShader(code: string, kind: 'wgsl' | 'glsl'): Split {
  const sig = kind === 'wgsl' ? WGSL_SIG : GLSL_SIG
  const m = sig.exec(code)
  if (!m) throw new Error(`phase10-reed-aa: ${kind} entry point not found — compiler output shape changed`)
  const prelude = code.slice(0, m.index)
  const rest = code.slice(m.index + m[0].length)
  const close = rest.lastIndexOf('}')
  if (close < 0) throw new Error(`phase10-reed-aa: ${kind} entry has no closing brace`)
  const bodyLines = rest.slice(0, close).replace(/\s+$/, '').split('\n')

  const wmRe = kind === 'wgsl'
    ? /^\s*(?:var|let)\s+(rg_wm_scr_\w+)\s*(?::|=)/
    : /^\s*float\s+(rg_wm_scr_\w+)\s*=/
  let wmVar = ''
  let cutIdx = -1
  for (let i = 0; i < bodyLines.length; i++) {
    const mm = wmRe.exec(bodyLines[i])
    if (mm) { wmVar = mm[1]; cutIdx = i; break }
  }
  if (cutIdx < 0) throw new Error(`phase10-reed-aa: ${kind} — rg_wm_scr_* declaration not found`)
  const ribVar = wmVar.replace('rg_wm_scr_', 'rg_ribUV_scr_')
  const before = bodyLines.slice(0, cutIdx + 1).join('\n')
  if (!before.includes(ribVar)) {
    throw new Error(`phase10-reed-aa: ${ribVar} is not in scope at the truncation point`)
  }
  return { prelude, bodyLines, wmVar, ribVar, cutIdx }
}

/** GLSL body -> parameterised function body. */
function glslBody(lines: string[]): string {
  return lines.join('\n')
    .replace(/\bgl_FragCoord\b/g, 'sombraFC')
    .replace(/\bv_uv\b/g, 'sombraUV')
    .replace(/\bfragColor\s*=/g, 'return')
}

interface Lang {
  kind: 'wgsl' | 'glsl'
  at(off: string): string
  phi(off: string): string
  v2(x: string, y: string): string
  v4z: string
  letf(n: string, e: string): string
  letv2(n: string, e: string): string
  varv4(n: string, e: string): string
  declv4(n: string): string
  assign(n: string, e: string): string
  addTo(n: string, e: string): string
  loop(v: string, n: number, body: string): string
  fi(v: string): string
  pos: string
  out(e: string): string
  fnum(n: number): string
}

function makeLang(kind: 'wgsl' | 'glsl'): Lang {
  const fnum = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)
  if (kind === 'wgsl') {
    return {
      kind, fnum,
      at: (o) => `sombra_at(in, ${o})`,
      phi: (o) => `sombra_phi(in, ${o})`,
      v2: (x, y) => `vec2f(${x}, ${y})`,
      v4z: 'vec4f(0.0)',
      letf: (n, e) => `let ${n}: f32 = ${e};`,
      letv2: (n, e) => `let ${n}: vec2f = ${e};`,
      varv4: (n, e) => `var ${n}: vec4f = ${e};`,
      declv4: (n) => `var ${n}: vec4f;`,
      assign: (n, e) => `${n} = ${e};`,
      addTo: (n, e) => `${n} = ${n} + ${e};`,
      loop: (v, n, body) => `for (var ${v}: i32 = 0; ${v} < ${n}; ${v}++) {\n${body}\n  }`,
      fi: (v) => `f32(${v})`,
      pos: 'in.position.xy',
      out: (e) => `return ${e};`,
    }
  }
  return {
    kind, fnum,
    at: (o) => `sombra_at(gl_FragCoord, v_uv, ${o})`,
    phi: (o) => `sombra_phi(gl_FragCoord, v_uv, ${o})`,
    v2: (x, y) => `vec2(${x}, ${y})`,
    v4z: 'vec4(0.0)',
    letf: (n, e) => `float ${n} = ${e};`,
    letv2: (n, e) => `vec2 ${n} = ${e};`,
    varv4: (n, e) => `vec4 ${n} = ${e};`,
    declv4: (n) => `vec4 ${n};`,
    assign: (n, e) => `${n} = ${e};`,
    addTo: (n, e) => `${n} += ${e};`,
    loop: (v, n, body) => `for (int ${v} = 0; ${v} < ${n}; ${v}++) {\n${body}\n  }`,
    fi: (v) => `float(${v})`,
    pos: 'gl_FragCoord.xy',
    out: (e) => `fragColor = ${e};`,
  }
}

/** Assemble a rewritten final-pass shader from a candidate's main body. */
function assemble(split: Split, kind: 'wgsl' | 'glsl', w: number, h: number, mainBody: string): string {
  const W = w.toFixed(1)
  const H = h.toFixed(1)
  const body = split.bodyLines.join('\n')
  const cut = split.bodyLines.slice(0, split.cutIdx + 1).join('\n')
  if (kind === 'wgsl') {
    return `${split.prelude}
fn sombra_inner(in: VertexOutput) -> vec4f {
${body}
}

fn sombra_mk(base: VertexOutput, off: vec2f) -> VertexOutput {
  var s: VertexOutput;
  s.position = vec4f(base.position.x + off.x, base.position.y + off.y, base.position.z, base.position.w);
  // v_uv is y-UP while @builtin(position) is y-DOWN, so the y offset inverts.
  s.v_uv = vec2f(base.v_uv.x + off.x / ${W}, base.v_uv.y - off.y / ${H});
  return s;
}

fn sombra_at(base: VertexOutput, off: vec2f) -> vec4f { return sombra_inner(sombra_mk(base, off)); }

fn sombra_phi_i(in: VertexOutput) -> f32 {
${cut}
  return ${split.wmVar} / ${split.ribVar};
}

fn sombra_phi(base: VertexOutput, off: vec2f) -> f32 { return sombra_phi_i(sombra_mk(base, off)); }

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
${mainBody}
}
`
  }
  return `${split.prelude}
vec4 sombra_inner(vec4 sombraFC, vec2 sombraUV) {
${glslBody(split.bodyLines)}
}

vec4 sombra_at(vec4 fc, vec2 uv, vec2 off) {
  // gl_FragCoord and v_uv are both y-UP in GLSL, so both offsets add.
  return sombra_inner(vec4(fc.x + off.x, fc.y + off.y, fc.z, fc.w), vec2(uv.x + off.x / ${W}, uv.y + off.y / ${H}));
}

float sombra_phi_i(vec4 sombraFC, vec2 sombraUV) {
${glslBody(split.bodyLines.slice(0, split.cutIdx + 1))}
  return ${split.wmVar} / ${split.ribVar};
}

float sombra_phi(vec4 fc, vec2 uv, vec2 off) {
  return sombra_phi_i(vec4(fc.x + off.x, fc.y + off.y, fc.z, fc.w), vec2(uv.x + off.x / ${W}, uv.y + off.y / ${H}));
}

void main() {
${mainBody}
}
`
}

/** Central-difference rib rate + seam position, no hardware derivatives. */
function gradPreamble(L: Lang): string {
  return [
    L.letf('sg_px', L.phi(L.v2('0.5', '0.0'))),
    L.letf('sg_mx', L.phi(L.v2('-0.5', '0.0'))),
    L.letf('sg_py', L.phi(L.v2('0.0', '0.5'))),
    L.letf('sg_my', L.phi(L.v2('0.0', '-0.5'))),
    L.letf('sg_gx', 'sg_px - sg_mx'),
    L.letf('sg_gy', 'sg_py - sg_my'),
    L.letf('sg_l', 'max(sqrt(sg_gx * sg_gx + sg_gy * sg_gy), 1e-9)'),
    L.letv2('sg_g', L.v2('sg_gx / sg_l', 'sg_gy / sg_l')),
    // support of a unit pixel projected on the seam normal
    L.letf('sg_w', 'abs(sg_g.x) + abs(sg_g.y)'),
    L.letf('sg_phi', L.phi(L.v2('0.0', '0.0'))),
    // signed offset from the pixel centre to the seam, along +sg_g, in px
    L.letf('sg_s', '(floor(sg_phi + 0.5) - sg_phi) / sg_l'),
  ].map((s) => '  ' + s).join('\n')
}

// ===========================================================================
// Candidates
// ===========================================================================

export interface CandidateCtx {
  /** frost radius in device px, as the node computes it: frost * 24 * u_dpr */
  frostRadiusPx: number
  /** rib period along the seam normal, device px */
  periodPx: number
}

export interface Candidate {
  id: string
  label: string
  /** taps per fragment the design intends (measured separately) */
  nominalFetches: number
  /** shader-level candidate: produce { setup, expr } given a language */
  build?: (L: Lang, ctx: CandidateCtx) => { setup: string; expr: string }
  /** prelude patch applied before splitting (A6 only) */
  patchPrelude?: (src: string, kind: 'wgsl' | 'glsl', ctx: CandidateCtx) => string
  /** runner-level candidate: render the whole plan at k x and box-down */
  renderScale?: number
  /** A0 only: run the compiler's shader completely untouched */
  raw?: boolean
  notes?: string
}

const RGSS4: Array<[number, number]> = [[-0.125, -0.375], [0.375, -0.125], [-0.375, 0.125], [0.125, 0.375]]
const OGSS4: Array<[number, number]> = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]

function fixedPattern(L: Lang, offs: Array<[number, number]>): { setup: string; expr: string } {
  const terms = offs.map(([x, y]) => L.at(L.v2(L.fnum(x), L.fnum(y))))
  const setup = `  ${L.varv4('sg_acc', terms.join('\n    + '))}`
  return { setup, expr: `sg_acc * ${L.fnum(1 / offs.length)}` }
}

function box1d(L: Lang, k: number, jitter: boolean): { setup: string; expr: string } {
  const u = jitter ? 'sg_u' : '0.5'
  const pre = jitter
    ? [
      L.letv2('sg_r', `reedHash(floor(${L.pos}) + ${L.v2('0.5', '0.5')})`),
      L.letf('sg_u', 'sg_r.x * 0.5 + 0.5'),
    ].map((s) => '  ' + s).join('\n') + '\n'
    : ''
  const inner = [
    `    ${L.letf('sg_t', `((${L.fi('sg_j')} + ${u}) / ${L.fnum(k)} - 0.5) * sg_w`)}`,
    `    ${L.addTo('sg_acc', L.at('sg_g * sg_t'))}`,
  ].join('\n')
  const setup = [
    gradPreamble(L),
    pre.trimEnd(),
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_j', k, inner),
  ].filter(Boolean).join('\n')
  return { setup, expr: `sg_acc * ${L.fnum(1 / k)}` }
}

function boxGrid(L: Lang, k: number): { setup: string; expr: string } {
  const inner = [
    `      ${L.letf('sg_ox', `(${L.fi('sg_x')} + 0.5) / ${L.fnum(k)} - 0.5`)}`,
    `      ${L.letf('sg_oy', `(${L.fi('sg_y')} + 0.5) / ${L.fnum(k)} - 0.5`)}`,
    `      ${L.addTo('sg_acc', L.at(L.v2('sg_ox', 'sg_oy')))}`,
  ].join('\n')
  const setup = [
    `  ${L.varv4('sg_acc', L.v4z)}`,
    '  ' + L.loop('sg_y', k, '  ' + L.loop('sg_x', k, inner)),
  ].join('\n')
  return { setup, expr: `sg_acc * ${L.fnum(1 / (k * k))}` }
}

export const CANDIDATES: Candidate[] = [
  {
    id: 'A0', label: 'control — 1 bilinear tap (ships today)', nominalFetches: 1, raw: true,
  },
  {
    id: 'A0w', label: 'transform-fidelity control — wrapper at zero offset', nominalFetches: 1,
    build: (L) => ({ setup: '', expr: L.at(L.v2('0.0', '0.0')) }),
    notes: 'must be byte-identical to A0; proves the source surgery is inert',
  },
  ...[2, 3, 4, 8].map((k) => ({
    id: `A1-${k}`, label: `1-D box supersample along the seam normal, K=${k}`, nominalFetches: k,
    build: (L: Lang) => box1d(L, k, false),
  })),
  ...[4, 8].map((k) => ({
    id: `A2-${k}`, label: `adaptive 1-D box, K=${k} within 1 px of a seam else 1 tap`, nominalFetches: k,
    build: (L: Lang) => {
      const setup = [
        gradPreamble(L),
        `  ${L.declv4('sg_col')}`,
        `  if (abs(sg_s) < sg_w * 0.5 + 0.5) {`,
        `  ${L.varv4('sg_acc', L.v4z)}`,
        '  ' + L.loop('sg_j', k, [
          `    ${L.letf('sg_t', `((${L.fi('sg_j')} + 0.5) / ${L.fnum(k)} - 0.5) * sg_w`)}`,
          `    ${L.addTo('sg_acc', L.at('sg_g * sg_t'))}`,
        ].join('\n')),
        `  ${L.assign('sg_col', `sg_acc * ${L.fnum(1 / k)}`)}`,
        `  } else {`,
        `  ${L.assign('sg_col', L.at(L.v2('0.0', '0.0')))}`,
        `  }`,
      ].join('\n')
      return { setup, expr: 'sg_col' }
    },
  })),
  {
    id: 'A3', label: '2x2 rotated-grid supersample (RGSS 4-rook)', nominalFetches: 4,
    build: (L) => fixedPattern(L, RGSS4),
  },
  {
    id: 'A3o', label: '2x2 ordered-grid supersample (OGSS)', nominalFetches: 4,
    build: (L) => fixedPattern(L, OGSS4),
  },
  {
    id: 'A4', label: 'analytic seam coverage — 2 taps at the seam, 1 elsewhere', nominalFetches: 2,
    build: (L) => {
      const setup = [
        gradPreamble(L),
        `  ${L.letf('sg_h', 'sg_w * 0.5')}`,
        `  ${L.declv4('sg_col')}`,
        `  if (sg_s > -sg_h && sg_s < sg_h) {`,
        // exact 1-D coverage of the two sides of the step across the pixel,
        // each sampled at the centroid of its own sub-interval
        `    ${L.letf('sg_la', 'sg_s + sg_h')}`,
        `    ${L.letf('sg_lb', 'sg_h - sg_s')}`,
        `    ${L.letf('sg_ca', '(sg_s - sg_h) * 0.5')}`,
        `    ${L.letf('sg_cb', '(sg_s + sg_h) * 0.5')}`,
        `    ${L.assign('sg_col', `(${L.at('sg_g * sg_ca')} * sg_la + ${L.at('sg_g * sg_cb')} * sg_lb) / sg_w`)}`,
        `  } else {`,
        `    ${L.assign('sg_col', L.at(L.v2('0.0', '0.0')))}`,
        `  }`,
      ].join('\n')
      return { setup, expr: 'sg_col' }
    },
  },
  ...[4, 8].map((k) => ({
    id: `A5-${k}`, label: `jittered stratified 1-D along the seam normal, K=${k}`, nominalFetches: k,
    build: (L: Lang) => box1d(L, k, true),
    notes: 'per-fragment hash seed, NOT the frost 4-device-px lattice',
  })),
  {
    id: 'A6', label: 'coordinate taper — displacement faded to 0 within 1 px of the seam', nominalFetches: 1,
    build: (L) => ({ setup: '', expr: L.at(L.v2('0.0', '0.0')) }),
    patchPrelude: (src, kind, ctx) => patchTaper(src, kind, 1.0 / Math.max(ctx.periodPx, 1e-6)),
    notes: 'the smoothFract / Paper-Design family; expected to lose, kept as the known-bad for global fidelity',
  },
  {
    id: 'A7-2', label: 'engine change — render the pass at 2x and box-downsample', nominalFetches: 4,
    renderScale: 2, raw: true,
    notes: 'needs RenderPass.resolution, which does not exist; pass 0 also renders at 2x',
  },
  ...[8, 16, 24].map((n) => ({
    id: `A9-${n}`, label: `screen-space shared gather (AA + frost unified), N=${n}`, nominalFetches: n,
    build: (L: Lang, ctx: CandidateCtx) => {
      const R = Math.max(ctx.frostRadiusPx, 0.7)
      const inner = [
        `    ${L.letf('sg_a', `(${L.fi('sg_j')} + 0.5) / ${L.fnum(n)}`)}`,
        `    ${L.letf('sg_rad', `${L.fnum(R)} * sqrt(sg_a)`)}`,
        `    ${L.letf('sg_ang', `${L.fi('sg_j')} * 2.39996323 + sg_u * 6.28318531`)}`,
        `    ${L.addTo('sg_acc', L.at(`${L.v2('cos(sg_ang)', 'sin(sg_ang)')} * sg_rad`))}`,
      ].join('\n')
      const setup = [
        `  ${L.letv2('sg_r', `reedHash(floor(${L.pos}) + ${L.v2('0.5', '0.5')})`)}`,
        `  ${L.letf('sg_u', 'sg_r.x * 0.5 + 0.5')}`,
        `  ${L.varv4('sg_acc', L.v4z)}`,
        '  ' + L.loop('sg_j', n, inner),
      ].join('\n')
      return { setup, expr: `sg_acc * ${L.fnum(1 / n)}` }
    },
    notes: 'node compiled with frost=0; the gather taps ARE the supersamples. radius floored at 0.7 px so it still antialiases at frost 0',
  })),
  {
    id: 'A8', label: `GROUND TRUTH — ${GT_SS}x${GT_SS} box supersample`, nominalFetches: GT_SS * GT_SS,
    build: (L) => boxGrid(L, GT_SS),
  },
]

export const CANDIDATE_BY_ID: Record<string, Candidate> =
  Object.fromEntries(CANDIDATES.map((c) => [c.id, c]))

/**
 * A6: taper the refraction displacement to zero within `taperLocal` (a fraction
 * of a rib) of each seam. Patches the node's OWN `reedLens`, by adding a fifth
 * parameter and threading it from the screen-space call site only — the
 * frozen-ref call (which drives the `coords` output) is left at 0.
 */
function patchTaper(src: string, kind: 'wgsl' | 'glsl', taperLocal: number): string {
  const sigRe = kind === 'wgsl'
    ? /fn reedLens\(coord: f32, ribW: f32, ior: f32, curvature: f32\) -> vec2f \{/
    : /vec2 reedLens\(float coord, float ribW, float ior, float curvature\) \{/
  if (!sigRe.test(src)) throw new Error('A6: reedLens signature not found')
  const newSig = kind === 'wgsl'
    ? 'fn reedLens(coord: f32, ribW: f32, ior: f32, curvature: f32, taperLocal: f32) -> vec2f {'
    : 'vec2 reedLens(float coord, float ribW, float ior, float curvature, float taperLocal) {'
  let out = src.replace(sigRe, newSig)

  const dispRe = kind === 'wgsl'
    ? /(var disp: f32 = -slope \* \(ior - 1\.0\) \* 0\.5 \* amp;)/
    : /(float disp = -slope \* \(ior - 1\.0\) \* 0\.5 \* amp;)/
  if (!dispRe.test(out)) throw new Error('A6: disp line not found')
  out = out.replace(dispRe, `$1\n  disp = disp * smoothstep(0.0, max(taperLocal, 1e-6), min(local, 1.0 - local));`)

  // Thread the argument at both call sites: 0 for the frozen-ref lens, the
  // real taper for the screen-space one.
  let screenPatched = 0
  let refPatched = 0
  out = out.split('\n').map((line) => {
    if (!line.includes('reedLens(')) return line
    if (/reedLens\(\s*rg_wm_scr_/.test(line)) { screenPatched++; return line.replace(/\);\s*$/, `, ${taperLocal.toPrecision(8)});`) }
    if (/reedLens\(\s*rg_wm_(?!scr_)/.test(line)) { refPatched++; return line.replace(/\);\s*$/, ', 0.0);') }
    return line
  }).join('\n')
  if (screenPatched !== 1 || refPatched !== 1) {
    throw new Error(`A6: expected 1 screen + 1 ref reedLens call site, patched ${screenPatched} + ${refPatched}`)
  }
  return out
}

// ===========================================================================
// Fetch-count instrumentation — measured, not asserted
// ===========================================================================

/**
 * Route every texture read through a counting wrapper and return the count
 * instead of the colour. `broken: true` omits the increment — the KNOWN-BAD the
 * cost gate has to be able to see.
 */
function instrumentCount(src: string, kind: 'wgsl' | 'glsl', sampler: string, broken: boolean): string {
  const inc = broken ? '' : (kind === 'wgsl' ? '  sombraTaps = sombraTaps + 1.0;\n' : '  sombraTaps += 1.0;\n')
  if (kind === 'wgsl') {
    const callRe = new RegExp(`textureSampleLevel\\(\\s*${sampler}_tex\\s*,\\s*${sampler}_samp\\s*,\\s*`, 'g')
    const n = (src.match(callRe) ?? []).length
    if (n === 0) throw new Error('instrumentCount: no WGSL texture call found')
    let out = src.replace(callRe, 'sombraTapRaw(')
    const helper = `
var<private> sombraTaps: f32 = 0.0;
fn sombraTapRaw(uv: vec2f, lod: f32) -> vec4f {
${inc}  return textureSampleLevel(${sampler}_tex, ${sampler}_samp, uv, lod);
}
`
    const anchor = out.indexOf('struct VertexOutput')
    if (anchor < 0) throw new Error('instrumentCount: WGSL VertexOutput anchor not found')
    out = out.slice(0, anchor) + helper + '\n' + out.slice(anchor)
    // final return -> encoded count (the colour is kept numerically live)
    const lastRet = out.lastIndexOf('return ')
    const end = out.indexOf(';', lastRet)
    const expr = out.slice(lastRet + 7, end)
    const enc = `let sombra_c: vec4f = ${expr};
  let sc_n: u32 = u32(sombraTaps + 0.5);
  return vec4f(f32(sc_n & 255u) / 255.0, f32((sc_n >> 8u) & 255u) / 255.0, sombra_c.r * 1e-7, 1.0)`
    return out.slice(0, lastRet) + enc + out.slice(end)
  }
  const callRe = new RegExp(`texture\\(\\s*${sampler}\\s*,\\s*`, 'g')
  const n = (src.match(callRe) ?? []).length
  if (n === 0) throw new Error('instrumentCount: no GLSL texture call found')
  let out = src.replace(callRe, 'sombraTapRaw(')
  const helper = `
float sombraTaps = 0.0;
vec4 sombraTapRaw(vec2 uv) {
${inc}  return texture(${sampler}, uv);
}
`
  const anchor = out.indexOf(`uniform sampler2D ${sampler};`)
  if (anchor < 0) throw new Error('instrumentCount: GLSL sampler declaration not found')
  const after = out.indexOf('\n', anchor) + 1
  out = out.slice(0, after) + helper + out.slice(after)
  // reset at the top of main (globals are per-invocation, but be explicit)
  out = out.replace(GLSL_SIG, (m) => `${m}\n  sombraTaps = 0.0;`)
  const lastAssign = out.lastIndexOf('fragColor = ')
  const end = out.indexOf(';', lastAssign)
  const expr = out.slice(lastAssign + 12, end)
  const enc = `vec4 sombra_c = ${expr};
  int sc_n = int(sombraTaps + 0.5);
  fragColor = vec4(float(sc_n & 255) / 255.0, float((sc_n >> 8) & 255) / 255.0, sombra_c.r * 1e-7, 1.0)`
  return out.slice(0, lastAssign) + enc + out.slice(end)
}

function decodeCount(img: Rgba8, mask?: Uint8Array | null): { mean: number; min: number; max: number } {
  const np = img.width * img.height
  let sum = 0
  let n = 0
  let mn = Infinity
  let mx = -Infinity
  for (let i = 0; i < np; i++) {
    if (mask && !mask[i]) continue
    const o = i * 4
    const c = img.data[o] + img.data[o + 1] * 256
    sum += c; n++
    if (c < mn) mn = c
    if (c > mx) mx = c
  }
  return n === 0 ? { mean: 0, min: 0, max: 0 } : { mean: sum / n, min: mn, max: mx }
}

// ===========================================================================
// Pass construction for a candidate / for the seam probe
// ===========================================================================

/**
 * 'no-minif' forces the node's internal minification supersample OFF, leaving its
 * colour pipeline (linear light, dither, premultiply) intact.
 *
 * That combination is the only valid reference for tap-count experiments.
 * ('pre','A8') is wrong because PRE averages in sRGB while the shipped node averages
 * in linear light, so they disagree by construction. ('shipped','A8') is wrong the
 * other way: supersampling a shader that already self-filters converges on its OWN
 * blur, not on the truth. ('shipped','A8','no-minif') converges on the true image in
 * the shipped colour space, which is what a tap count should be scored against.
 */
export type ShaderMode = 'color' | 'count' | 'count-broken' | 'no-minif'

export function candidatePasses(
  g: BuiltGraph, cand: Candidate, w: number, h: number, ctx: CandidateCtx, mode: ShaderMode = 'color',
): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]

  const make = (kind: 'wgsl' | 'glsl', src0: string): string => {
    let src = src0
    if (cand.patchPrelude) src = cand.patchPrelude(src, kind, ctx)
    if (!cand.raw && cand.build) {
      const L = makeLang(kind)
      const { setup, expr } = cand.build(L, ctx)
      const split = splitShader(src, kind)
      src = assemble(split, kind, w, h, `${setup}\n  ${L.out(expr)}`)
    }
    if (mode === 'no-minif') {
      // `} else if (rg_nt_<id> > 1.0) {` -> never taken. Compiles on both backends.
      const before = src
      src = src.replace(/rg_nt_\w+ > 1\.0/g, 'false')
      if (src === before) throw new Error("no-minif: the minification guard was not found — emitted shape changed")
    } else if (mode !== 'color') {
      src = instrumentCount(src, kind, g.texSampler, mode === 'count-broken')
    }
    return src
  }

  last.wgsl = make('wgsl', last.wgsl)
  last.glslFrag = make('glsl', last.glslFrag)
  return passes
}

/** A pass that returns the signed seam distance and the seam normal. */
export function seamProbePasses(g: BuiltGraph, w: number, h: number, rangePx = SEAM_RANGE_PX): AaPass[] {
  const passes = g.passes.map((p) => ({ ...p }))
  const last = passes[passes.length - 1]
  const build = (kind: 'wgsl' | 'glsl', src: string): string => {
    const L = makeLang(kind)
    const split = splitShader(src, kind)
    const body = [
      gradPreamble(L),
      `  ${L.letf('sg_v', `clamp(sg_s / ${L.fnum(2 * rangePx)} + 0.5, 0.0, 1.0)`)}`,
      `  ${L.out(kind === 'wgsl'
        ? 'vec4f(sg_v, sg_g.x * 0.5 + 0.5, sg_g.y * 0.5 + 0.5, 1.0)'
        : 'vec4(sg_v, sg_g.x * 0.5 + 0.5, sg_g.y * 0.5 + 0.5, 1.0)')}`,
    ].join('\n')
    return assemble(split, kind, w, h, body)
  }
  last.wgsl = build('wgsl', last.wgsl)
  last.glslFrag = build('glsl', last.glslFrag)
  return passes
}

// ===========================================================================
// Stimuli
// ===========================================================================

function ramp(w: number, h: number, axis: 'x' | 'y'): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = Math.round((axis === 'x' ? x / (w - 1) : y / (h - 1)) * 255)
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
    d[o] = rnd() * 255; d[o + 1] = rnd() * 255; d[o + 2] = rnd() * 255; d[o + 3] = 255
  }
  return { width: w, height: h, data: d }
}

/** Thin bright lines on dark — the classic aliasing provocation. */
function thinLines(w: number, h: number, spacing = 9): Rgba8 {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const on = (x % spacing === 0) || (y % (spacing + 4) === 0)
      const v = on ? 245 : 18
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
  }
  return { width: w, height: h, data: d }
}

function boxBlurSep(img: Rgba8, r: number, passes = 3): Rgba8 {
  const { width: w, height: h } = img
  let src = new Float32Array(w * h * 4)
  for (let i = 0; i < src.length; i++) src[i] = img.data[i]
  let dst = new Float32Array(w * h * 4)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          let n = 0
          for (let k = -r; k <= r; k++) {
            const xx = Math.min(w - 1, Math.max(0, x + k))
            s += src[(y * w + xx) * 4 + c]; n++
          }
          dst[(y * w + x) * 4 + c] = s / n
        }
      }
    }
    ;[src, dst] = [dst, src]
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0
          let n = 0
          for (let k = -r; k <= r; k++) {
            const yy = Math.min(h - 1, Math.max(0, y + k))
            s += src[(yy * w + x) * 4 + c]; n++
          }
          dst[(y * w + x) * 4 + c] = s / n
        }
      }
    }
    ;[src, dst] = [dst, src]
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(src[i])
  return { width: w, height: h, data: out }
}

/** Bilinear cover-resize + centre crop, so the image node's contain-fit is identity. */
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

export type StimulusId = 'photo' | 'photo-smooth' | 'step' | 'noise' | 'lines' | 'ramp-x'

// ===========================================================================
// Image helpers
// ===========================================================================

function boxDown(img: Rgba8, s: number): Rgba8 {
  const w = Math.floor(img.width / s)
  const h = Math.floor(img.height / s)
  const out = new Uint8ClampedArray(w * h * 4)
  const n = s * s
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
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / n)
    }
  }
  return { width: w, height: h, data: out }
}

function crop(img: Rgba8, x0: number, y0: number, w: number, h: number): Rgba8 {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, x0 + x))
      const s = (sy * img.width + sx) * 4
      const d = (y * w + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
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
      const d = (y * w + x) * 4
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3]
    }
  }
  return { width: w, height: h, data: out }
}

function hstack(imgs: Rgba8[], gap = 4): Rgba8 {
  const h = Math.max(...imgs.map((i) => i.height))
  const w = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 0; out[i + 2] = 128; out[i + 3] = 255 }
  let x0 = 0
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const s = (y * im.width + x) * 4
        const d = (y * w + (x0 + x)) * 4
        out[d] = im.data[s]; out[d + 1] = im.data[s + 1]; out[d + 2] = im.data[s + 2]; out[d + 3] = im.data[s + 3]
      }
    }
    x0 += im.width + gap
  }
  return { width: w, height: h, data: out }
}

function writePng(name: string, img: Rgba8): string {
  fs.mkdirSync(PNG_DIR, { recursive: true })
  const p = path.join(PNG_DIR, name)
  fs.writeFileSync(p, encodePng(img))
  return p
}

// ===========================================================================
// Config matrix
// ===========================================================================

export interface BenchConfig {
  id: string
  cfg: ReedCfg
  dpr: number
  stimulus: StimulusId
  /**
   * Measure STAIRCASE for this config. Requires a locally-linear stimulus:
   * measured estimator floor is 0.015 px on `ramp-x` but 0.25-0.39 px on a
   * photograph, which is larger than the entire A0-vs-A8 staircase signal.
   */
  measureStaircase?: boolean
  note?: string
}

/**
 * Sweep. Not run by `--validate`; the calling phase runs `--sweep`.
 *
 * `ribWidth 80 x dpr 2` on a 1200 px canvas puts every seam exactly on a pixel
 * boundary (period 160.0 device px) and supersampling is then a measured no-op.
 * That is a finding, not a valid gate, so the matrix deliberately carries both
 * aligned and misaligned periods.
 */
export const CONFIGS: BenchConfig[] = [
  { id: 'default', cfg: {}, dpr: 1, stimulus: 'photo', note: 'stock settings, pixel-aligned period' },
  { id: 'misaligned', cfg: { ribWidth: 73, srt_scale: 1.07 }, dpr: 1, stimulus: 'photo', note: 'non-integer period — seams land mid-pixel' },
  { id: 'rib20', cfg: { ribWidth: 20 }, dpr: 1, stimulus: 'photo' },
  { id: 'rib200', cfg: { ribWidth: 200 }, dpr: 1, stimulus: 'photo' },
  { id: 'ior1p2', cfg: { ior: 1.2, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'ior2p5', cfg: { ior: 2.5, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'curv0p4', cfg: { curvature: 0.4, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'curv1p5', cfg: { curvature: 1.5, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'bow0', cfg: { bow: 0, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'rot15', cfg: { srt_rotate: 15, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'rot45', cfg: { srt_rotate: 45, ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'wave-sine', cfg: { ribType: 'wave', waveShape: 'sine', ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  // STAIRCASE configs. `ramp-x` is required: the estimator's measured noise
  // floor is 0.015 px there but 0.25-0.39 px on a photograph, which is larger
  // than the entire A0-vs-A8 staircase signal (gate M2c).
  { id: 'stair-rot0', cfg: { ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true, note: 'straight-but-hard control: must read 0' },
  { id: 'stair-rot7', cfg: { srt_rotate: 7, ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'stair-rot23', cfg: { srt_rotate: 23, ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'stair-rot45', cfg: { srt_rotate: 45, ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'stair-wave', cfg: { ribType: 'wave', waveShape: 'sine', ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'stair-circular', cfg: { ribType: 'circular', ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'stair-noise', cfg: { ribType: 'noise', noiseType: 'simplex', ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
  { id: 'horizontal', cfg: { direction: 'horizontal', ribWidth: 73 }, dpr: 1, stimulus: 'photo' },
  { id: 'dpr2', cfg: { ribWidth: 73 }, dpr: 2, stimulus: 'photo' },
  { id: 'dpr-anim', cfg: { ribWidth: 73 }, dpr: 1.5, stimulus: 'photo', note: 'min(devicePixelRatio,2) * ANIMATED_DPR_SCALE = 2 * 0.75' },
  { id: 'step', cfg: { ribWidth: 73 }, dpr: 1, stimulus: 'step' },
  { id: 'noise', cfg: { ribWidth: 73 }, dpr: 1, stimulus: 'noise' },
  { id: 'lines', cfg: { ribWidth: 73 }, dpr: 1, stimulus: 'lines' },
  { id: 'frost0p3', cfg: { ribWidth: 73, frost: 0.3 }, dpr: 1, stimulus: 'photo' },
]

// ===========================================================================
// Runner
// ===========================================================================

interface Ctx {
  rig: AaRig
  stimuli: Map<StimulusId, Rgba8>
  width: number
  height: number
}

/**
 * Rib period along the seam normal, in device px.
 *
 * The shader divides the pattern basis by `srt_scale` (`rg_srt_scr /= scale`),
 * so a larger scale makes the pattern BIGGER on screen: the period MULTIPLIES
 * by scale, it does not divide. Gate R6a checks this against the GPU probe —
 * the first version of this function had it inverted and R6 caught it.
 */
function periodPx(cfg: ReedCfg, dpr: number): number {
  return (cfg.ribWidth ?? 80) * dpr * (cfg.srt_scale ?? 1)
}

function candCtx(cfg: ReedCfg, dpr: number): CandidateCtx {
  return { frostRadiusPx: (cfg.frost ?? 0) * 24 * dpr, periodPx: periodPx(cfg, dpr) }
}

async function renderCandidate(
  c: Ctx, bc: BenchConfig, cand: Candidate, backend: Backend,
  o?: { imageTranslateX?: number; timeRepeats?: number; mode?: ShaderMode },
): Promise<{ img: Rgba8; gpuNs: number | null; timingMethod: string }> {
  const { width: W, height: H } = c
  const stim = c.stimuli.get(bc.stimulus)!
  const k = cand.renderScale ?? 1
  // A9 gathers in the wrapper, so the node's own frost path must be off.
  const cfg: ReedCfg = cand.id.startsWith('A9') ? { ...bc.cfg, frost: 0 } : bc.cfg
  const g = buildGraph(cfg, W / H, { imageTranslateX: o?.imageTranslateX })
  const ctx = candCtx(bc.cfg, bc.dpr)
  const passes = candidatePasses(g, cand, W * k, H * k, ctx, o?.mode ?? 'color')
  const r = await c.rig.run({
    backend, width: W * k, height: H * k, dpr: bc.dpr * k,
    passes, images: { [g.imageSampler]: stim }, timeRepeats: o?.timeRepeats ?? 0,
  })
  return { img: k === 1 ? r.image : boxDown(r.image, k), gpuNs: r.gpuNs, timingMethod: r.timingMethod }
}

async function renderSeamField(
  c: Ctx, bc: BenchConfig, backend: Backend, imageTranslateX = 0, rangePx = SEAM_RANGE_PX,
): Promise<SeamField> {
  const { width: W, height: H } = c
  const g = buildGraph(bc.cfg, W / H, { imageTranslateX })
  const passes = seamProbePasses(g, W, H, rangePx)
  const r = await c.rig.run({
    backend, width: W, height: H, dpr: bc.dpr,
    passes, images: { [g.imageSampler]: c.stimuli.get(bc.stimulus)! },
  })
  return decodeSeamField(r.image, rangePx)
}

export interface Row {
  config: string
  candidate: string
  backend: Backend
  edgeRoughnessMean: number
  edgeRoughnessP95: number
  edgeRoughnessMax: number
  /**
   * Noise-corrected staircase, device px: sqrt(raw^2 - floor^2). null when the
   * config is not flagged `measureStaircase` (the metric needs a locally-linear
   * source; on a photograph its own floor swamps the signal).
   */
  staircasePx: number | null
  /** uncorrected reading and the measured estimator floor, both device px */
  staircaseRawPx: number | null
  staircaseFloorPx: number | null
  staircaseN: number
  globalMean: number
  globalP95: number
  hfLoss: number
  fetchesMeasured: number
  fetchesMin: number
  fetchesMax: number
  gpuNs: number | null
  timingMethod: string
  temporalCrawl?: number
}

/**
 * The estimator's own noise floor for this (config, candidate, stimulus).
 *
 * Same everything, with the seam forced STRAIGHT and UNROTATED — a geometry in
 * which a staircase is impossible, so whatever the estimator reports there is
 * noise. Subtracted in quadrature from the real reading.
 */
function floorConfig(bc: BenchConfig): BenchConfig {
  return { ...bc, id: `${bc.id}__floor`, cfg: { ...bc.cfg, srt_rotate: 0, ribType: 'straight' } }
}

async function scoreOne(
  c: Ctx, bc: BenchConfig, cand: Candidate, backend: Backend,
  gt: Rgba8, band: Uint8Array, field: SeamField, floorField?: SeamField,
): Promise<{ row: Row; img: Rgba8 }> {
  const { img, gpuNs, timingMethod } = await renderCandidate(c, bc, cand, backend, { timeRepeats: 20 })
  const er = maskedDiff(img, gt, band)
  const gf = globalFidelity(img, gt)

  let stair: number | null = null
  let stairRaw: number | null = null
  let stairFloor: number | null = null
  let stairN = 0
  if (bc.measureStaircase && floorField) {
    const sc = staircase(img, field)
    const fl = staircase((await renderCandidate(c, floorConfig(bc), cand, backend)).img, floorField)
    stairN = sc.n
    if (sc.valid && fl.valid) {
      stairRaw = sc.rmsPx
      stairFloor = fl.rmsPx
      stair = Math.sqrt(Math.max(sc.rmsPx * sc.rmsPx - fl.rmsPx * fl.rmsPx, 0))
    }
  }

  let fetch = { mean: cand.nominalFetches, min: cand.nominalFetches, max: cand.nominalFetches }
  if (!cand.renderScale) {
    const cnt = await renderCandidate(c, bc, cand, backend, { mode: 'count' })
    fetch = decodeCount(cnt.img)
  }
  return {
    img,
    row: {
      config: bc.id, candidate: cand.id, backend,
      edgeRoughnessMean: er.mean, edgeRoughnessP95: er.p95, edgeRoughnessMax: er.max,
      staircasePx: stair, staircaseRawPx: stairRaw, staircaseFloorPx: stairFloor, staircaseN: stairN,
      globalMean: gf.mean, globalP95: gf.p95, hfLoss: gf.hfLoss,
      fetchesMeasured: fetch.mean, fetchesMin: fetch.min, fetchesMax: fetch.max,
      gpuNs, timingMethod,
    },
  }
}

// ===========================================================================
// Validation
// ===========================================================================

interface Gate {
  id: string
  metric: string
  knownGood: string
  knownBad: string
  threshold: string
  pass: boolean
  detail: string
}

function gate(
  out: Gate[], id: string, metric: string, knownGood: string, knownBad: string,
  threshold: string, pass: boolean, detail: string,
): void {
  out.push({ id, metric, knownGood, knownBad, threshold, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${metric}`)
  console.log(`          good=${knownGood}  bad=${knownBad}  gate: ${threshold}`)
  if (detail) console.log(`          ${detail}`)
}

const f = (n: number, d = 3): string => (Number.isFinite(n) ? n.toFixed(d) : String(n))
/** Staircase is null when the metric could not measure the seam — never print a number then. */
const stairStr = (n: number | null): string => (n === null ? '  n/a' : f(n, 3))

async function loadStimuli(rig: AaRig, W: number, H: number): Promise<Map<StimulusId, Rgba8>> {
  const m = new Map<StimulusId, Rgba8>()
  const photoPath = path.join(REPO, 'stuff', '5468102179_8f885a1744_o.jpg')
  const bytes = new Uint8Array(fs.readFileSync(photoPath))
  const decoded = await rig.decodeImage(bytes, 'image/jpeg', 2048)
  const photo = coverCrop(decoded, W, H)
  m.set('photo', photo)
  m.set('photo-smooth', boxBlurSep(photo, 4, 3))
  m.set('noise', hfNoise(W, H))
  m.set('lines', thinLines(W, H))
  m.set('ramp-x', ramp(W, H, 'x'))
  // hard step edge, vertical mid-frame
  const step = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      const v = x < W / 2 ? 25 : 230
      step[o] = v; step[o + 1] = v; step[o + 2] = v; step[o + 3] = 255
    }
  }
  m.set('step', { width: W, height: H, data: step })
  return m
}

async function validate(): Promise<void> {
  const W = 600
  const H = 400
  const rig = await createAaRig()
  const gates: Gate[] = []
  const pipelineRows: Row[] = []
  const artifacts: string[] = []
  console.log(`adapter: ${rig.adapterInfo}`)
  console.log(`backends: webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2}  timestamp-query=${rig.hasTimestamp}`)
  const backends: Backend[] = (['webgpu', 'webgl2'] as Backend[]).filter((b) => rig.available[b])

  try {
    const stimuli = await loadStimuli(rig, W, H)
    const c: Ctx = { rig, stimuli, width: W, height: H }
    const src = stimuli.get('photo')!

    // -------------------------------------------------------------------
    console.log('\n--- RIG CONTROLS ---')
    // -------------------------------------------------------------------
    for (const b of backends) {
      const g = buildGraph({}, W / H, { bypass: true })
      const r = await rig.run({ backend: b, width: W, height: H, dpr: 1, passes: g.passes, images: { [g.imageSampler]: src } })
      const d = maskedDiff(r.image, src)
      gate(gates, `R1-${b}`, `bypass image->output is byte-exact (${b})`,
        'stimulus itself', 'n/a (orientation/upload bug would show here)', 'max = 0 codes',
        d.max === 0, `max=${d.max} mean=${f(d.mean, 4)}`)
    }

    for (const b of backends) {
      const g = buildGraph({ ior: 1.0 }, W / H)
      const r = await rig.run({ backend: b, width: W, height: H, dpr: 1, passes: g.passes, images: { [g.imageSampler]: src } })
      const d = maskedDiff(r.image, src)
      gate(gates, `R2-${b}`, `identity lens (ior=1) is byte-exact (${b})`,
        'stimulus itself', 'n/a', 'max = 0 codes',
        d.max === 0, `max=${d.max} mean=${f(d.mean, 4)}`)
    }

    const bcMis: BenchConfig = { id: 'misaligned', cfg: { ribWidth: 73, srt_scale: 1.07 }, dpr: 1, stimulus: 'photo' }
    for (const b of backends) {
      const a0 = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A0'], b)
      const a0w = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A0w'], b)
      const d = maskedDiff(a0.img, a0w.img)
      gate(gates, `R3-${b}`, `source surgery is inert: A0w == A0 (${b})`,
        'A0 (untouched compiler output)', 'n/a — any nonzero means the wrapper changed the maths',
        'max = 0 codes', d.max === 0, `max=${d.max} nonzero-pixels=${d.n > 0 ? d.mean.toFixed(6) : 0}`)
    }

    // Wrapper vs a genuine native 4x render, plus the 1-tap known-bad.
    for (const b of backends) {
      const bcR: BenchConfig = { id: 'ramp', cfg: { ribWidth: 37, srt_rotate: 23 }, dpr: 1, stimulus: 'ramp-x' }
      const gN = buildGraph(bcR.cfg, W / H)
      const nat = await rig.run({ backend: b, width: W * 4, height: H * 4, dpr: 4, passes: gN.passes, images: { [gN.imageSampler]: stimuli.get('ramp-x')! } })
      const natDown = boxDown(nat.image, 4)
      const ss4 = await renderCandidate(c, bcR, { id: 'ss4', label: '', nominalFetches: 16, build: (L) => boxGrid(L, 4) }, b)
      const one = await renderCandidate(c, bcR, CANDIDATE_BY_ID['A0'], b)
      const dg = maskedDiff(ss4.img, natDown)
      const db = maskedDiff(one.img, natDown)
      gate(gates, `R4-${b}`, `supersample wrapper == native 4x render (${b})`,
        `wrapper 4x4 vs native 4x: mean ${f(dg.mean, 4)}`,
        `1-tap vs native 4x: mean ${f(db.mean, 4)}`,
        'good mean < 0.5 codes AND bad/good > 2x',
        dg.mean < 0.5 && db.mean > dg.mean * 2,
        `good max=${dg.max}  bad max=${db.max}  ratio=${f(db.mean / Math.max(dg.mean, 1e-9), 2)}x`)
    }

    if (backends.length === 2) {
      const a = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A0'], 'webgpu')
      const bb = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A0'], 'webgl2')
      const d = maskedDiff(a.img, bb.img)
      gate(gates, 'R5', 'cross-backend agreement on A0 (WGSL vs GLSL)',
        'same emitted maths on both backends', 'a translation bug would show as a large diff',
        'mean < 0.5 codes AND max <= 8 codes',
        d.mean < 0.5 && d.max <= 8, `mean=${f(d.mean, 4)} p95=${d.p95} max=${d.max}`)
    }

    // ---- seam probe / band mask ----
    console.log('\n--- SEAM PROBE ---')
    const fieldMis = await renderSeamField(c, bcMis, backends[0])
    const bandMis = seamBand(fieldMis, SEAM_BAND_PX, MASK_MARGIN)
    const per = periodPx(bcMis.cfg, bcMis.dpr)
    const sp = seamSpacing(fieldMis, MASK_MARGIN)
    gate(gates, 'R6a', 'GPU-measured rib period matches the analytic formula',
      `ribWidth * u_dpr * srt_scale = ${f(per, 3)} px`,
      'the inverted formula (divide by srt_scale) gives ' + f((bcMis.cfg.ribWidth ?? 80) * bcMis.dpr / (bcMis.cfg.srt_scale ?? 1), 3) + ' px and fails this gate',
      'within 1% of the probe-measured spacing',
      Math.abs(sp.meanPeriodPx - per) / per < 0.01,
      `probe measured ${f(sp.meanPeriodPx, 3)} px over ${sp.scans} scanlines (${f(sp.crossingsPerScan, 2)} seams/scan, axis ${sp.scanAxis})`)

    {
      const px = maskCount(bandMis)
      const seams = sp.crossingsPerScan * sp.scans
      const perSeam = px / seams
      gate(gates, 'R6b', 'seam band mask holds exactly the band it claims',
        `+-${SEAM_BAND_PX} px band -> ${2 * SEAM_BAND_PX} pixel centres per seam per scanline`,
        'a mask that missed the seams would read ~0 px/seam; one covering the whole frame would read ~' + f(per, 0),
        `within +-0.6 px of ${2 * SEAM_BAND_PX}`,
        Math.abs(perSeam - 2 * SEAM_BAND_PX) <= 0.6,
        `measured ${f(perSeam, 3)} px/seam/scanline over ${f(seams, 0)} seam-scanlines (mask covers ${f(maskFraction(bandMis) * 100, 2)}% of the frame)`)
    }

    // straight config: seams must be exactly axis-aligned
    const fieldStraight = await renderSeamField(c, { id: 's', cfg: { ribWidth: 73 }, dpr: 1, stimulus: 'photo' }, backends[0])
    let maxNy = 0
    for (let i = 0; i < fieldStraight.ny.length; i++) maxNy = Math.max(maxNy, Math.abs(fieldStraight.ny[i]))
    gate(gates, 'R7', 'seam normal is exactly axis-aligned for straight, unrotated ribs',
      'straight ribs, rotate 0 -> |n.y| = 0', 'a wrong normal would tilt every directional candidate',
      '|n.y| <= 0.01', maxNy <= 0.01, `max |n.y| = ${f(maxNy, 4)}`)

    // ---- cost counter ----
    console.log('\n--- COST COUNTER ---')
    for (const b of backends) {
      const checks: Array<[string, number]> = [['A0', 1], ['A3', 4], ['A1-8', 8], ['A8', GT_SS * GT_SS]]
      let ok = true
      const parts: string[] = []
      for (const [id, want] of checks) {
        const r = await renderCandidate(c, bcMis, CANDIDATE_BY_ID[id], b, { mode: 'count' })
        const cnt = decodeCount(r.img)
        const exact = cnt.min === want && cnt.max === want
        ok = ok && exact
        parts.push(`${id}=${cnt.min}..${cnt.max} (want ${want})`)
      }
      const broken = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A8'], b, { mode: 'count-broken' })
      const bc2 = decodeCount(broken.img)
      gate(gates, `R8-${b}`, `fetch counter is exact (${b})`,
        parts.join(', '), `no-increment build of A8 reads ${bc2.min}..${bc2.max} (want 0)`,
        'every count exact AND the broken build reads 0',
        ok && bc2.max === 0, '')

      const a4 = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A4'], b, { mode: 'count' })
      const a4c = decodeCount(a4.img)
      gate(gates, `R9-${b}`, `A4 is genuinely adaptive (${b})`,
        `expected 1 outside the seam band and 2 inside; period ${f(per, 2)} px -> mean ~${f(1 + 1 / per, 4)}`,
        'a non-adaptive build would read a flat 2.000',
        'min=1, max=2, mean within 0.02 of 1 + 1/period',
        a4c.min === 1 && a4c.max === 2 && Math.abs(a4c.mean - (1 + 1 / per)) < 0.02,
        `measured mean=${f(a4c.mean, 4)} min=${a4c.min} max=${a4c.max}`)
    }

    // -------------------------------------------------------------------
    console.log('\n--- CANDIDATE x SHADER-SHAPE COVERAGE ---')
    // -------------------------------------------------------------------
    // Every rib type / direction changes the emitted body, and the source
    // surgery has to keep finding `rg_wm_scr_*` in all of them. Without this
    // the sweep would discover a broken split hours in.
    {
      const shapes: Array<[string, ReedCfg]> = [
        ['straight', {}],
        ['horizontal', { direction: 'horizontal' }],
        ['rot45', { srt_rotate: 45 }],
        ['wave-sine', { ribType: 'wave', waveShape: 'sine' }],
        ['wave-triangle', { ribType: 'wave', waveShape: 'triangle' }],
        ['wave-square', { ribType: 'wave', waveShape: 'square' }],
        ['wave-sawtooth', { ribType: 'wave', waveShape: 'sawtooth' }],
        ['wave-chevron', { ribType: 'wave', waveShape: 'chevron' }],
        ['wave-ushape', { ribType: 'wave', waveShape: 'u_shape' }],
        ['circular', { ribType: 'circular' }],
        ['noise-simplex', { ribType: 'noise', noiseType: 'simplex' }],
        ['noise-worley', { ribType: 'noise', noiseType: 'worley' }],
        ['frost', { frost: 0.4 }],
      ]
      const small: Ctx = { rig, stimuli, width: 160, height: 120 }
      const smallStim = coverCrop(stimuli.get('photo')!, 160, 120)
      small.stimuli = new Map(stimuli)
      small.stimuli.set('photo', smallStim)
      const failures: string[] = []
      let ran = 0
      for (const [name, cfg] of shapes) {
        const bcS: BenchConfig = { id: name, cfg: { ...cfg, ribWidth: 23 }, dpr: 1, stimulus: 'photo' }
        for (const b of backends) {
          try { await renderSeamField(small, bcS, b) } catch (e) { failures.push(`probe/${name}/${b}: ${(e as Error).message.slice(0, 120)}`) }
          for (const cand of CANDIDATES) {
            ran++
            try {
              await renderCandidate(small, bcS, cand, b)
              if (!cand.renderScale) await renderCandidate(small, bcS, cand, b, { mode: 'count' })
            } catch (e) {
              failures.push(`${cand.id}/${name}/${b}: ${(e as Error).message.slice(0, 120)}`)
            }
          }
        }
      }
      gate(gates, 'R10', 'every candidate compiles and runs on every rib shape, both backends',
        `${CANDIDATES.length} candidates x ${shapes.length} shapes x ${backends.length} backends = ${ran} runs`,
        'a split that failed to find rg_wm_scr_*, or a WGSL/GLSL divergence, would show here',
        'zero failures',
        failures.length === 0,
        failures.length ? failures.slice(0, 6).join(' | ') : 'includes square/sawtooth (non-differentiable wave), chevron, worley, horizontal, rotate 45 and frost>0')
    }

    // -------------------------------------------------------------------
    console.log('\n--- METRIC CALIBRATION (synthetic) ---')
    // -------------------------------------------------------------------
    // M1 scale + zero
    const synGood = syntheticObliqueEdge(400, 300, { x0: 200.37, slope: 1 / 7, mode: 'coverage' })
    const synBad = syntheticObliqueEdge(400, 300, { x0: 200.37, slope: 1 / 7, mode: 'binary' })
    const synBandG = seamBand(synGood.field, SEAM_BAND_PX)
    {
      const zero = maskedDiff(synGood.img, synGood.img, synBandG)
      const five = maskedDiff(offsetCodes(synGood.img, 5), synGood.img, synBandG)
      gate(gates, 'M1a', 'EDGE ROUGHNESS reads codes on a known scale',
        'image vs itself = 0.000 codes', 'a uniform +5-code offset must read exactly 5.000',
        'zero == 0.000 AND offset == 5.000',
        zero.mean === 0 && Math.abs(five.mean - 5) < 1e-9,
        `zero=${f(zero.mean, 4)} offset5=${f(five.mean, 4)} bandPixels=${zero.n}`)
    }
    {
      const bad = maskedDiff(synBad.img, synGood.img, synBandG)
      // Derived, not guessed. Integrating |binary - coverage| across a ramp of
      // x-width (1 + slope) gives contrast*(1+slope)/4 code-px per scanline;
      // spread over the 2*bandPx pixel centres of the band that is
      //   contrast * (1 + slope) / (4 * 2 * bandPx).
      const contrast = 200 - 60
      const slope = 1 / 7
      const predicted = contrast * (1 + slope) / (4 * 2 * SEAM_BAND_PX)
      gate(gates, 'M1b', 'EDGE ROUGHNESS separates an un-antialiased edge, at the predicted amplitude',
        'coverage-rendered edge vs itself = 0.000 codes',
        `1-bit rasterised edge vs coverage = ${f(bad.mean, 3)} codes`,
        `closed form predicts contrast*(1+slope)/(4*2*bandPx) = ${f(predicted, 3)} codes; gate = within 5%`,
        bad.mean > 0 && Math.abs(bad.mean - predicted) / predicted < 0.05,
        `p95=${bad.p95} max=${bad.max} (max ~ full contrast ${contrast}/2 at the worst phase)`)
    }

    // M2 staircase
    {
      const good = staircase(synGood.img, synGood.field)
      const bad = staircase(synBad.img, synBad.field)
      gate(gates, 'M2a', 'STAIRCASE separates jagged from analytically-covered',
        `analytic coverage: ${f(good.rmsPx, 4)} px (n=${good.n})`,
        `1-bit rasterised: ${f(bad.rmsPx, 4)} px (n=${bad.n})`,
        'good < 0.05 px AND bad > 0.15 px AND bad/good > 4x',
        good.rmsPx < 0.05 && bad.rmsPx > 0.15 && bad.rmsPx > good.rmsPx * 4,
        `ratio=${f(bad.rmsPx / Math.max(good.rmsPx, 1e-6), 1)}x  bias good=${f(good.biasPx, 3)} bad=${f(bad.biasPx, 3)}`)
    }
    {
      // the discriminator the brief demands: straight-but-hard must NOT read as jagged
      const straightHard = syntheticObliqueEdge(400, 300, { x0: 200.37, slope: 0, mode: 'binary' })
      const sh = staircase(straightHard.img, straightHard.field)
      const bad = staircase(synBad.img, synBad.field)
      gate(gates, 'M2b', 'STAIRCASE distinguishes straight-but-hard from jagged',
        `vertical 1-bit edge (hard, straight): ${f(sh.rmsPx, 4)} px`,
        `oblique 1-bit edge (hard, jagged): ${f(bad.rmsPx, 4)} px`,
        'straight-hard < 0.05 px while oblique-hard > 0.15 px',
        sh.rmsPx < 0.05 && bad.rmsPx > 0.15,
        `n straight=${sh.n} oblique=${bad.n}; the hard straight edge is caught by EDGE ROUGHNESS instead`)
    }

    // M3 global fidelity / blur penalty
    {
      const self = globalFidelity(synGood.img, synGood.img)
      const blur = globalFidelity(boxBlur3(synGood.img), synGood.img)
      gate(gates, 'M3', 'GLOBAL FIDELITY catches a candidate that blurs the whole frame',
        `image vs itself: mean ${f(self.mean, 4)} codes, hfLoss ${f(self.hfLoss, 4)}`,
        `3x3 box blur vs itself: mean ${f(blur.mean, 3)} codes, hfLoss ${f(blur.hfLoss, 3)}`,
        'self == 0/0 AND blurred hfLoss > 0.3',
        self.mean === 0 && self.hfLoss === 0 && blur.hfLoss > 0.3,
        `hf: gt=${f(self.hfGroundTruth, 2)} blurred=${f(blur.hfCandidate, 2)}`)
    }

    // M4 temporal
    {
      const F = 5
      const gtSeq: Rgba8[] = []
      const badSeq: Rgba8[] = []
      const masks: Uint8Array[] = []
      for (let i = 0; i < F; i++) {
        const x0 = 200.37 + i * 0.25
        const gS = syntheticObliqueEdge(400, 300, { x0, slope: 1 / 7, mode: 'coverage' })
        const bS = syntheticObliqueEdge(400, 300, { x0, slope: 1 / 7, mode: 'binary' })
        gtSeq.push(gS.img); badSeq.push(bS.img); masks.push(seamBand(gS.field, SEAM_BAND_PX))
      }
      const good = temporalCrawl(gtSeq, gtSeq, masks)
      const bad = temporalCrawl(badSeq, gtSeq, masks)
      gate(gates, 'M4', 'TEMPORAL crawl separates a snapping edge from a sliding one',
        `ground truth vs itself: ${f(good.crawl, 4)} codes`,
        `1-bit sequence vs ground truth: ${f(bad.crawl, 2)} codes`,
        'good == 0.000 AND bad > 5 codes',
        good.crawl === 0 && bad.crawl > 5,
        `bad p95=${bad.crawlP95}, raw energy: candidate ${f(bad.rawCandidate, 2)} vs gt ${f(bad.rawGroundTruth, 2)} codes`)
    }

    // -------------------------------------------------------------------
    console.log('\n--- METRIC CALIBRATION (against the real ground truth) ---')
    // -------------------------------------------------------------------
    const b0 = backends[0]
    const gtRun = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A8'], b0)
    const gtImg = gtRun.img
    const bandR = bandMis
    {
      const selfD = maskedDiff(gtImg, gtImg, bandR)
      const a0 = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A0'], b0)
      const badD = maskedDiff(a0.img, gtImg, bandR)

      // Convergence floor first — G1's threshold is expressed against it rather
      // than against a magic number.
      const gt8 = await renderCandidate(c, bcMis, { id: 'ss8', label: '', nominalFetches: 64, build: (L) => boxGrid(L, 8) }, b0)
      const conv = maskedDiff(gt8.img, gtImg, bandR)
      gate(gates, 'G4', `ground truth is converged at ${GT_SS}x${GT_SS}`,
        `8x8 vs 16x16 in the seam band: mean ${f(conv.mean, 3)} codes (p95 ${conv.p95})`,
        `A0 vs 16x16 in the same band: ${f(badD.mean, 3)} codes`,
        '8x8-vs-16x16 mean < 1 code AND < 10% of the A0 error',
        conv.mean < 1 && conv.mean < badD.mean * 0.1,
        `max=${conv.max} — this is the reference's own residual, i.e. the noise floor of every score below`)

      gate(gates, 'G1', 'ground truth scores exactly 0 on EDGE ROUGHNESS, A0 does not',
        `A8 vs itself: ${f(selfD.mean, 4)} codes`,
        `A0 vs A8: ${f(badD.mean, 3)} codes (p95 ${badD.p95}, max ${badD.max})`,
        `GT == 0.000 AND A0 > 5x the measured convergence floor (${f(conv.mean, 3)} codes) AND A0 p95 >= 5 codes`,
        selfD.mean === 0 && badD.mean > 5 * conv.mean && badD.p95 >= 5,
        `band pixels=${selfD.n}; A0/floor = ${f(badD.mean / Math.max(conv.mean, 1e-9), 1)}x`)

      const gf = globalFidelity(gtImg, gtImg)
      gate(gates, 'G2', 'ground truth scores ~0 on GLOBAL FIDELITY',
        `A8 vs itself: mean ${f(gf.mean, 4)}, hfLoss ${f(gf.hfLoss, 4)}`,
        'a mis-specified reference would show nonzero here', 'mean == 0 AND hfLoss == 0',
        gf.mean === 0 && gf.hfLoss === 0, '')

      // determinism: A8 rendered twice must be bit-identical
      const gt2 = await renderCandidate(c, bcMis, CANDIDATE_BY_ID['A8'], b0)
      const dd = maskedDiff(gtImg, gt2.img)
      gate(gates, 'G3', 'ground truth is deterministic across runs',
        'A8 rendered twice', 'a nondeterministic GT would poison every score', 'max = 0 codes',
        dd.max === 0, `max=${dd.max}`)

      artifacts.push(writePng('validate-gt-A8.png', gtImg))
      artifacts.push(writePng('validate-A0.png', a0.img))
      const cx = Math.round(W / 2)
      const cy = Math.round(H / 2)
      const strip = (im: Rgba8): Rgba8 => upscaleNearest(crop(im, cx - 20, cy - 20, 40, 40), 6)
      artifacts.push(writePng('validate-seamcrop-A0-vs-A8.png', hstack([strip(a0.img), strip(gtImg)])))

      // ---- STAIRCASE on the real pipeline ----
      const bcRot: BenchConfig = { id: 'rot7-ramp', cfg: { srt_rotate: 7, ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true }
      const bcRotPhoto: BenchConfig = { ...bcRot, id: 'rot7-photo', stimulus: 'photo' }
      const fieldRot = await renderSeamField(c, bcRot, b0)
      const fieldFlat = await renderSeamField(c, floorConfig(bcRot), b0)
      const sRaw = async (cand: string, cfg: BenchConfig, fl: SeamField): Promise<number> =>
        staircase((await renderCandidate(c, cfg, CANDIDATE_BY_ID[cand], b0)).img, fl).rmsPx
      const a0Rot = await sRaw('A0', bcRot, fieldRot)
      const a0Flat = await sRaw('A0', floorConfig(bcRot), fieldFlat)
      const gtRot = await sRaw('A8', bcRot, fieldRot)
      const gtFlat = await sRaw('A8', floorConfig(bcRot), fieldFlat)
      const corr = (r: number, fl: number): number => Math.sqrt(Math.max(r * r - fl * fl, 0))

      // M2c: the noise floor is MEASURED, not assumed, and it is what makes a
      // photo unusable for this metric — its floor is bigger than the signal.
      const fieldRotPhoto = await renderSeamField(c, bcRotPhoto, b0)
      const a0PhotoFlat = await sRaw('A0', floorConfig(bcRotPhoto), await renderSeamField(c, floorConfig(bcRotPhoto), b0))
      const a0PhotoRot = staircase((await renderCandidate(c, bcRotPhoto, CANDIDATE_BY_ID['A0'], b0)).img, fieldRotPhoto).rmsPx
      // The criterion is HEADROOM, not an absolute floor: a metric is usable on
      // a stimulus exactly when the signal it must resolve stands clear of that
      // stimulus's own floor. (Measured separately: the 0.085 px ramp floor is
      // 8-bit quantisation of the source and does not shrink with the window —
      // halfWindow 2/3/4 give 0.078/0.085/0.085 px.)
      const rampHead = a0Rot / a0Flat
      const photoHead = a0PhotoRot / a0PhotoFlat
      gate(gates, 'M2c', 'STAIRCASE floor is measured per stimulus and decides which stimuli qualify',
        `ramp-x: A0 reads ${f(a0Rot, 4)} px against a measured floor of ${f(a0Flat, 4)} px -> ${f(rampHead, 2)}x headroom`,
        `raw photo: A0 reads ${f(a0PhotoRot, 4)} px against a floor of ${f(a0PhotoFlat, 4)} px -> ${f(photoHead, 2)}x, i.e. indistinguishable from its own noise`,
        'qualifying stimulus > 2x headroom AND disqualified stimulus < 1.3x (only >2x configs carry measureStaircase)',
        rampHead > 2 && photoHead < 1.3,
        'floor = the same config with the seam forced straight and unrotated, where a staircase is geometrically impossible')

      gate(gates, 'M2d', 'STAIRCASE reads ~0 for a hard BUT STRAIGHT seam on the real pipeline',
        `A0 on straight, unrotated ribs — hard cut, zero jaggedness: corrected ${f(corr(a0Flat, a0Flat), 4)} px`,
        `A0 on the same ribs rotated 7deg: corrected ${f(corr(a0Rot, a0Flat), 4)} px`,
        'straight == 0.000 px AND rotated > 0.15 px',
        corr(a0Flat, a0Flat) === 0 && corr(a0Rot, a0Flat) > 0.15,
        `raw readings ${f(a0Flat, 4)} -> ${f(a0Rot, 4)} px; the straight hard cut is caught by EDGE ROUGHNESS instead`)

      gate(gates, 'G6', 'STAIRCASE separates A0 from ground truth on a rotated seam',
        `A8 (16x16) at rotate 7deg: corrected ${f(corr(gtRot, gtFlat), 4)} px (raw ${f(gtRot, 4)}, floor ${f(gtFlat, 4)})`,
        `A0 (1 tap) at rotate 7deg: corrected ${f(corr(a0Rot, a0Flat), 4)} px (raw ${f(a0Rot, 4)}, floor ${f(a0Flat, 4)})`,
        'A0 > 2x A8',
        corr(a0Rot, a0Flat) > 2 * corr(gtRot, gtFlat),
        `ratio=${f(corr(a0Rot, a0Flat) / Math.max(corr(gtRot, gtFlat), 1e-9), 2)}x; A0 sits at ${f(corr(a0Rot, a0Flat) / 0.2887, 2)}x the 1/sqrt(12) pixel-quantisation signature`)

      const a0SmImg = (await renderCandidate(c, bcRot, CANDIDATE_BY_ID['A0'], b0)).img
      const gtSmImg = (await renderCandidate(c, bcRot, CANDIDATE_BY_ID['A8'], b0)).img
      artifacts.push(writePng('validate-stair-rot7-A0-vs-A8.png',
        hstack([upscaleNearest(crop(a0SmImg, cx - 20, cy - 20, 40, 40), 6), upscaleNearest(crop(gtSmImg, cx - 20, cy - 20, 40, 40), 6)])))
    }

    // -------------------------------------------------------------------
    console.log('\n--- END-TO-END ROW EMISSION (pipeline proof, not the sweep) ---')
    // -------------------------------------------------------------------
    const proofConfigs: Array<[BenchConfig, string[]]> = [
      [bcMis, ['A0', 'A4', 'A3', 'A1-4', 'A9-16', 'A6', 'A7-2', 'A8']],
      // a measureStaircase config, so the floor-rendering path is exercised too
      [{ id: 'stair-rot7', cfg: { srt_rotate: 7, ribWidth: 73 }, dpr: 1, stimulus: 'ramp-x', measureStaircase: true },
        ['A0', 'A4', 'A3', 'A8']],
    ]
    for (const [bcP, ids] of proofConfigs) for (const b of backends) {
      const fieldB = await renderSeamField(c, bcP, b)
      const bandB = seamBand(fieldB, SEAM_BAND_PX, MASK_MARGIN)
      const floorFieldB = bcP.measureStaircase ? await renderSeamField(c, floorConfig(bcP), b) : undefined
      const gtB = (await renderCandidate(c, bcP, CANDIDATE_BY_ID['A8'], b)).img
      for (const id of ids) {
        const { row } = await scoreOne(c, bcP, CANDIDATE_BY_ID[id], b, gtB, bandB, fieldB, floorFieldB)
        pipelineRows.push(row)
        console.log(`  ${bcP.id.padEnd(11)} ${b.padEnd(7)} ${id.padEnd(6)} rough=${f(row.edgeRoughnessMean, 2).padStart(6)} p95=${String(row.edgeRoughnessP95).padStart(3)}  stair=${stairStr(row.staircasePx)} (floor ${stairStr(row.staircaseFloorPx)})  global=${f(row.globalMean, 3)}  hfLoss=${f(row.hfLoss, 3).padStart(7)}  fetch=${f(row.fetchesMeasured, 3).padStart(8)}  gpu=${row.gpuNs === null ? 'n/a' : f(row.gpuNs / 1000, 1) + 'us'}`)
      }
    }

    // temporal on the real pipeline (pan the pattern sub-pixel)
    {
      const F = 4
      const step = 0.25 / bcMis.dpr
      const seqA0: Rgba8[] = []
      const seqGT: Rgba8[] = []
      const seqMask: Uint8Array[] = []
      for (let i = 0; i < F; i++) {
        const bcI: BenchConfig = { ...bcMis, cfg: { ...bcMis.cfg, srt_translateX: i * step } }
        seqA0.push((await renderCandidate(c, bcI, CANDIDATE_BY_ID['A0'], b0)).img)
        seqGT.push((await renderCandidate(c, bcI, CANDIDATE_BY_ID['A8'], b0)).img)
        seqMask.push(seamBand(await renderSeamField(c, bcI, b0), SEAM_BAND_PX, MASK_MARGIN))
      }
      const good = temporalCrawl(seqGT, seqGT, seqMask)
      const bad = temporalCrawl(seqA0, seqGT, seqMask)
      gate(gates, 'G5', 'TEMPORAL crawl works on the real pipeline',
        `A8 sequence vs itself: ${f(good.crawl, 4)} codes`,
        `A0 sequence vs A8: ${f(bad.crawl, 2)} codes`,
        'GT == 0.000 AND A0 > 2 codes',
        good.crawl === 0 && bad.crawl > 2,
        `A0 raw energy ${f(bad.rawCandidate, 2)} vs GT raw ${f(bad.rawGroundTruth, 2)} codes; ${F} frames at ${f(0.25, 2)} device px`)
      const idx = pipelineRows.findIndex((r) => r.candidate === 'A0' && r.backend === b0 && r.config === bcMis.id)
      if (idx >= 0) pipelineRows[idx].temporalCrawl = bad.crawl
    }
  } finally {
    await rig.close()
  }

  const nFail = gates.filter((g) => !g.pass).length
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase10-validation.json'), JSON.stringify({
    generated: new Date().toISOString(),
    width: W, height: H, seamBandPx: SEAM_BAND_PX, groundTruthSupersample: GT_SS,
    gates, pipelineRows, artifacts: artifacts.map((a) => path.relative(REPO, a)),
  }, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, 'phase10-validation.md'), renderValidationMd(gates, pipelineRows, W, H))
  console.log(`\n${gates.length - nFail}/${gates.length} gates pass`)
  console.log(`wrote ${path.join(OUT_DIR, 'phase10-validation.json')}`)
  console.log(`wrote ${path.join(OUT_DIR, 'phase10-validation.md')}`)
  if (nFail) process.exit(1)
}

/** Pipes inside gate text would otherwise split the markdown table cell. */
const md = (t: string): string => t.replace(/\|/g, '\\|')

function renderValidationMd(gates: Gate[], rows: Row[], W: number, H: number): string {
  const l: string[] = []
  l.push('# Phase 10b — edge-quality bench: gate calibration')
  l.push('')
  l.push(`Canvas ${W}x${H}. Ground truth = ${GT_SS}x${GT_SS} box supersample of the node's own shader.`)
  l.push(`Seam band = +-${SEAM_BAND_PX} px around the analytically-probed seam. Errors in 8-bit codes; positions in device px.`)
  l.push('')
  l.push('| gate | metric | known-good | known-bad | threshold | result |')
  l.push('|---|---|---|---|---|---|')
  for (const g of gates) {
    l.push(`| \`${g.id}\` | ${md(g.metric)} | ${md(g.knownGood)} | ${md(g.knownBad)} | ${md(g.threshold)} | ${g.pass ? 'PASS' : '**FAIL**'} |`)
  }
  l.push('')
  l.push('## End-to-end row emission (pipeline proof — NOT the sweep)')
  l.push('')
  l.push('| config | backend | candidate | rough mean | rough p95 | staircase px | stair floor | global mean | hfLoss | fetches | gpu us |')
  l.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    l.push(`| ${r.config} | ${r.backend} | \`${r.candidate}\` | ${f(r.edgeRoughnessMean, 2)} | ${r.edgeRoughnessP95} | ${stairStr(r.staircasePx)} | ${stairStr(r.staircaseFloorPx)} | ${f(r.globalMean, 3)} | ${f(r.hfLoss, 3)} | ${f(r.fetchesMeasured, 3)} | ${r.gpuNs === null ? 'n/a' : f(r.gpuNs / 1000, 1)} |`)
  }
  l.push('')
  return l.join('\n')
}

// ===========================================================================
// Sweep
// ===========================================================================

async function sweep(): Promise<void> {
  const W = 1200
  const H = 800
  const rig = await createAaRig()
  const rows: Row[] = []
  const backends: Backend[] = (['webgpu', 'webgl2'] as Backend[]).filter((b) => rig.available[b])
  try {
    const stimuli = await loadStimuli(rig, W, H)
    const c: Ctx = { rig, stimuli, width: W, height: H }
    for (const bc of CONFIGS) {
      for (const b of backends) {
        const field = await renderSeamField(c, bc, b)
        const band = seamBand(field, SEAM_BAND_PX, MASK_MARGIN)
        const floorField = bc.measureStaircase ? await renderSeamField(c, floorConfig(bc), b) : undefined
        const gt = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A8'], b)).img
        const keep: Record<string, Rgba8> = {}
        for (const cand of CANDIDATES) {
          const { row, img } = await scoreOne(c, bc, cand, b, gt, band, field, floorField)
          rows.push(row)
          if (b === backends[0] && ['A0', 'A4', 'A3', 'A8'].includes(cand.id)) keep[cand.id] = img
          console.log(`${bc.id}/${b}/${cand.id}: rough=${f(row.edgeRoughnessMean, 2)} stair=${stairStr(row.staircasePx)} fetch=${f(row.fetchesMeasured, 2)}`)
        }
        if (b === backends[0]) {
          const cx = Math.round(W / 2)
          const cy = Math.round(H / 2)
          const strip = (im: Rgba8): Rgba8 => upscaleNearest(crop(im, cx - 24, cy - 24, 48, 48), 4)
          const order = ['A0', 'A4', 'A3', 'A8'].filter((k) => keep[k])
          writePng(`seam4x-${bc.id}.png`, hstack(order.map((k) => strip(keep[k]))))
          writePng(`full-${bc.id}-A0.png`, keep['A0'])
          writePng(`full-${bc.id}-A8.png`, keep['A8'])
        }
      }
    }
  } finally {
    await rig.close()
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'phase10.json'), JSON.stringify({
    generated: new Date().toISOString(), width: W, height: H,
    seamBandPx: SEAM_BAND_PX, groundTruthSupersample: GT_SS, rows,
  }, null, 2))
  const l: string[] = ['# Phase 10b — Reeded Glass rib-edge AA bake-off', '',
    `Canvas ${W}x${H}. GT = ${GT_SS}x${GT_SS} box supersample. Errors in 8-bit codes, positions in device px.`, '',
    '| config | candidate | backend | rough mean | rough p95 | staircase px | stair raw | stair floor | global mean | hfLoss | fetches | gpu us |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|']
  for (const r of rows) {
    l.push(`| ${r.config} | \`${r.candidate}\` | ${r.backend} | ${f(r.edgeRoughnessMean, 2)} | ${r.edgeRoughnessP95} | ${stairStr(r.staircasePx)} | ${stairStr(r.staircaseRawPx)} | ${stairStr(r.staircaseFloorPx)} | ${f(r.globalMean, 3)} | ${f(r.hfLoss, 3)} | ${f(r.fetchesMeasured, 3)} | ${r.gpuNs === null ? 'n/a' : f(r.gpuNs / 1000, 1)} |`)
  }
  fs.writeFileSync(path.join(OUT_DIR, 'phase10.md'), l.join('\n'))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase10.json')} (${rows.length} rows)`)
}

// ===========================================================================
// Apportionment
//
// The sweep ranks candidates but cannot say WHICH mechanism produces A0's
// error, because every sweep config changes a parameter AND the rib period
// together. This mode answers that, two ways:
//
//  1. ZONE decomposition — one config, error split by where in the rib it
//     lands. The zones come from the same GPU seam probe the sweep uses, so
//     no geometry is re-derived on the CPU: the caustic sits at a known rib
//     phase, and the probe already reports signed distance to the seam in px.
//  2. ABLATION ladder — a chain of configs differing in exactly ONE thing, so
//     each step's delta is attributable. The ladder starts at ior=1 (no lens),
//     which MUST read 0; that is the known-good control for the whole mode.
//
// Plus the ANIMATED_DPR_SCALE experiment, which the sweep's `dpr-anim` config
// does NOT model: that config lowers u_dpr on a full-size framebuffer, which
// only changes rib density. The renderer additionally SHRINKS the framebuffer
// to 0.75x and lets the compositor scale it back up. Here the CSS scene is held
// fixed and the framebuffer is the thing that changes, then it is bilinearly
// upscaled — which is what the browser does with an undersized backing store.
// ===========================================================================

/** Bilinear magnify to (dw, dh) — models the compositor scaling a small backing store. */
function bilinearResize(img: Rgba8, dw: number, dh: number): Rgba8 {
  const out = new Uint8ClampedArray(dw * dh * 4)
  const sx = img.width / dw
  const sy = img.height / dh
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), img.height - 1)
    const y0 = Math.floor(fy)
    const y1 = Math.min(y0 + 1, img.height - 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), img.width - 1)
      const x0 = Math.floor(fx)
      const x1 = Math.min(x0 + 1, img.width - 1)
      const wx = fx - x0
      const o = (y * dw + x) * 4
      for (let ch = 0; ch < 4; ch++) {
        const a = img.data[(y0 * img.width + x0) * 4 + ch]
        const b = img.data[(y0 * img.width + x1) * 4 + ch]
        const c = img.data[(y1 * img.width + x0) * 4 + ch]
        const d = img.data[(y1 * img.width + x1) * 4 + ch]
        out[o + ch] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy
      }
    }
  }
  return { width: dw, height: dh, data: out }
}

/**
 * Rib phase of the caustic (|d lensed / d local| = 0), as a fraction of the rib.
 * Solved on the CPU from the node's own published closed form; the value is
 * only used to POSITION a mask, and the mask width is +-SEAM_BAND_PX, so a
 * small error in it cannot manufacture signal.
 */
function causticPhases(ior: number, curvature: number): number[] {
  const c = Math.min(Math.max(curvature, 0.01), 1)
  const amp = curvature > 1 ? curvature : 1
  const c2 = Math.min(c, 0.99)
  const k = (ior - 1) * 0.5 * amp
  const dL = (local: number): number => {
    const x = (local - 0.5) * 2
    const x2 = x * x * c2 * c2
    const u = Math.max(1 - x2, 0.001)
    // d(local + disp)/d(local), disp = -x*c2/sqrt(u) * k, dx/dlocal = 2
    return 1 - k * 2 * (c2 / Math.sqrt(u) + x * c2 * (x * c2 * c2) / (u * Math.sqrt(u)))
  }
  const out: number[] = []
  const N = 20000
  let prev = dL(1e-6)
  for (let i = 1; i <= N; i++) {
    const t = i / N
    const v = dL(Math.min(t, 1 - 1e-6))
    if (prev * v < 0) out.push(t - 0.5 / N)
    prev = v
  }
  return out
}

/**
 * |signed distance| within `band` of `target` px, away from the frame edge.
 *
 * REQUIRES a probe whose range is not saturating at `target`: the probe clamps
 * `sg_s` into +-rangePx, so every pixel past the range decodes to exactly
 * +-rangePx and a ring placed there would swallow the whole rib interior.
 * Gate P0 checks the probe used here is wide enough.
 */
function ringBand(f: SeamField, targetPx: number, band: number, margin: number): Uint8Array {
  const m = new Uint8Array(f.width * f.height)
  for (let y = margin; y < f.height - margin; y++) {
    for (let x = margin; x < f.width - margin; x++) {
      const i = y * f.width + x
      if (Math.abs(Math.abs(f.dist[i]) - targetPx) <= band) m[i] = 1
    }
  }
  return m
}

/** everything inside the margin that is in none of the supplied masks */
function complementBand(f: SeamField, masks: Uint8Array[], margin: number): Uint8Array {
  const m = new Uint8Array(f.width * f.height)
  for (let y = margin; y < f.height - margin; y++) {
    for (let x = margin; x < f.width - margin; x++) {
      const i = y * f.width + x
      if (masks.some((k) => k[i])) continue
      m[i] = 1
    }
  }
  return m
}

/**
 * What A8 must produce when the node is the identity (ior = 1): a k x k box of
 * BILINEAR taps of the source over the pixel's own 1x1 square. Computed here on
 * the CPU so the identity control has a real expected value.
 *
 * This is NOT the source image, and it is NOT a 1-px box average of the source
 * either — it is box(1px) applied to the bilinearly-reconstructed source, which
 * is a wider kernel. Getting this wrong is what made the first version of gate
 * P1 fire on a known-good.
 */
function cpuIdentitySupersample(src: Rgba8, k: number): Rgba8 {
  const { width: w, height: h, data } = src
  const out = new Uint8ClampedArray(w * h * 4)
  const acc = new Float64Array(4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      acc.fill(0)
      for (let j = 0; j < k; j++) {
        const sy = y + (j + 0.5) / k - 0.5
        const cy = Math.min(Math.max(sy, 0), h - 1)
        const y0 = Math.floor(cy)
        const y1 = Math.min(y0 + 1, h - 1)
        const fy = cy - y0
        for (let i = 0; i < k; i++) {
          const sx = x + (i + 0.5) / k - 0.5
          const cx = Math.min(Math.max(sx, 0), w - 1)
          const x0 = Math.floor(cx)
          const x1 = Math.min(x0 + 1, w - 1)
          const fx = cx - x0
          for (let ch = 0; ch < 4; ch++) {
            const a = data[(y0 * w + x0) * 4 + ch] * (1 - fx) + data[(y0 * w + x1) * 4 + ch] * fx
            const bb = data[(y1 * w + x0) * 4 + ch] * (1 - fx) + data[(y1 * w + x1) * 4 + ch] * fx
            acc[ch] += a * (1 - fy) + bb * fy
          }
        }
      }
      const o = (y * w + x) * 4
      for (let ch = 0; ch < 4; ch++) out[o + ch] = acc[ch] / (k * k)
    }
  }
  return { width: w, height: h, data: out }
}

/** fraction of decoded distances sitting on the probe's clamp — must be ~0 for a ring probe */
function saturatedFraction(f: SeamField, rangePx: number, margin: number): number {
  let n = 0
  let sat = 0
  for (let y = margin; y < f.height - margin; y++) {
    for (let x = margin; x < f.width - margin; x++) {
      const i = y * f.width + x
      n++
      if (Math.abs(f.dist[i]) >= rangePx - 1e-3) sat++
    }
  }
  return n ? sat / n : 0
}

interface ZoneRow {
  config: string
  zone: string
  pxFraction: number
  pxCount: number
  a0Mean: number
  a0P95: number
  a0Max: number
  a3Mean: number
  a3P95: number
  /** A4 is the analytic seam blend — included here to answer whether it holds
   *  up where the derivative crosses zero and where the mirror fold creases,
   *  which needs a STRADDLING seam AND an extreme lens at the same time. */
  a4Mean: number
  a4P95: number
  a4Max: number
}

interface LadderRow {
  step: string
  what: string
  cfg: string
  a0Mean: number
  a0P95: number
  a0Max: number
  a3Mean: number
  deltaFromPrev: number | null
}

interface DprRow {
  arm: string
  bufferPx: string
  uDpr: number
  candidate: string
  meanVsStaticGt: number
  p95VsStaticGt: number
  maxVsStaticGt: number
  hfLoss: number
}

async function apportion(): Promise<void> {
  const W = 1200
  const H = 800
  const rig = await createAaRig()
  const b: Backend = rig.available.webgpu ? 'webgpu' : 'webgl2'
  const zones: ZoneRow[] = []
  const ladder: LadderRow[] = []
  const dprRows: DprRow[] = []
  const gates: Gate[] = []

  try {
    const stimuli = await loadStimuli(rig, W, H)
    const c: Ctx = { rig, stimuli, width: W, height: H }
    const photo = stimuli.get('photo')!

    // -------------------------------------------------------------------
    console.log('\n--- ZONE DECOMPOSITION (A0 error by where it lands in the rib) ---')
    // -------------------------------------------------------------------
    const zoneCfgs: BenchConfig[] = [
      { id: 'z-phase', cfg: { ribWidth: 73, srt_scale: 1.07 }, dpr: 1, stimulus: 'photo' },
      { id: 'z-ior2p5', cfg: { ribWidth: 73, srt_scale: 1.07, ior: 2.5 }, dpr: 1, stimulus: 'photo' },
      { id: 'z-curv1p5', cfg: { ribWidth: 73, srt_scale: 1.07, curvature: 1.5 }, dpr: 1, stimulus: 'photo' },
    ]
    for (const bc of zoneCfgs) {
      const period = periodPx(bc.cfg, bc.dpr)
      // Ring masks need a probe that does not clamp anywhere in the rib. The
      // sweep's +-8 px probe saturates at 8 px, which would put every interior
      // pixel inside any ring drawn at >5 px. Range = the full period is
      // comfortably past the half-period the signed distance can reach.
      const wide = await renderSeamField(c, bc, b, 0, period)
      const narrow = await renderSeamField(c, bc, b)
      const satW = saturatedFraction(wide, period, MASK_MARGIN)
      const satN = saturatedFraction(narrow, SEAM_RANGE_PX, MASK_MARGIN)
      // agreement where the NARROW probe is unsaturated: the wide probe must be
      // measuring the same quantity, only coarser
      let agreeMax = 0
      for (let i = 0; i < wide.dist.length; i++) {
        if (Math.abs(narrow.dist[i]) >= SEAM_RANGE_PX - 1e-3) continue
        agreeMax = Math.max(agreeMax, Math.abs(wide.dist[i] - narrow.dist[i]))
      }
      const quantPx = 2 * period / 255
      gate(gates, `P0-${bc.id}`, `wide seam probe (range ${f(period, 1)} px) is the narrow probe, unclamped`,
        `narrow probe saturates on ${(100 * satN).toFixed(1)}% of the frame; wide saturates on ${(100 * satW).toFixed(2)}%`,
        'a still-saturating probe would put the whole rib interior inside any ring mask',
        `wide saturation < 1% AND wide-vs-narrow max disagreement <= 1 quantisation step (${f(quantPx, 3)} px)`,
        satW < 0.01 && agreeMax <= quantPx * 1.001,
        `satWide=${(100 * satW).toFixed(3)}% satNarrow=${(100 * satN).toFixed(1)}% maxDisagree=${f(agreeMax, 4)} px`)

      const field = wide
      const gt = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A8'], b)).img
      const a0 = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A0'], b)).img
      const a3 = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A3'], b)).img
      const a4 = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A4'], b)).img
      const phases = causticPhases(bc.cfg.ior ?? 1.5, bc.cfg.curvature ?? 0.8)
      const seam = seamBand(field, SEAM_BAND_PX, MASK_MARGIN)
      // caustics are symmetric about the rib centre; the probe reports |s| so
      // one ring per distinct distance is enough
      const dists = [...new Set(phases.map((p) => Math.round(Math.min(p, 1 - p) * period * 100) / 100))]
        .filter((d) => d > SEAM_BAND_PX + 1)
      const caustic = new Uint8Array(W * H)
      for (const d of dists) {
        const r = ringBand(field, d, SEAM_BAND_PX, MASK_MARGIN)
        for (let i = 0; i < caustic.length; i++) if (r[i]) caustic[i] = 1
      }
      const interior = complementBand(field, [seam, caustic], MASK_MARGIN)
      const all = complementBand(field, [], MASK_MARGIN)
      const total = maskCount(all)
      console.log(`  ${bc.id}: period ${f(period, 2)} px, caustics at rib phase [${phases.map((p) => f(p, 4)).join(', ')}] -> ${dists.length ? dists.map((d) => `${f(d, 1)} px` ).join(', ') : 'none outside the seam band'}`)
      // A mask that holds what it claims: the seam band is one strip of
      // 2*bandPx+1 pixel centres per period per scanline; each caustic ring is
      // two such strips (one either side of the rib centre).
      const predictSeam = (2 * SEAM_BAND_PX) / period
      const predictCaustic = dists.length * 2 * (2 * SEAM_BAND_PX) / period
      const gotSeam = maskCount(seam) / total
      const gotCaustic = maskCount(caustic) / total
      gate(gates, `P3-${bc.id}`, 'zone masks cover the area the geometry predicts',
        `seam ${(100 * predictSeam).toFixed(2)}% + caustic ${(100 * predictCaustic).toFixed(2)}% of the frame`,
        'a mask reading ~0% missed the feature; one reading ~100% swallowed the interior',
        'each within 15% relative of its prediction',
        Math.abs(gotSeam - predictSeam) <= 0.15 * predictSeam
        && (predictCaustic === 0 ? gotCaustic === 0 : Math.abs(gotCaustic - predictCaustic) <= 0.15 * predictCaustic),
        `seam ${(100 * gotSeam).toFixed(2)}% (want ${(100 * predictSeam).toFixed(2)}%)  caustic ${(100 * gotCaustic).toFixed(2)}% (want ${(100 * predictCaustic).toFixed(2)}%)`)
      for (const [name, mask] of [['seam +-3px', seam], ['caustic +-3px', caustic], ['rib interior', interior], ['WHOLE FRAME', all]] as Array<[string, Uint8Array]>) {
        const n = maskCount(mask)
        if (!n) { console.log(`    ${name.padEnd(15)} empty`); continue }
        const d0 = maskedDiff(a0, gt, mask)
        const d3 = maskedDiff(a3, gt, mask)
        const d4 = maskedDiff(a4, gt, mask)
        zones.push({
          config: bc.id, zone: name, pxFraction: n / total, pxCount: n,
          a0Mean: d0.mean, a0P95: d0.p95, a0Max: d0.max, a3Mean: d3.mean, a3P95: d3.p95,
          a4Mean: d4.mean, a4P95: d4.p95, a4Max: d4.max,
        })
        console.log(`    ${name.padEnd(15)} ${(100 * n / total).toFixed(1).padStart(5)}% of frame   A0 ${f(d0.mean, 3)}/${d0.p95}/${d0.max}   A4 ${f(d4.mean, 3)}/${d4.p95}/${d4.max}   A3 ${f(d3.mean, 3)}/${d3.p95}/${d3.max}   (mean/p95/max)`)
      }
    }

    // -------------------------------------------------------------------
    console.log('\n--- ABLATION LADDER (one change per step) ---')
    // -------------------------------------------------------------------
    const steps: Array<{ step: string; what: string; cfg: ReedCfg }> = [
      { step: 'L0', what: 'ior = 1: no lens at all — CONTROL, must read 0', cfg: { ribWidth: 73, ior: 1 } },
      { step: 'L1', what: 'lens on, bow 0, period 73.00 px = integer -> seam never inside a pixel', cfg: { ribWidth: 73, bow: 0 } },
      { step: 'L2', what: 'L1 + bow 1 (adds the perpendicular sag displacement)', cfg: { ribWidth: 73, bow: 1 } },
      { step: 'L3', what: 'L2 + srt_scale 1.07 -> period 78.11 px, seam now straddles pixels', cfg: { ribWidth: 73, bow: 1, srt_scale: 1.07 } },
      { step: 'L4', what: 'L3 + srt_rotate 15 deg -> seam oblique', cfg: { ribWidth: 73, bow: 1, srt_scale: 1.07, srt_rotate: 15 } },
      { step: 'L5', what: 'L3 + ior 2.5 -> 31.5% of the rib minifies', cfg: { ribWidth: 73, bow: 1, srt_scale: 1.07, ior: 2.5 } },
      { step: 'L6', what: 'L3 + curvature 1.5 -> mirror fold active, 29.2% minifies', cfg: { ribWidth: 73, bow: 1, srt_scale: 1.07, curvature: 1.5 } },
    ]
    let prev: number | null = null
    for (const s of steps) {
      const bc: BenchConfig = { id: s.step, cfg: s.cfg, dpr: 1, stimulus: 'photo' }
      const field = await renderSeamField(c, bc, b)
      const band = seamBand(field, SEAM_BAND_PX, MASK_MARGIN)
      const gt = (await renderCandidate(c, bc, CANDIDATE_BY_ID['A8'], b)).img
      const a0 = maskedDiff((await renderCandidate(c, bc, CANDIDATE_BY_ID['A0'], b)).img, gt, band)
      const a3 = maskedDiff((await renderCandidate(c, bc, CANDIDATE_BY_ID['A3'], b)).img, gt, band)
      const row: LadderRow = {
        step: s.step, what: s.what, cfg: JSON.stringify(s.cfg),
        a0Mean: a0.mean, a0P95: a0.p95, a0Max: a0.max, a3Mean: a3.mean,
        deltaFromPrev: prev === null ? null : a0.mean - prev,
      }
      ladder.push(row)
      prev = a0.mean
      console.log(`  ${s.step}  A0 mean=${f(a0.mean, 3)} p95=${a0.p95} max=${a0.max}  A3 mean=${f(a3.mean, 3)}  ${row.deltaFromPrev === null ? '' : `delta ${row.deltaFromPrev >= 0 ? '+' : ''}${f(row.deltaFromPrev, 3)}`}   ${s.what}`)
    }
    // L0 is NOT expected to be zero. At ior = 1 the node is the identity, so A0
    // reproduces the source exactly while A8 box-filters it — the gap between
    // them is the BOX PREFILTER FLOOR, which every candidate carries and which
    // is not aliasing. The control is therefore: A0 == the source byte-exactly,
    // and A8 == the CPU 16x16 box of bilinear taps. (The first version of this
    // gate asserted A0 == A8 and fired on this known-good.)
    const l0 = ladder[0]
    {
      const idBc: BenchConfig = { id: 'L0', cfg: { ribWidth: 73, ior: 1 }, dpr: 1, stimulus: 'photo' }
      const a0img = (await renderCandidate(c, idBc, CANDIDATE_BY_ID['A0'], b)).img
      const a8img = (await renderCandidate(c, idBc, CANDIDATE_BY_ID['A8'], b)).img
      const cpu = cpuIdentitySupersample(photo, GT_SS)
      const dA0 = maskedDiff(a0img, photo)
      const dA8 = maskedDiff(a8img, cpu)
      const dA8vsPoint = maskedDiff(a8img, photo)
      gate(gates, 'P1', 'identity control: at ior = 1 each arm equals its own CPU expectation',
        `A0 vs the source itself: max ${dA0.max} codes; A8 vs a CPU ${GT_SS}x${GT_SS} box of bilinear taps: mean ${f(dA8.mean, 3)}`,
        `A8 vs a POINT sample of the source reads ${f(dA8vsPoint.mean, 3)} codes — that is the prefilter, and a gate that expected 0 there would fire on this known-good`,
        'A0 max = 0 codes AND A8-vs-CPU mean <= 0.5 codes AND A8-vs-point > 4x A8-vs-CPU',
        dA0.max === 0 && dA8.mean <= 0.5 && dA8vsPoint.mean > 4 * Math.max(dA8.mean, 1e-6),
        `A0max=${dA0.max}  A8vsCPU=${f(dA8.mean, 4)} (p95 ${dA8.p95})  A8vsPoint=${f(dA8vsPoint.mean, 3)}`)
      console.log(`  -> BOX PREFILTER FLOOR at ior=1 (seam-band A0 vs A8): ${f(l0.a0Mean, 3)} codes; A3 removes it to ${f(l0.a3Mean, 3)}`)
    }

    // -------------------------------------------------------------------
    console.log('\n--- ANIMATED_DPR_SCALE (framebuffer shrink + compositor upscale) ---')
    // -------------------------------------------------------------------
    // One fixed CSS scene: 600x400 CSS px at devicePixelRatio 2.
    //   static   -> min(dpr,2) * STATIC_DPR_SCALE  (1.00) = 2.00 -> 1200x800 buffer
    //   animated -> min(dpr,2) * ANIMATED_DPR_SCALE (0.75) = 1.50 ->  900x600 buffer
    // Both are then presented in the same 600x400 CSS box, so the animated arm
    // is bilinearly magnified 1.333x. Everything is scored against the STATIC
    // ground truth, which is what the display would show at full quality.
    const dprCfg: ReedCfg = { ribWidth: 73, srt_scale: 1.07 }
    const staticBc: BenchConfig = { id: 'dpr-static', cfg: dprCfg, dpr: 2, stimulus: 'photo' }
    const staticField = await renderSeamField(c, staticBc, b)
    const staticBand = seamBand(staticField, SEAM_BAND_PX, MASK_MARGIN)
    const staticGt = (await renderCandidate(c, staticBc, CANDIDATE_BY_ID['A8'], b)).img

    // Both arms get the IDENTICAL source bitmap. Pre-resampling it to 900x600
    // on the CPU would hand the animated arm a softer input than the static
    // arm and charge the difference to ANIMATED_DPR_SCALE; the image node does
    // the fitting itself, and both graphs are built at the same 3:2 aspect, so
    // the framing matches.
    const AW = 900
    const AH = 600
    const animCtx: Ctx = { rig, stimuli: c.stimuli, width: AW, height: AH }
    const animBc: BenchConfig = { id: 'dpr-anim-buf', cfg: dprCfg, dpr: 1.5, stimulus: 'photo' }

    const arms: Array<{ arm: string; buf: string; uDpr: number; cand: string; img: Rgba8 }> = []
    for (const k of ['A0', 'A3', 'A8']) {
      arms.push({
        arm: 'static 1.00', buf: `${W}x${H}`, uDpr: 2, cand: k,
        img: (await renderCandidate(c, staticBc, CANDIDATE_BY_ID[k], b)).img,
      })
    }
    for (const k of ['A0', 'A3', 'A8']) {
      const small = (await renderCandidate(animCtx, animBc, CANDIDATE_BY_ID[k], b)).img
      arms.push({ arm: 'animated 0.75', buf: `${AW}x${AH}`, uDpr: 1.5, cand: k, img: bilinearResize(small, W, H) })
    }
    for (const a of arms) {
      const d = maskedDiff(a.img, staticGt, staticBand)
      const g = globalFidelity(a.img, staticGt)
      dprRows.push({
        arm: a.arm, bufferPx: a.buf, uDpr: a.uDpr, candidate: a.cand,
        meanVsStaticGt: d.mean, p95VsStaticGt: d.p95, maxVsStaticGt: d.max, hfLoss: g.hfLoss,
      })
      console.log(`  ${a.arm.padEnd(14)} ${a.buf.padEnd(9)} u_dpr=${a.uDpr}  ${a.cand.padEnd(3)}  seam-band mean=${f(d.mean, 3)} p95=${d.p95} max=${d.max}  hfLoss=${f(g.hfLoss, 3)}`)
    }
    const get = (arm: string, cand: string): DprRow => dprRows.find((r) => r.arm === arm && r.candidate === cand)!
    const get3 = (arm: string, cand: string): Rgba8 => arms.find((a) => a.arm === arm && a.cand === cand)!.img
    gate(gates, 'P2', 'the DPR arms are comparable: the static GT is a true zero against itself',
      'static A8 vs static A8 = 0.000', 'nonzero would mean the reference is not the reference',
      'static/A8 mean = 0.000', get('static 1.00', 'A8').meanVsStaticGt === 0,
      `static/A8 mean=${f(get('static 1.00', 'A8').meanVsStaticGt, 4)}`)
    // `bilinearResize` must be the identity at scale 1, or the animated arm's
    // number is partly my own resampler.
    const idResize = maskedDiff(bilinearResize(get3('static 1.00', 'A0'), W, H), get3('static 1.00', 'A0'))
    gate(gates, 'P4', 'the compositor model is the identity at scale 1',
      'bilinearResize(img, sameSize) vs img', 'a resampler with a half-texel bias would show here and would be charged to the DPR scale',
      'max = 0 codes', idResize.max === 0, `max=${idResize.max} mean=${f(idResize.mean, 4)}`)

    const aliasingOnly = get('static 1.00', 'A0').meanVsStaticGt
    const resolutionOnly = get('animated 0.75', 'A8').meanVsStaticGt
    const both = get('animated 0.75', 'A0').meanVsStaticGt
    const fixedAtLowRes = get('animated 0.75', 'A3').meanVsStaticGt
    const fixedAtFullRes = get('static 1.00', 'A3').meanVsStaticGt
    // These are mean-absolute deviations from a common reference; they do NOT
    // add, so no percentage of `both` is quoted for either in isolation. What
    // IS well defined is how much of the shipped error a node-side fix can
    // remove, in each of the two renderer states.
    const recoverableStatic = (aliasingOnly - fixedAtFullRes) / aliasingOnly
    const recoverableAnim = (both - fixedAtLowRes) / both
    const irreducibleAnim = resolutionOnly / both
    console.log(`\n  aliasing alone   (static 1.00, 1 tap)        : ${f(aliasingOnly, 3)} codes`)
    console.log(`  resolution alone (animated 0.75, PERFECT AA) : ${f(resolutionOnly, 3)} codes`)
    console.log(`  both             (animated 0.75, 1 tap)      : ${f(both, 3)} codes  <- what ships while animating`)
    console.log(`  node fix applied (static 1.00, A3)           : ${f(fixedAtFullRes, 3)} codes`)
    console.log(`  node fix applied (animated 0.75, A3)         : ${f(fixedAtLowRes, 3)} codes`)
    console.log(`  -> a node-side fix removes ${f(100 * recoverableStatic, 1)}% of the error when NOT animating`)
    console.log(`  -> a node-side fix removes ${f(100 * recoverableAnim, 1)}% of the error while animating`)
    console.log(`  -> floor a node fix cannot cross while animating: ${f(resolutionOnly, 3)} codes = ${f(100 * irreducibleAnim, 1)}% of the shipped error`)

    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'phase10-apportion.json'), JSON.stringify({
      generated: new Date().toISOString(), backend: b, width: W, height: H,
      seamBandPx: SEAM_BAND_PX, groundTruthSupersample: GT_SS,
      zones, ladder, dpr: dprRows,
      dprShares: { aliasingOnly, resolutionOnly, both, fixedAtLowRes },
      gates,
    }, null, 2))
    console.log(`\nwrote ${path.join(OUT_DIR, 'phase10-apportion.json')}`)
    const nFail = gates.filter((g) => !g.pass).length
    console.log(`${gates.length - nFail}/${gates.length} apportionment gates pass`)
    if (nFail) process.exit(1)
  } finally {
    await rig.close()
  }
}

// ===========================================================================

async function main(): Promise<void> {
  const mode = process.argv.includes('--sweep') ? 'sweep'
    : process.argv.includes('--apportion') ? 'apportion'
      : 'validate'
  if (mode === 'sweep') await sweep()
  else if (mode === 'apportion') await apportion()
  else await validate()
}

// Importable: only self-run when invoked directly, so diagnostics can reuse the
// candidate builders without triggering a full validation pass.
if ((process.argv[1] ?? '').endsWith('phase10-reed-aa.ts')) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
