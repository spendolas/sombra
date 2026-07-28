/**
 * Phase 10c — adversarial TRANSFER probe for the phase-10b winner (A3, RGSS-4).
 *
 * Phase 10b measured A3 in a bench WRAPPER. This file attacks the step the
 * bench never took: writing A3 into `src/nodes/transform/reeded-glass.ts` and
 * getting the same numbers out of the real dual-backend emitter.
 *
 * Every probe is calibrated: a known-good control must pass and a known-bad
 * control must fail, or the probe reports UNCALIBRATED and its verdict is void.
 *
 * Probes
 *   T1  can the node body be hoisted into a helper function? (assembler text +
 *       real Tint compile)
 *   T2  y-orientation: how large is the "author forgot the flip" bug, and can
 *       phase-10b's own cross-backend gate see it?
 *   T3  alpha: benched A3 averages straight-alpha vec4s. Measure the error the
 *       node's own premultiplied rule exists to prevent.
 *   T6  mechanical GLSL->WGSL of the constructs the frost-sharing scheme needs.
 *
 * Writes nothing outside reports/blur-bakeoff/phase10/.
 * Run: npx tsx scripts/blur-bakeoff/phase10-transfer-probe.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { assembleWGSL } from '../../src/compiler/ir/wgsl-assembler'
import { lowerStmtToWGSL } from '../../src/compiler/ir/wgsl-backend'
import { raw } from '../../src/compiler/ir/types'
import type { IRFunction, IRNodeOutput } from '../../src/compiler/ir/types'
import { createAaRig, type AaRig, type AaPass, type Backend } from './phase10-aa-rig'
import {
  buildGraph, candidatePasses, CANDIDATE_BY_ID,
  type Candidate, type ReedCfg,
} from './phase10-reed-aa'
import { transparentEdgeSprite } from './lib/corpus'
import type { Rgba8 } from './lib/image'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase10')
const OUT_JSON = path.join(OUT_DIR, 'phase10-transfer.json')

const W = 800
const H = 600

interface Gate { id: string; what: string; pass: boolean; detail: string }
const gates: Gate[] = []
function gate(id: string, what: string, pass: boolean, detail: string): void {
  gates.push({ id, what, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(6)} ${what}\n         ${detail}`)
}

const f = (n: number, d = 3): string => n.toFixed(d)

// ===========================================================================
// T1 — can the node body live in a helper function?
// ===========================================================================

function mkOutput(fns: IRFunction[]): IRNodeOutput {
  return {
    statements: [raw('fragColor = vec4(sombra_helper(), 0.0, 0.0, 1.0);')],
    uniforms: [],
    standardUniforms: new Set(['u_resolution', 'u_viewport']),
    functions: fns,
  }
}

function t1Static(): { bad: string; good: string } {
  // KNOWN-BAD: the helper reads gl_FragCoord / v_uv, exactly as the node body
  // does today. This is what a "hoist the body into a function" transfer emits.
  const badFn: IRFunction = {
    key: 'sombra_helper', name: 'sombra_helper', params: [], returnType: 'vec2',
    body: [raw('return gl_FragCoord.xy / u_viewport + v_uv;')],
  }
  // KNOWN-GOOD: the same maths with the varyings passed in as parameters.
  const goodFn: IRFunction = {
    key: 'sombra_helper', name: 'sombra_helper',
    params: [{ name: 'fc', type: 'vec2' }, { name: 'uv', type: 'vec2' }],
    returnType: 'vec2',
    body: [raw('return fc / u_viewport + uv;')],
  }
  const bad = assembleWGSL([mkOutput([badFn])], new Set(['u_resolution', 'u_viewport']), []).shaderCode
  const good = assembleWGSL([mkOutput([goodFn])], new Set(['u_resolution', 'u_viewport']), []).shaderCode
  return { bad, good }
}

/** Extract the module-scope helper text (everything before @fragment). */
function moduleScope(src: string): string {
  const i = src.indexOf('@fragment')
  return i < 0 ? src : src.slice(0, i)
}

// ===========================================================================
// T2 / T3 — GPU probes
// ===========================================================================

interface Diff { mean: number; p95: number; max: number }

function diff(a: Rgba8, b: Rgba8): Diff {
  const n = Math.min(a.data.length, b.data.length)
  const vals: number[] = []
  let sum = 0
  let mx = 0
  let cnt = 0
  for (let i = 0; i < n; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const d = Math.abs(a.data[i + ch] - b.data[i + ch])
      sum += d; cnt++
      if (d > mx) mx = d
      vals.push(d)
    }
  }
  vals.sort((x, y) => x - y)
  return { mean: sum / cnt, p95: vals[Math.floor(vals.length * 0.95)], max: mx }
}

/** Alpha-channel-only diff. */
function diffA(a: Rgba8, b: Rgba8): Diff {
  const n = Math.min(a.data.length, b.data.length)
  const vals: number[] = []
  let sum = 0; let mx = 0; let cnt = 0
  for (let i = 3; i < n; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i])
    sum += d; cnt++
    if (d > mx) mx = d
    vals.push(d)
  }
  vals.sort((x, y) => x - y)
  return { mean: sum / cnt, p95: vals[Math.floor(vals.length * 0.95)], max: mx }
}

/**
 * Text surgery on the bench's generated `sombra_mk` / `sombra_at`, which is
 * where the sub-sample offset meets the two varyings.
 *
 *   'correct' — as phase-10b generated it
 *   'mirror'  — the whole 4-rook pattern reflected in y, still self-consistent
 *               (models "author picked the opposite global y sense")
 *   'desync'  — the same sign applied to BOTH varyings, so the lens pattern and
 *               the fetch position disagree by 2*off.y (models "author let
 *               mechanical translation handle it / dropped one flip") — the
 *               exact shape of the two prior WebGPU-only bugs in this file.
 */
type YVariant = 'correct' | 'mirror' | 'desync'

function patchY(src: string, kind: 'wgsl' | 'glsl', v: YVariant): string {
  if (v === 'correct') return src
  if (kind === 'wgsl') {
    const pos = 'base.position.y + off.y'
    const uv = 'base.v_uv.y - off.y /'
    if (!src.includes(pos) || !src.includes(uv)) throw new Error('patchY: wgsl anchors not found')
    if (v === 'desync') return src.replace(uv, 'base.v_uv.y + off.y /')
    return src.replace(pos, 'base.position.y - off.y').replace(uv, 'base.v_uv.y + off.y /')
  }
  const pos = 'fc.y + off.y'
  const uv = 'uv.y + off.y /'
  if (!src.includes(pos) || !src.includes(uv)) throw new Error('patchY: glsl anchors not found')
  if (v === 'desync') return src.replace(uv, 'uv.y - off.y /')
  return src.replace(pos, 'fc.y - off.y').replace(uv, 'uv.y - off.y /')
}

/** A3 with premultiplied accumulation — what the node's own rule requires. */
const A3_PREMUL: Candidate = {
  id: 'A3pm', label: 'RGSS 4-rook, premultiplied accumulation', nominalFetches: 4,
  build: (L) => {
    const offs: Array<[number, number]> = [[-0.125, -0.375], [0.375, -0.125], [-0.375, 0.125], [0.125, 0.375]]
    const t = offs.map(([x, y], i) => `  ${L.varv4(`sg_t${i}`, L.at(L.v2(L.fnum(x), L.fnum(y))))}`)
    const rgb = offs.map((_, i) => `sg_t${i}.rgb * sg_t${i}.a`).join(' + ')
    const a = offs.map((_, i) => `sg_t${i}.a`).join(' + ')
    const v3 = L.kind === 'wgsl' ? 'vec3f' : 'vec3'
    const decl3 = L.kind === 'wgsl' ? `let sg_rgb: vec3f = ${rgb};` : `vec3 sg_rgb = ${rgb};`
    const setup = [
      ...t,
      `  ${decl3}`,
      `  ${L.letf('sg_a', a)}`,
    ].join('\n')
    const div = L.kind === 'wgsl' ? `${v3}(max(sg_a, 1e-5))` : 'max(sg_a, 1e-5)'
    const ctor = L.kind === 'wgsl' ? 'vec4f' : 'vec4'
    return { setup, expr: `${ctor}(sg_rgb / ${div}, sg_a * 0.25)` }
  },
}

async function render(
  rig: AaRig, backend: Backend, cfg: ReedCfg, dpr: number, cand: Candidate, stim: Rgba8,
  patch?: (src: string, kind: 'wgsl' | 'glsl') => string,
): Promise<Rgba8> {
  const g = buildGraph(cfg, W / H, {})
  const ctx = { frostRadiusPx: (cfg.frost ?? 0) * 24 * dpr, periodPx: (cfg.ribWidth ?? 80) * dpr * (cfg.srt_scale ?? 1) }
  const passes: AaPass[] = candidatePasses(g, cand, W, H, ctx, 'color')
  if (patch) {
    const last = passes[passes.length - 1]
    last.wgsl = patch(last.wgsl, 'wgsl')
    last.glslFrag = patch(last.glslFrag, 'glsl')
  }
  const r = await rig.run({ backend, width: W, height: H, dpr, passes, images: { [g.imageSampler]: stim } })
  return r.image
}

// ===========================================================================
// T6 — mechanical translation of the frost-sharing constructs
// ===========================================================================

function t6(): Array<{ what: string; glsl: string; wgsl: string; ok: boolean }> {
  const cases: Array<{ what: string; glsl: string }> = [
    { what: 'const array + dynamic index (needed to give frost tap j offset j&3)', glsl: 'const vec2 rk[4] = vec2[4](vec2(-0.125, -0.375), vec2(0.375, -0.125), vec2(-0.375, 0.125), vec2(0.125, 0.375));' },
    { what: 'array read with loop-variable index', glsl: 'vec2 sg_o = rk[i & 3];' },
    { what: 'plain vec2 declaration (known-good control)', glsl: 'vec2 sg_o = vec2(0.125, 0.375);' },
  ]
  return cases.map((c) => {
    const wgsl = lowerStmtToWGSL(raw(c.glsl))
    // a translated statement is "handled" only if no GLSL-only spelling survives
    const leaked = /\bvec2\s+\w+|\bconst\s+vec2|vec2\[4\]|\bfloat\s+\w+\s*=/.test(wgsl)
    return { what: c.what, glsl: c.glsl, wgsl, ok: !leaked }
  })
}

// ===========================================================================
// main
// ===========================================================================

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const report: Record<string, unknown> = { generated: new Date().toISOString(), width: W, height: H }

  // ---- T1 ----------------------------------------------------------------
  console.log('\nT1  function hoist — does the WGSL assembler survive it?')
  const { bad, good } = t1Static()
  const badScope = moduleScope(bad)
  const goodScope = moduleScope(good)
  const badLeak = /\bin\.(position|v_uv)/.test(badScope)
  const goodLeak = /\bin\.(position|v_uv)/.test(goodScope)
  gate('T1a', 'known-bad: helper reading gl_FragCoord/v_uv emits `in.` at module scope',
    badLeak, badLeak
      ? `module scope contains: ${(badScope.match(/in\.(position|v_uv)[^\s;,)]*/g) ?? []).join(', ')}`
      : 'no leak — probe is UNCALIBRATED')
  gate('T1b', 'known-good: helper taking params emits no `in.` at module scope',
    !goodLeak, goodLeak ? 'unexpected leak' : 'clean')
  report.t1 = {
    knownBadModuleScope: badScope.split('\n').filter((l) => l.includes('in.')).map((l) => l.trim()),
    assemblerLines: 'src/compiler/ir/wgsl-assembler.ts:275-276',
  }

  // ---- T6 ----------------------------------------------------------------
  console.log('\nT6  mechanical GLSL->WGSL of the frost-sharing constructs')
  const t6r = t6()
  for (const r of t6r) {
    console.log(`  ${r.ok ? 'translated' : 'UNTRANSLATED'}  ${r.what}\n       GLSL: ${r.glsl}\n       WGSL: ${r.wgsl}`)
  }
  gate('T6a', 'known-good control: plain vec2 decl IS mechanically translated',
    t6r[2].ok, `-> ${t6r[2].wgsl}`)
  gate('T6b', 'array constructs are NOT translated (would need a hand-written arm)',
    !t6r[0].ok || !t6r[1].ok,
    `array decl ok=${t6r[0].ok}, indexed read ok=${t6r[1].ok}`)
  report.t6 = t6r

  // ---- GPU ---------------------------------------------------------------
  const rig = await createAaRig()
  console.log(`\nGPU: ${rig.adapterInfo}  webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2}`)
  report.adapter = rig.adapterInfo

  try {
    // ---- T1c: does the hoisted form actually fail to compile? -------------
    console.log('\nT1c real Tint compile of a hoisted helper')
    const gh = buildGraph({ ribWidth: 73, srt_scale: 1.07 }, W / H, {})
    const hoisted = { ...gh.passes[gh.passes.length - 1] }
    // Move one real body line into a module-scope fn, exactly as a hoist would.
    const anchor = 'struct VertexOutput'
    hoisted.wgsl = hoisted.wgsl.replace(
      anchor,
      `fn sombra_hoisted() -> vec2f { return in.position.xy / uniforms.u_viewport; }\n\n${anchor}`,
    )
    let tintErr = ''
    try {
      await rig.run({
        backend: 'webgpu', width: 64, height: 64, dpr: 1,
        passes: [...gh.passes.slice(0, -1), hoisted],
        images: { [gh.imageSampler]: transparentEdgeSprite(64, 64) },
      })
    } catch (e) { tintErr = String(e) }
    gate('T1c', 'known-bad: `in.` at WGSL module scope is rejected by Tint',
      tintErr.length > 0, tintErr ? tintErr.split('\n').slice(0, 3).join(' | ').slice(0, 220) : 'COMPILED — probe UNCALIBRATED')
    report.t1c = tintErr.slice(0, 2000)

    // ---- T2: y-orientation ------------------------------------------------
    console.log('\nT2  y-orientation of the sub-sample offset')
    const photoBytes = pickPhoto()
    const photo = await rig.decodeImage(photoBytes.bytes, photoBytes.mime, 2048)
    const stim = coverCrop(photo, W, H)
    const t2: Array<Record<string, unknown>> = []
    const cfgs: Array<[string, ReedCfg, number]> = [
      ['misaligned', { ribWidth: 73, srt_scale: 1.07 }, 1],
      ['rot45', { ribWidth: 73, srt_rotate: 45 }, 1],
      ['bow0', { ribWidth: 73, bow: 0 }, 1],
      ['wave-sine', { ribWidth: 73, ribType: 'wave', waveShape: 'sine' }, 1],
    ]
    for (const [name, cfg, dpr] of cfgs) {
      const gt = await render(rig, 'webgpu', cfg, dpr, CANDIDATE_BY_ID['A8'], stim)
      const a0 = await render(rig, 'webgpu', cfg, dpr, CANDIDATE_BY_ID['A0'], stim)
      const out: Record<string, unknown> = { config: name }
      const base: Record<YVariant, Rgba8> = {} as Record<YVariant, Rgba8>
      for (const v of ['correct', 'mirror', 'desync'] as YVariant[]) {
        base[v] = await render(rig, 'webgpu', cfg, dpr, CANDIDATE_BY_ID['A3'], stim, (s, k) => patchY(s, k, v))
      }
      const dv0 = diff(a0, gt)
      out.A0_vs_GT = dv0
      for (const v of ['correct', 'mirror', 'desync'] as YVariant[]) {
        out[`${v}_vs_GT`] = diff(base[v], gt)
        out[`${v}_vs_correct`] = diff(base[v], base.correct)
      }
      // GLSL desync, to show the same bug on the other backend
      const glCorrect = await render(rig, 'webgl2', cfg, dpr, CANDIDATE_BY_ID['A3'], stim)
      out.glsl_correct_vs_wgsl_correct = diff(glCorrect, base.correct)
      t2.push(out)
      const g = (k: string): Diff => out[k] as Diff
      console.log(`  ${name.padEnd(11)} A0 ${f(dv0.mean)}  |  vs GT: correct ${f(g('correct_vs_GT').mean)}  mirror ${f(g('mirror_vs_GT').mean)}  desync ${f(g('desync_vs_GT').mean)}`)
      console.log(`  ${''.padEnd(11)} vs correct: mirror ${f(g('mirror_vs_correct').mean)}/p95 ${g('mirror_vs_correct').p95}/max ${g('mirror_vs_correct').max}   desync ${f(g('desync_vs_correct').mean)}/p95 ${g('desync_vs_correct').p95}/max ${g('desync_vs_correct').max}`)
      console.log(`  ${''.padEnd(11)} cross-backend (both 'correct', mirrored patterns): ${f((out.glsl_correct_vs_wgsl_correct as Diff).mean)} mean, max ${(out.glsl_correct_vs_wgsl_correct as Diff).max}`)
    }
    report.t2 = t2
    // Gate: the desync must be measurably worse than correct on at least one
    // config (known-bad), and the mirror must be indistinguishable (known-good).
    const worst = t2.map((r) => (r.desync_vs_GT as Diff).mean - (r.correct_vs_GT as Diff).mean)
    const mirr = t2.map((r) => Math.abs((r.mirror_vs_GT as Diff).mean - (r.correct_vs_GT as Diff).mean))
    gate('T2a', 'desync (dropped y-flip) degrades the result vs correct A3',
      Math.max(...worst) > 0.05, `worst config Δmean = +${f(Math.max(...worst))} codes`)
    gate('T2b', 'y-mirror is NOT distinguishable — the bench ran mirrored patterns per backend',
      Math.max(...mirr) < 0.15, `worst |Δmean| vs correct = ${f(Math.max(...mirr))} codes`)

    // ---- T3: alpha ---------------------------------------------------------
    console.log('\nT3  alpha — straight-average (as benched) vs premultiplied (node rule)')
    const sprite = transparentEdgeSprite(W, H)
    const alphaRange = (() => {
      let mn = 255; let mx = 0
      for (let i = 3; i < sprite.data.length; i += 4) { mn = Math.min(mn, sprite.data[i]); mx = Math.max(mx, sprite.data[i]) }
      return [mn, mx]
    })()
    const cfgA: ReedCfg = { ribWidth: 73, srt_scale: 1.07 }
    const straight = await render(rig, 'webgpu', cfgA, 1, CANDIDATE_BY_ID['A3'], sprite)
    const premul = await render(rig, 'webgpu', cfgA, 1, A3_PREMUL, sprite)
    const dRGB = diff(straight, premul)
    const dA = diffA(straight, premul)
    // known-good control: on an opaque stimulus the two must be identical
    const opaque = coverCrop(photo, W, H)
    const sO = await render(rig, 'webgpu', cfgA, 1, CANDIDATE_BY_ID['A3'], opaque)
    const pO = await render(rig, 'webgpu', cfgA, 1, A3_PREMUL, opaque)
    const dO = diff(sO, pO)
    report.t3 = { spriteAlphaRange: alphaRange, transparentRGB: dRGB, transparentA: dA, opaqueControl: dO }
    console.log(`  sprite alpha range in the stimulus: ${alphaRange[0]}..${alphaRange[1]}`)
    console.log(`  transparent: RGB mean ${f(dRGB.mean)} p95 ${dRGB.p95} max ${dRGB.max}   A mean ${f(dA.mean)} max ${dA.max}`)
    console.log(`  opaque control: RGB mean ${f(dO.mean)} max ${dO.max}`)
    gate('T3a', 'known-good: on opaque content the two accumulations agree',
      dO.max <= 1, `max ${dO.max} codes`)
    gate('T3b', 'known-bad: on transparent content they diverge',
      dRGB.max > 2, `max ${dRGB.max} codes, mean ${f(dRGB.mean)}`)
  } finally {
    await rig.close()
  }

  report.gates = gates
  const passed = gates.filter((g) => g.pass).length
  console.log(`\n${passed}/${gates.length} gates pass`)
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2))
  console.log(`wrote ${OUT_JSON}`)
}

// --- small local helpers (duplicated deliberately: no phase9/shared edits) ---

function pickPhoto(): { bytes: Uint8Array; mime: string } {
  const dir = 'stuff'
  const files = fs.readdirSync(dir).filter((n) => /\.(jpe?g|png|webp)$/i.test(n)).sort()
  if (files.length === 0) throw new Error('no photo in stuff/')
  const p = path.join(dir, files[0])
  const ext = path.extname(p).toLowerCase()
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return { bytes: new Uint8Array(fs.readFileSync(p)), mime }
}

function coverCrop(img: Rgba8, w: number, h: number): Rgba8 {
  const s = Math.max(w / img.width, h / img.height)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, Math.round((x - w / 2) / s + img.width / 2)))
      const sy = Math.min(img.height - 1, Math.max(0, Math.round((y - h / 2) / s + img.height / 2)))
      const o = (y * w + x) * 4
      const i = (sy * img.width + sx) * 4
      out[o] = img.data[i]; out[o + 1] = img.data[i + 1]; out[o + 2] = img.data[i + 2]; out[o + 3] = 255
    }
  }
  return { width: w, height: h, data: out }
}

main().catch((e) => { console.error(e); process.exit(1) })
