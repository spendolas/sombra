/**
 * Phase 14 — the correct filter for Reeded Glass, derived. Pure CPU maths.
 *
 * Mirrors REED_LENS_BODY from src/nodes/transform/reeded-glass.ts in doubles,
 * plus the full screen-space delta (emitRibGradient / emitDeltaTail / emitLensTail
 * / emitSeamGeometry) for vertical sine-wave ribs with identity SRT, so every
 * number below comes from the shipped map, not from a paraphrase of it.
 *
 * No GPU. Outputs reports/blur-bakeoff/phase14/derivation.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'

// ---------------------------------------------------------------- GLSL scalars
const fract = (v: number) => v - Math.floor(v)
const glslMod = (a: number, b: number) => a - b * Math.floor(a / b)

// ---------------------------------------------------------------- reedLens 1:1
interface LensCfg { ior: number; curvature: number }

/** k = c2 and amp exactly as the shader derives them. */
function lensConstants({ ior, curvature }: LensCfg) {
  const c = Math.min(Math.max(curvature, 0.01), 1.0)
  const amp = curvature > 1.0 ? curvature : 1.0
  const k = Math.min(c, 0.99)
  const A = (ior - 1.0) * amp * k
  return { c, amp, k, A }
}

/** L(local) = local + disp, the pre-fold remap, in rib-width units. */
function Lraw(local: number, cfg: LensCfg): number {
  const { amp, k } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  const x2 = x * x * k * k
  const slope = (x * k) / Math.sqrt(Math.max(1.0 - x2, 0.001))
  return local + -slope * (cfg.ior - 1.0) * 0.5 * amp
}

/** Analytic L'(local) = 1 - A / (1 - k^2 x^2)^{3/2}. */
function Lprime(local: number, cfg: LensCfg): number {
  const { k, A } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  return 1.0 - A / Math.pow(1.0 - k * k * x * x, 1.5)
}

/** mirror fold, period 2, |slope| 1 */
const T = (L: number) => 1.0 - Math.abs(fract(L * 0.5) * 2.0 - 1.0)

/** sagitta term, = lens.y / ((ior-1)*amp) */
function sagNorm(local: number, cfg: LensCfg): number {
  const { k } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  const x2 = x * x * k * k
  return (Math.sqrt(Math.max(1.0 - x2, 0.0)) - Math.sqrt(Math.max(1.0 - k * k, 0.0))) / k
}

/** reedLens(coord, ribW, ior, curvature) -> vec2, coord/ribW in the same units */
function reedLens(coord: number, ribW: number, cfg: LensCfg): [number, number] {
  const { amp } = lensConstants(cfg)
  const local = glslMod(coord, ribW) / ribW
  const lensed = T(Lraw(local, cfg))
  const sag = sagNorm(local, cfg)
  return [(Math.floor(coord / ribW) + lensed) * ribW, sag * (cfg.ior - 1.0) * amp]
}

// ------------------------------------------------------- full screen-space map
interface Scene {
  ribWidth: number; ior: number; curvature: number; bow: number
  amplitude: number; wavelength: number   // px @ dpr 1
  dpr: number
}

const USER: Scene = {
  ribWidth: 80, ior: 1.65, curvature: 2.15, bow: 2.72,
  amplitude: 20, wavelength: 577, dpr: 1.5,
}
const DEFAULTS: Scene = {
  ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 1.0,
  amplitude: 20, wavelength: 577, dpr: 2.0,
}

/** rib period on screen, device px (srt_scale 1) */
const ribPx = (s: Scene) => s.ribWidth * s.dpr

/** wave field in device px: w(perp_px), and its analytic perp gradient gp */
function waveAt(s: Scene, perpPx: number) {
  const ampPx = s.amplitude * s.dpr
  const wlPx = s.wavelength * s.dpr
  const w = Math.sin((perpPx / wlPx) * 6.28318) * ampPx
  const gp = (6.28318 * ampPx / wlPx) * Math.cos((perpPx / wlPx) * 6.28318)
  return { w, gp }
}

/**
 * The sampled source position, device px, for vertical ribs / sine wave /
 * identity SRT. mainPx = x (cross-rib), perpPx = y. gm = 0 for every wave
 * shape (perp-only field), so den = 1 + gp^2.
 */
function sampleAt(s: Scene, mainPx: number, perpPx: number): [number, number] {
  const R = ribPx(s)
  const { w, gp } = waveAt(s, perpPx)
  const W = mainPx + w
  const [lensMain, lensY] = reedLens(W, R, s)
  const disp = lensMain - W
  const den = 1.0 + gp * gp
  const bow = lensY * (R * 0.5) * s.bow
  const dMain = disp / den
  const dPerp = (disp * gp) / den + bow
  return [mainPx + dMain, perpPx + dPerp]
}

// ------------------------------------------------------------------ 1. checks
const report: Record<string, unknown> = {}

// L' analytic vs central difference of the shipped Lraw
{
  const cases: LensCfg[] = [
    { ior: 1.5, curvature: 0.8 }, { ior: 1.65, curvature: 2.15 },
    { ior: 2.5, curvature: 0.8 }, { ior: 1.5, curvature: 1.5 },
  ]
  const rows = cases.map((cfg) => {
    let worst = 0, at = 0
    for (let i = 1; i < 2000; i++) {
      const local = i / 2000
      const h = 1e-6
      const fd = (Lraw(local + h, cfg) - Lraw(local - h, cfg)) / (2 * h)
      const an = Lprime(local, cfg)
      const rel = Math.abs(fd - an) / Math.max(1, Math.abs(an))
      if (rel > worst) { worst = rel; at = local }
    }
    return { ...cfg, worstRelErr: worst, atLocal: at }
  })
  report.LprimeValidation = rows
  console.log('\n=== L\' analytic vs finite difference of shipped body ===')
  for (const r of rows) console.log(`  ior ${r.ior} curv ${r.curvature}: worst rel err ${r.worstRelErr.toExponential(2)} @ local ${r.atLocal.toFixed(4)}`)
}

// ------------------------------------------------ 2. cliffs and the |L'| table
const supAbsLprime = (cfg: LensCfg) => {
  const { k, A } = lensConstants(cfg)
  return Math.max(Math.abs(1 - A), Math.abs(1 - A / Math.pow(1 - k * k, 1.5)))
}
/** minification exists somewhere in the rib  <=>  A > 2 (1-k^2)^{3/2} */
const minifyMargin = (cfg: LensCfg) => {
  const { k, A } = lensConstants(cfg)
  return A - 2 * Math.pow(1 - k * k, 1.5)
}
function bisect(f: (v: number) => number, lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi)
    if (f(lo) * f(m) <= 0) hi = m; else lo = m
  }
  return 0.5 * (lo + hi)
}
{
  const curvCliff = bisect((cv) => minifyMargin({ ior: 1.5, curvature: cv }), 0.5, 0.99)
  const iorCliff = bisect((io) => minifyMargin({ ior: io, curvature: 0.8 }), 1.0, 3.0)
  console.log('\n=== onset cliffs (A = 2(1-k^2)^{3/2}) ===')
  console.log(`  ior 1.50 -> curvature cliff = ${curvCliff.toFixed(6)}   (published 0.8095)`)
  console.log(`  curvature 0.80 -> ior cliff = ${iorCliff.toFixed(6)}   (published 1.5400)`)
  report.cliffs = { curvatureAtIor15: curvCliff, iorAtCurv08: iorCliff }

  const rows = [0.8, 0.85, 0.9, 1.0, 2.0].map((cv) => {
    const cfg = { ior: 1.5, curvature: cv }
    const { k, A } = lensConstants(cfg)
    return {
      curvature: cv, k, A,
      LprimeAt0: Lprime(0.5, cfg),
      supAbs: supAbsLprime(cfg),
      minifies: minifyMargin(cfg) > 0,
    }
  })
  report.supTable = rows
  console.log('\n=== sup|L\'| at ior 1.5 (sup is the |x|->1 limit, not attained) ===')
  for (const r of rows) console.log(`  curv ${r.curvature.toFixed(2)}  k ${r.k.toFixed(2)}  A ${r.A.toFixed(4)}  L'(0) ${r.LprimeAt0.toFixed(4)}  sup|L'| ${r.supAbs.toFixed(2)}  minifies ${r.minifies}`)
}

// -------------------------------------------------------- 3. the user's numbers
{
  const cfg = { ior: USER.ior, curvature: USER.curvature }
  const { c, amp, k, A } = lensConstants(cfg)
  const onsetX = Math.sqrt((1 - Math.pow(A / 2, 2 / 3)) / (k * k))
  const at = (x: number) => Lprime(0.5 * (x + 1), cfg)
  const sup = 1 - A / Math.pow(1 - k * k, 1.5)
  // worst value actually reached at a pixel CENTRE
  const worstAtPixelCentre = (dpr: number) => {
    const R = 80 * dpr
    let worst = 0, wx = 0
    for (let i = 0; i < R; i++) {
      const local = (i + 0.5) / R
      const v = Math.abs(Lprime(local, cfg))
      if (v > worst) { worst = v; wx = 2 * local - 1 }
    }
    return { dpr, ribPx: R, worst, x: wx }
  }
  const u = {
    c, amp, k, A, LprimeAt0: at(0), onsetX, fracMinifying: 1 - onsetX,
    absAt0p9: Math.abs(at(0.9)), absAt0p99: Math.abs(at(0.99)),
    supAbs: Math.abs(sup),
    pixelCentre: [worstAtPixelCentre(2), worstAtPixelCentre(1.5)],
  }
  report.user = u
  console.log('\n=== user scene: ior 1.65 / curvature 2.15 ===')
  console.log(`  c=${c} amp=${amp} k=${k} A=${A.toFixed(6)}`)
  console.log(`  L'(0) = ${u.LprimeAt0.toFixed(4)}   onset |x| = ${onsetX.toFixed(6)}   minifying fraction = ${(u.fracMinifying * 100).toFixed(2)}%`)
  console.log(`  |L'| @x=0.9 = ${u.absAt0p9.toFixed(3)}   @x=0.99 = ${u.absAt0p99.toFixed(2)}   sup(|x|->1) = ${u.supAbs.toFixed(2)}`)
  for (const p of u.pixelCentre) console.log(`  worst at a pixel CENTRE, dpr ${p.dpr} (rib ${p.ribPx} px): |L'| = ${p.worst.toFixed(2)} at x = ${p.x.toFixed(5)}`)
}

// ------------------------------------------------------- 4. zeros of L' (folds)
function LprimeZeros(cfg: LensCfg): number[] {
  const { k, A } = lensConstants(cfg)
  if (A > 1) return []
  const inner = 1 - Math.pow(A, 2 / 3)
  const x = Math.sqrt(inner) / k
  if (x > 1) return []
  return [-x, x]
}
/** every mirror-wrap fold: L(local) = integer, on each monotone branch of L */
function wrapFolds(cfg: LensCfg): { local: number; L: number }[] {
  const brk = LprimeZeros(cfg).map((x) => 0.5 * (x + 1)).sort((a, b) => a - b)
  const edges = [0, ...brk, 1]
  const out: { local: number; L: number }[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i] + 1e-12, b = edges[i + 1] - 1e-12
    const La = Lraw(a, cfg), Lb = Lraw(b, cfg)
    const lo = Math.ceil(Math.min(La, Lb) - 1e-9), hi = Math.floor(Math.max(La, Lb) + 1e-9)
    for (let m = lo; m <= hi; m++) {
      if (m === Math.min(La, Lb) || m === Math.max(La, Lb)) continue
      const local = bisect((t) => Lraw(t, cfg) - m, a, b)
      out.push({ local, L: m })
    }
  }
  return out.sort((p, q) => p.local - q.local)
}
{
  console.log('\n=== folds per rib ===')
  const rows = [
    { tag: 'defaults ior1.5/curv0.8', cfg: { ior: 1.5, curvature: 0.8 } },
    { tag: 'ior1.5/curv0.85', cfg: { ior: 1.5, curvature: 0.85 } },
    { tag: 'ior1.5/curv0.90', cfg: { ior: 1.5, curvature: 0.90 } },
    { tag: 'ior1.5/curv1.00', cfg: { ior: 1.5, curvature: 1.00 } },
    { tag: 'ior1.5/curv1.50', cfg: { ior: 1.5, curvature: 1.50 } },
    { tag: 'ior1.5/curv2.00', cfg: { ior: 1.5, curvature: 2.00 } },
    { tag: 'ior2.5/curv0.80', cfg: { ior: 2.5, curvature: 0.80 } },
    { tag: 'USER ior1.65/curv2.15', cfg: { ior: 1.65, curvature: 2.15 } },
  ].map(({ tag, cfg }) => {
    const z = LprimeZeros(cfg)
    const wf = wrapFolds(cfg)
    return {
      tag, ...lensConstants(cfg),
      LprimeZerosX: z, nLprimeZeros: z.length,
      nWrapFolds: wf.length, nFoldsTotal: z.length + wf.length,
      Lrange: [Lraw(1e-9, cfg), Lraw(1 - 1e-9, cfg)],
    }
  })
  report.folds = rows
  for (const r of rows) {
    console.log(`  ${r.tag.padEnd(24)} A=${r.A.toFixed(4)}  L'=0 zeros: ${r.nLprimeZeros}${r.nLprimeZeros ? ` at x=±${Math.abs(r.LprimeZerosX[1]).toFixed(4)}` : ''}  wrap folds: ${r.nWrapFolds}  TOTAL ${r.nFoldsTotal}  (L spans ${r.Lrange[0].toFixed(3)} .. ${r.Lrange[1].toFixed(3)})`)
  }
}

// fold geometry at the user's settings, in device px
{
  const cfg = { ior: USER.ior, curvature: USER.curvature }
  const wf = wrapFolds(cfg)
  for (const dpr of [2, 1.5]) {
    const R = 80 * dpr
    const px = wf.map((f) => f.local * R)
    const gaps: number[] = []
    for (let i = 1; i < px.length; i++) gaps.push(px[i] - px[i - 1])
    console.log(`\n  --- user folds, dpr ${dpr} (rib ${R} device px), ${wf.length} folds ---`)
    console.log('   i   local      x        px from seam   gap(px)   L    branch value T')
    wf.forEach((f, i) => {
      const g = i ? (px[i] - px[i - 1]).toFixed(3) : '   -  '
      console.log(`   ${String(i).padStart(2)}  ${f.local.toFixed(5)}  ${(2 * f.local - 1).toFixed(5)}   ${px[i].toFixed(3).padStart(8)}   ${String(g).padStart(7)}   ${String(f.L).padStart(3)}   ${T(f.L).toFixed(3)}`)
    })
    const subPixel = gaps.filter((g) => g < 1).length
    console.log(`   gaps < 1 px: ${subPixel} / ${gaps.length};  min gap ${Math.min(...gaps).toFixed(4)} px;  max gap ${Math.max(...gaps).toFixed(2)} px`)
    ;(report as unknown)[`userFolds_dpr${dpr}`] = { ribPx: R, folds: wf.map((f, i) => ({ ...f, px: px[i] })), gaps }
  }
  // seam jump size
  const R2 = ribPx({ ...USER, dpr: 2 })
  const jumpUser = (1 + T(Lraw(1e-12, cfg)) - T(Lraw(1 - 1e-12, cfg)))
  const dcfg = { ior: DEFAULTS.ior, curvature: DEFAULTS.curvature }
  const jumpDef = (1 + T(Lraw(1e-12, dcfg)) - T(Lraw(1 - 1e-12, dcfg)))
  console.log(`\n  seam jump: defaults ${jumpDef.toFixed(4)} rib = ${(jumpDef * 160).toFixed(1)} px @dpr2 ; user ${jumpUser.toFixed(4)} rib = ${(jumpUser * R2).toFixed(1)} px @dpr2, ${(jumpUser * 120).toFixed(1)} px @dpr1.5`)
  report.seamJump = { defaultsRibs: jumpDef, userRibs: jumpUser }
}

// ------------------------------------- 5. pre-image / footprint structure
/**
 * Exact footprint of one device pixel along the seam normal: walk the pixel,
 * count monotone branches of the composite map and measure the covered span.
 */
function footprint(s: Scene, mainPx: number, perpPx: number, samples = 20001) {
  const { gp } = waveAt(s, perpPx)
  const nx = 1 / Math.hypot(1, gp), ny = gp / Math.hypot(1, gp)
  const hw = (Math.abs(nx) + Math.abs(ny)) * 0.5
  const pos: number[] = []
  for (let i = 0; i < samples; i++) {
    const t = -hw + (2 * hw * i) / (samples - 1)
    pos.push(sampleAt(s, mainPx + t * nx, perpPx + t * ny)[0])
  }
  // branch = maximal monotone run; jump = |step| > 0.5 rib (seam discontinuity)
  const R = ribPx(s)
  let branches = 1, jumps = 0, folds = 0
  let dirPrev = 0
  const segMins: number[] = [], segMaxs: number[] = []
  let segLo = pos[0], segHi = pos[0]
  for (let i = 1; i < pos.length; i++) {
    const d = pos[i] - pos[i - 1]
    if (Math.abs(d) > 0.5 * R) {
      jumps++; branches++
      segMins.push(segLo); segMaxs.push(segHi)
      segLo = pos[i]; segHi = pos[i]; dirPrev = 0
      continue
    }
    const dir = Math.sign(d)
    if (dir !== 0 && dirPrev !== 0 && dir !== dirPrev) { folds++; branches++ }
    if (dir !== 0) dirPrev = dir
    segLo = Math.min(segLo, pos[i]); segHi = Math.max(segHi, pos[i])
  }
  segMins.push(segLo); segMaxs.push(segHi)
  const spans = segMins.map((lo, i) => segMaxs[i] - lo)
  return { hw, branches, jumps, folds, spans, totalSpan: spans.reduce((a, b) => a + b, 0), min: Math.min(...segMins), max: Math.max(...segMaxs) }
}
{
  console.log('\n=== footprint (source span of ONE device pixel) ===')
  const out: Record<string, unknown> = {}
  for (const [tag, s] of [['defaults dpr2', DEFAULTS], ['user dpr2', { ...USER, dpr: 2 }], ['user dpr1.5', USER]] as [string, Scene][]) {
    const R = ribPx(s)
    const perp = 137.0                        // arbitrary row, wave slope non-zero there
    let worst = { span: 0, at: 0, branches: 0, jumps: 0, folds: 0 }
    let nDisjoint = 0, nFolded = 0, sumSpan = 0
    const rows: unknown[] = []
    for (let i = 0; i < R; i++) {
      const mainPx = i + 0.5
      const f = footprint(s, mainPx, perp, 4001)
      sumSpan += f.totalSpan
      if (f.jumps) nDisjoint++
      if (f.folds) nFolded++
      if (f.totalSpan > worst.span) worst = { span: f.totalSpan, at: mainPx, branches: f.branches, jumps: f.jumps, folds: f.folds }
      rows.push({ mainPx, ...f })
    }
    out[tag] = { ribPx: R, meanSpan: sumSpan / R, worst, nDisjoint, nFolded }
    console.log(`  ${tag}: rib ${R} px | mean footprint ${(sumSpan / R).toFixed(2)} src px | worst ${worst.span.toFixed(1)} px @main ${worst.at} (${worst.branches} branches, ${worst.jumps} seam jumps, ${worst.folds} folds) | pixels with a seam jump ${nDisjoint}/${R} | pixels containing >=1 fold ${nFolded}/${R}`)
    const big = rows.filter((r) => r.branches > 1).slice(0, 6)
    for (const b of big) console.log(`      main ${b.mainPx}: ${b.branches} branches, spans [${b.spans.map((v: number) => v.toFixed(1)).join(', ')}]`)
  }
  report.footprints = out
}

// ------------------------------------- 6. Jacobian: rank-1 => 1-D sufficiency
{
  console.log('\n=== Jacobian singular values (is one 1-D axis enough?) ===')
  const s = USER
  const R = ribPx(s)
  const perp = 137.0
  const h = 1e-4
  const rows: unknown[] = []
  for (let i = 0; i < R; i++) {
    const m = i + 0.5
    const p0 = sampleAt(s, m + h, perp), p1 = sampleAt(s, m - h, perp)
    const q0 = sampleAt(s, m, perp + h), q1 = sampleAt(s, m, perp - h)
    const J = [[(p0[0] - p1[0]) / (2 * h), (q0[0] - q1[0]) / (2 * h)],
               [(p0[1] - p1[1]) / (2 * h), (q0[1] - q1[1]) / (2 * h)]]
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0]
    const fro2 = J[0][0] ** 2 + J[0][1] ** 2 + J[1][0] ** 2 + J[1][1] ** 2
    const disc = Math.sqrt(Math.max(fro2 * fro2 - 4 * det * det, 0))
    const s1 = Math.sqrt((fro2 + disc) / 2), s2 = Math.sqrt(Math.max((fro2 - disc) / 2, 0))
    rows.push({ mainPx: m, det, s1, s2, aniso: s1 / Math.max(s2, 1e-9), Lp: Lprime(glslMod(m + waveAt(s, perp).w, R) / R, s) })
  }
  const clean = rows.filter((r) => Math.abs(r.det) < 1e6)
  clean.sort((a, b) => b.s1 - a.s1)
  console.log('  worst 6 pixels by sigma1:')
  for (const r of clean.slice(0, 6)) console.log(`    main ${r.mainPx.toFixed(1)}: sigma1 ${r.s1.toFixed(2)}  sigma2 ${r.s2.toFixed(4)}  det ${r.det.toFixed(2)}  |L'| ${Math.abs(r.Lp).toFixed(2)}`)
  const s2vals = clean.map((r) => r.s2)
  console.log(`  sigma2 over the whole rib: min ${Math.min(...s2vals).toFixed(4)}  max ${Math.max(...s2vals).toFixed(4)}  (sigma2<=~1 => one bilinear tap already covers the short axis)`)
  report.jacobian = { worst: clean.slice(0, 8), s2min: Math.min(...s2vals), s2max: Math.max(...s2vals) }
}

// ------------------------------------- 7. tap-count convergence, 1-D
/** 1-D sources in 8-bit codes, sampled with linear (bilinear) reconstruction */
function makeSource(kind: 'step' | 'noise1px' | 'scene', n = 8192) {
  const a = new Float64Array(n)
  if (kind === 'step') for (let i = 0; i < n; i++) a[i] = i < n / 2 ? 0 : 255
  if (kind === 'noise1px') {
    const seed = 12345
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    for (let i = 0; i < n; i++) a[i] = 128 + 60 * (rnd() * 2 - 1)
  }
  if (kind === 'scene') {
    // blur 51 then 4.35x magnification => finest feature ~220 px; 30-code range
    for (let i = 0; i < n; i++) a[i] = 128 + 8 * Math.sin((2 * Math.PI * i) / 441) + 5 * Math.sin((2 * Math.PI * i) / 233 + 1.1) + 2 * Math.sin((2 * Math.PI * i) / 907 + 0.4)
  }
  return (u: number) => {
    const t = ((u % n) + n) % n
    const i0 = Math.floor(t), f = t - i0
    return a[i0] * (1 - f) + a[(i0 + 1) % n] * f
  }
}
{
  console.log('\n=== taps needed: uniform-in-screen vs uniform-in-pre-image ===')
  // Straight ribs so the study is exactly 1-D: gp = 0, hw = 0.5.
  const cfgs = [
    { tag: "|L'|~2   (ior1.5 curv0.85)", scene: { ...DEFAULTS, ior: 1.5, curvature: 0.85, bow: 0, amplitude: 0 } },
    { tag: "|L'|~4   (ior1.5 curv0.90)", scene: { ...DEFAULTS, ior: 1.5, curvature: 0.90, bow: 0, amplitude: 0 } },
    { tag: "|L'|~14  (user x=0.9)", scene: { ...USER, dpr: 2, bow: 0, amplitude: 0 } },
    { tag: "|L'|~176 (user x=0.99)", scene: { ...USER, dpr: 2, bow: 0, amplitude: 0 } },
  ]
  const targets = [2, 4, 13.78, 175.9]
  const sources = ['scene', 'noise1px', 'step'] as const
  const results: unknown[] = []
  for (let ci = 0; ci < cfgs.length; ci++) {
    const s = cfgs[ci].scene as Scene
    const R = ribPx(s)
    const cfg = { ior: s.ior, curvature: s.curvature }
    // find the pixel centre whose |L'| is closest to the target
    let best = { m: 0.5, err: Infinity, Lp: 0 }
    for (let i = 0; i < R; i++) {
      const local = (i + 0.5) / R
      const lp = Math.abs(Lprime(local, cfg))
      if (Math.abs(lp - targets[ci]) < best.err) best = { m: i + 0.5, err: Math.abs(lp - targets[ci]), Lp: lp }
    }
    const m = best.m
    const row: unknown = { tag: cfgs[ci].tag, absLp: best.Lp, mainPx: m, perSource: {} }
    for (const sk of sources) {
      const I = makeSource(sk)
      const g = (t: number) => I(sampleAt(s, m + t, 0)[0])
      const gt = (n: number) => { let acc = 0; for (let i = 0; i < n; i++) acc += g(-0.5 + (i + 0.5) / n); return acc / n }
      const gt4096 = gt(4096), gt8192 = gt(8192)
      const uniformScreen: Record<number, number> = {}
      for (const N of [1, 2, 4, 8, 16, 32, 64, 128]) uniformScreen[N] = Math.abs(gt(N) - gt8192)
      // uniform-in-pre-image, equal weights: N points spaced evenly between the
      // footprint endpoints in SOURCE px (the "correct box filter" of M1's
      // second option), realised by inverting the map numerically per tap.
      const u0 = sampleAt(s, m - 0.5, 0)[0], u1 = sampleAt(s, m + 0.5, 0)[0]
      const uniformPre: Record<number, number> = {}
      for (const N of [1, 2, 4, 8, 16, 32, 64, 128]) {
        let acc = 0
        for (let i = 0; i < N; i++) acc += I(u0 + ((u1 - u0) * (i + 0.5)) / N)
        uniformPre[N] = Math.abs(acc / N - gt8192)
      }
      row.perSource[sk] = { gtSelfCheck: Math.abs(gt4096 - gt8192), uniformScreen, uniformPre, oneTap: uniformScreen[1] }
    }
    results.push(row)
    console.log(`\n  ${row.tag}  |L'| = ${best.Lp.toFixed(2)} at main ${m}`)
    for (const sk of sources) {
      const r = row.perSource[sk]
      const fmt = (o: Record<number, number>) => [1, 2, 4, 8, 16, 32, 64].map((N) => `${N}:${o[N].toFixed(2)}`).join('  ')
      console.log(`    ${sk.padEnd(9)} GT self-check(4096 vs 8192) ${r.gtSelfCheck.toFixed(3)} codes`)
      console.log(`      screen-uniform  ${fmt(r.uniformScreen)}`)
      console.log(`      preimage-uniform${fmt(r.uniformPre)}`)
    }
  }
  report.tapConvergence = results
}

// --------------------- 8. is 1-D along the normal enough? 2-D GT vs 1-D
{
  console.log('\n=== 1-D-along-normal vs full 2-D box ground truth (user scene) ===')
  const s = USER
  const R = ribPx(s)
  const perp = 137.0
  // 2-D source: low-pass (scene-like) and 1-px noise (worst case)
  const mk2 = (kind: 'scene' | 'noise') => {
    if (kind === 'scene') return (u: number, v: number) =>
      128 + 8 * Math.sin((2 * Math.PI * u) / 441) + 5 * Math.sin((2 * Math.PI * v) / 233 + 1.1)
        + 3 * Math.sin((2 * Math.PI * (u + v)) / 617 + 0.4)
    const seed = 999
    const h = (a: number, b: number) => {
      let x = Math.imul(Math.floor(a) | 0, 374761393) ^ Math.imul(Math.floor(b) | 0, 668265263) ^ seed
      x = Math.imul(x ^ (x >>> 13), 1274126177)
      return ((x ^ (x >>> 16)) >>> 0) / 4294967295
    }
    return (u: number, v: number) => {
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j
      const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1)
      const t = a * (1 - fu) * (1 - fv) + b * fu * (1 - fv) + c * (1 - fu) * fv + d * fu * fv
      return 128 + 60 * (t * 2 - 1)
    }
  }
  const out: unknown = {}
  for (const kind of ['scene', 'noise'] as const) {
    const I = mk2(kind)
    const box2 = (m: number, n: number) => {
      let acc = 0
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const p = sampleAt(s, m + (i + 0.5) / n - 0.5, perp + (j + 0.5) / n - 0.5)
        acc += I(p[0], p[1])
      }
      return acc / (n * n)
    }
    const { gp } = waveAt(s, perp)
    const nx = 1 / Math.hypot(1, gp), ny = gp / Math.hypot(1, gp)
    const hw = (Math.abs(nx) + Math.abs(ny)) * 0.5
    const line1D = (m: number, N: number, trapezoid: boolean) => {
      let acc = 0, wsum = 0
      const plateau = Math.abs(Math.abs(nx) - Math.abs(ny))
      for (let i = 0; i < N; i++) {
        const t = -hw + (2 * hw * (i + 0.5)) / N
        // exact 1-D projected footprint of a unit square on n: trapezoid
        const w = trapezoid ? Math.min(1, Math.max(0, (hw - Math.abs(t)) / Math.max(hw - plateau / 2, 1e-9))) : 1
        const p = sampleAt(s, m + t * nx, perp + t * ny)
        acc += I(p[0], p[1]) * w; wsum += w
      }
      return acc / wsum
    }
    let selfChk = 0, d1 = 0, d1max = 0, oneTap = 0, oneTapMax = 0, dTrap = 0
    for (let i = 0; i < R; i++) {
      const m = i + 0.5
      const gt = box2(m, 96), gt64 = box2(m, 64)
      selfChk = Math.max(selfChk, Math.abs(gt - gt64))
      const e1 = Math.abs(line1D(m, 512, false) - gt)
      const et = Math.abs(line1D(m, 512, true) - gt)
      const e0 = Math.abs(I(...sampleAt(s, m, perp)) - gt)
      d1 += e1 / R; dTrap += et / R; oneTap += e0 / R
      d1max = Math.max(d1max, e1); oneTapMax = Math.max(oneTapMax, e0)
    }
    out[kind] = { gtSelfCheck: selfChk, converged1D_mean: d1, converged1D_max: d1max, trapezoid1D_mean: dTrap, oneTap_mean: oneTap, oneTap_max: oneTapMax }
    console.log(`  ${kind}: 2-D GT self-check (64 vs 96 grid) max ${selfChk.toFixed(3)} codes`)
    console.log(`     512-tap 1-D along n, box weights:       mean ${d1.toFixed(3)}  max ${d1max.toFixed(3)} codes vs 2-D GT`)
    console.log(`     512-tap 1-D along n, trapezoid weights: mean ${dTrap.toFixed(3)} codes`)
    console.log(`     shipped 1 tap:                          mean ${oneTap.toFixed(3)}  max ${oneTapMax.toFixed(3)} codes`)
  }
  report.oneDSufficiency = out
}

// --------------------- 9. no-op proof at defaults: gate value across the rib
{
  const cfg = { ior: DEFAULTS.ior, curvature: DEFAULTS.curvature }
  let worst = 0
  for (const dpr of [1, 1.5, 2, 3]) {
    const R = 80 * dpr
    for (let i = 0; i < R * 4; i++) {           // 4x oversample the pixel grid
      const local = (i + 0.5) / (R * 4)
      worst = Math.max(worst, Math.abs(Lprime(local, cfg)))
    }
  }
  const supExact = supAbsLprime(cfg)
  console.log(`\n=== no-op at defaults ===`)
  console.log(`  sup|L'| over the OPEN rib = ${supExact.toFixed(6)} < 1  =>  gate |L'|>1 is false everywhere, at every dpr (sampled worst ${worst.toFixed(6)})`)
  report.defaultsNoOp = { supAbsLprime: supExact, sampledWorst: worst }
}

mkdirSync('reports/blur-bakeoff/phase14', { recursive: true })
writeFileSync('reports/blur-bakeoff/phase14/derivation.json', JSON.stringify(report, null, 2))
console.log('\nwrote reports/blur-bakeoff/phase14/derivation.json')
