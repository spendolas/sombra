/**
 * Phase 10a — Reeded Glass rib-edge antialiasing: analytic characterisation.
 *
 * No GPU. Derives d(sampleUV)/d(screenPx) through the whole emitted chain and
 * checks the closed form against a literal, line-by-line CPU re-execution of
 * the shader source (the control), plus a deliberately-wrong variant (the
 * known-bad) so every number reported here is gated on a metric that is proven
 * to distinguish right from wrong.
 *
 * Output: reports/blur-bakeoff/phase10/analytic.json + a console table.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OUT = resolve(import.meta.dirname, '../../reports/blur-bakeoff/phase10/analytic.json')

// ---------------------------------------------------------------------------
// A. Literal CPU re-execution of the emitted shader (the ground truth)
// ---------------------------------------------------------------------------

/** GLSL mod(): floor-based, matches WGSL sombra_mod(). */
const glslMod = (x: number, y: number) => x - y * Math.floor(x / y)
const fract = (x: number) => x - Math.floor(x)
const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b)

/** Literal transcription of REED_LENS_BODY (src/nodes/transform/reeded-glass.ts:78-105). */
function reedLens(coord: number, ribW: number, ior: number, curvature: number): [number, number] {
  const local = glslMod(coord, ribW) / ribW
  const x = (local - 0.5) * 2.0
  const c = clamp(curvature, 0.01, 1.0)
  const amp = curvature > 1.0 ? curvature : 1.0
  const c2 = Math.min(c, 0.99)
  const x2 = x * x * c2 * c2
  const slope = (x * c2) / Math.sqrt(Math.max(1.0 - x2, 0.001))
  const disp = -slope * (ior - 1.0) * 0.5 * amp
  let lensed = local + disp
  lensed = 1.0 - Math.abs(fract(lensed * 0.5) * 2.0 - 1.0)
  const sag = (Math.sqrt(Math.max(1.0 - x2, 0.0)) - Math.sqrt(Math.max(1.0 - c2 * c2, 0.0))) / c2
  return [(Math.floor(coord / ribW) + lensed) * ribW, sag * (ior - 1.0) * amp]
}

interface Cfg {
  ribWidth: number   // CSS px
  ior: number
  curvature: number
  bow: number
  scale: number      // srt_scale
  dpr: number        // effective u_dpr = min(devicePixelRatio,2) * dprScale
  resMain: number    // device px
  resPerp: number    // device px
}

const DEF: Cfg = { ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 1, scale: 1, dpr: 2, resMain: 1600, resPerp: 900 }

/**
 * Literal re-execution of the straight-rib / rotate-0 / vertical path:
 *   srtScr.x      = (v_uv.x - anchor.x) / scale
 *   ribUVScreen   = ribWidth * dpr / resMain
 *   lens          = reedLens(srtScr.x, ribUVScreen, ior, curvature)
 *   disp          = lens.x - srtScr.x
 *   bowScr        = lens.y * (ribWidth*dpr*0.5) * bow / resPerp
 *   d             = vec2(disp, bowScr) * scale      (gm=gp=0 -> den=1, R(0)=I)
 *   sampleUV      = fragCoord/viewport + d
 * Returns sampleUV in DEVICE PX (multiplied back by resMain / resPerp).
 */
function sampleUVpx(pMain: number, pPerp: number, cfg: Cfg): [number, number] {
  const uMain = pMain / cfg.resMain          // v_uv.x
  const anchor = 0.5
  const srtMain = (uMain - anchor) / cfg.scale
  const W = (cfg.ribWidth * cfg.dpr) / cfg.resMain
  const lens = reedLens(srtMain, W, cfg.ior, cfg.curvature)
  const disp = lens[0] - srtMain
  const bowScr = (lens[1] * (cfg.ribWidth * cfg.dpr * 0.5) * cfg.bow) / cfg.resPerp
  const dMain = disp * cfg.scale
  const dPerp = bowScr * cfg.scale
  return [(uMain + dMain) * cfg.resMain, (pPerp / cfg.resPerp + dPerp) * cfg.resPerp]
}

// ---------------------------------------------------------------------------
// B. The closed forms
// ---------------------------------------------------------------------------

function kOf(curvature: number) { return Math.min(clamp(curvature, 0.01, 1.0), 0.99) }
function ampOf(curvature: number) { return curvature > 1.0 ? curvature : 1.0 }
/** A = (ior-1) * amp * k  — the single number the whole lens depends on, with k. */
function Aof(ior: number, curvature: number) { return (ior - 1) * ampOf(curvature) * kOf(curvature) }
/** D = half the unfolded seam jump, in rib-widths. */
function Dof(ior: number, curvature: number) {
  const k = kOf(curvature)
  return ((ior - 1) * 0.5 * ampOf(curvature) * k) / Math.sqrt(1 - k * k)
}
/** Unit triangle wave, period 2, F(y)=y on [0,1]. Same fold the shader applies. */
function F(y: number) { return 1 - Math.abs(fract(y * 0.5) * 2 - 1) }

/** dL/dlocal BEFORE the mirror fold. Fold only flips the sign. */
function LprimeUnfolded(local: number, ior: number, curvature: number) {
  const x = (local - 0.5) * 2
  const k = kOf(curvature)
  const A = Aof(ior, curvature)
  return 1 - A / Math.pow(1 - k * k * x * x, 1.5)
}
/** Sign the fold applies at `local` (+1 identity region, -1 reflected region). */
function foldSign(local: number, ior: number, curvature: number) {
  const x = (local - 0.5) * 2
  const k = kOf(curvature)
  const c2 = k
  const x2 = x * x * c2 * c2
  const slope = (x * c2) / Math.sqrt(Math.max(1 - x2, 0.001))
  const g = local - slope * (ior - 1) * 0.5 * ampOf(curvature)
  // triangle wave slope: +1 on [2n, 2n+1], -1 on [2n+1, 2n+2]
  return glslMod(g, 2) < 1 ? 1 : -1
}
/** d(sampleUV_main)/d(screen_main), dimensionless px/px. */
function Lprime(local: number, ior: number, curvature: number) {
  return foldSign(local, ior, curvature) * LprimeUnfolded(local, ior, curvature)
}
/** Off-diagonal shear from bow: d(sampleUV_perp)/d(screen_main), px/px. */
function Bshear(local: number, ior: number, curvature: number, bow: number) {
  const x = (local - 0.5) * 2
  const k = kOf(curvature)
  return -(ior - 1) * ampOf(curvature) * bow * ((x * k) / Math.sqrt(1 - k * k * x * x))
}
/** Singular values of J = [[L',0],[B,1]] (straight ribs, rotate 0). */
function singulars(Lp: number, B: number): [number, number] {
  const tr = Lp * Lp + B * B + 1
  const det2 = Lp * Lp                       // (det J)^2
  const disc = Math.sqrt(Math.max(tr * tr - 4 * det2, 0))
  return [Math.sqrt((tr + disc) / 2), Math.sqrt((tr - disc) / 2)]
}

// ---------------------------------------------------------------------------
// C. GATE CALIBRATION — closed form vs literal shader, known-good + known-bad
// ---------------------------------------------------------------------------

/** Central-difference d(sampleUV_main)/d(pMain) from the literal transcription. */
function numericJ(pMain: number, cfg: Cfg): { dmain: number; dperp: number } {
  const h = 1e-4
  const a = sampleUVpx(pMain - h, 100, cfg)
  const b = sampleUVpx(pMain + h, 100, cfg)
  return { dmain: (b[0] - a[0]) / (2 * h), dperp: (b[1] - a[1]) / (2 * h) }
}

function calibrate() {
  const cfgs: Cfg[] = [
    DEF,
    { ...DEF, ior: 1.0 }, { ...DEF, ior: 2.0 }, { ...DEF, ior: 3.0 },
    { ...DEF, curvature: 0.0 }, { ...DEF, curvature: 0.5 }, { ...DEF, curvature: 1.0 }, { ...DEF, curvature: 2.0 },
    { ...DEF, ribWidth: 20 }, { ...DEF, ribWidth: 200 }, { ...DEF, ribWidth: 2 },
    { ...DEF, scale: 0.5 }, { ...DEF, scale: 2 },
    { ...DEF, dpr: 1 }, { ...DEF, dpr: 1.5 },
    { ...DEF, bow: 0 }, { ...DEF, bow: -1 },
  ]
  let worstGood = 0, worstGoodWhere = ''
  let worstBad = 0
  for (const cfg of cfgs) {
    const periodPx = cfg.ribWidth * cfg.dpr * cfg.scale
    // sample the rib interior, avoiding the exact seam (a true discontinuity)
    for (let i = 1; i < 200; i++) {
      const local = i / 200
      const pMain = cfg.resMain * 0.5 + local * periodPx   // 0.5 = anchor, so local runs 0..1 in rib 0
      const n = numericJ(pMain, cfg)
      const aMain = Lprime(local, cfg.ior, cfg.curvature)
      const aPerp = Bshear(local, cfg.ior, cfg.curvature, cfg.bow)
      const eM = Math.abs(n.dmain - aMain)
      const eP = Math.abs(n.dperp - aPerp)
      const e = Math.max(eM, eP)
      if (e > worstGood) { worstGood = e; worstGoodWhere = `${JSON.stringify(cfg)} local=${local.toFixed(3)} num=(${n.dmain.toFixed(6)},${n.dperp.toFixed(6)}) ana=(${aMain.toFixed(6)},${aPerp.toFixed(6)})` }
      // known-bad: the "obvious" closed form that forgets dx/dlocal = 2
      const bad = 1 - Aof(cfg.ior, cfg.curvature) / (2 * Math.pow(1 - kOf(cfg.curvature) ** 2 * ((local - 0.5) * 2) ** 2, 1.5))
      worstBad = Math.max(worstBad, Math.abs(n.dmain - bad))
    }
  }
  return { worstGood, worstGoodWhere, worstBad }
}

/** Seam jump from the literal transcription, in device px, vs closed form 2*F(D)*period.
 *  eps must be small enough that eps*max|L'| stays under the tolerance — |L'| reaches
 *  1.4e3 in this matrix, so the tolerance is scaled by it rather than left fixed. */
function seamJumpPx(cfg: Cfg) {
  const periodPx = cfg.ribWidth * cfg.dpr * cfg.scale
  const seam = cfg.resMain * 0.5 + periodPx      // the first seam right of the anchor
  const eps = 1e-7
  const left = sampleUVpx(seam - eps, 100, cfg)
  const right = sampleUVpx(seam + eps, 100, cfg)
  const measured = right[0] - left[0]
  const closed = 2 * F(Dof(cfg.ior, cfg.curvature)) * periodPx
  // finite-difference bias: the two probes are eps away from the seam, where the
  // slope is max|L'|, so they are already displaced by ~eps*max|L'| device px each.
  const maxL = Math.abs(1 - Aof(cfg.ior, cfg.curvature) / Math.pow(1 - kOf(cfg.curvature) ** 2, 1.5))
  const tol = 1e-3 + 4 * maxL * eps * periodPx
  return { measured, closed, periodPx, tol }
}

// ---------------------------------------------------------------------------
// C2. Does the closed form survive the wave-rib gradient inverse?
//     Literal re-execution of the sine-wave screen path incl. emitScreenDelta.
// ---------------------------------------------------------------------------

/**
 * Literal re-execution of the tilted-rib screen path, using a LINEAR rib field
 * w = tilt * perp. A linear field has d(gp)/d(perp) == 0 exactly, which isolates
 * the claim under test (does emitScreenDelta's gradient inverse preserve the
 * rib-normal derivative?) from the second-order term a curved field adds.
 * This is a real configuration: it is what srt_rotate produces.
 */
function sampleUVpxTilt(pMain: number, pPerp: number, cfg: Cfg, tilt: number): [number, number] {
  const { resMain, resPerp, dpr, scale } = cfg
  const uMain = pMain / resMain, uPerp = pPerp / resPerp
  const sMain = (uMain - 0.5) / scale, sPerp = (uPerp - 0.5) / scale
  // w in main-axis screen UV; tilt is px/px, so convert through resPerp/resMain
  const w = (q: number) => (tilt * q * resPerp) / resMain
  const warped = sMain + w(sPerp)
  const W = (cfg.ribWidth * dpr) / resMain
  const lens = reedLens(warped, W, cfg.ior, cfg.curvature)
  const disp = lens[0] - warped
  const bowScr = (lens[1] * (cfg.ribWidth * dpr * 0.5) * cfg.bow) / resPerp
  const gm = 0
  const ep = 1 / resPerp
  const gp = (w(sPerp + ep) - w(sPerp - ep)) * 0.5 * resMain      // == tilt
  const den = (1 + gm) * (1 + gm) + gp * gp
  const dMain = (disp * (1 + gm)) / den
  const dPerp = (disp * gp * (resMain / resPerp)) / den + bowScr
  return [(uMain + dMain * scale) * resMain, (uPerp + dPerp * scale) * resPerp]
}

/**
 * The claim under test: with bow = 0, the Jacobian of sampleUV has eigenvalues
 * {1, L'} — 1 ALONG the rib, L' ACROSS it — so L' is the rib-normal derivative,
 * NOT the main-axis one. The main-axis directional derivative is the weaker
 * 1 + (L'-1)/(1+gp^2), which is why a naive main-axis probe disagrees.
 */
function waveCheck() {
  const cfg = { ...DEF, bow: 0 }
  let worstNormal = 0, worstAxis = 0, where = ''
  const h = 1e-4
  for (const tilt of [0.1, 0.4, 0.6283, 1.0, 2.0]) {
    for (let j = 0; j < 5; j++) {
      const pPerp = 100 + j * 97.3
      const W = (cfg.ribWidth * cfg.dpr) / cfg.resMain
      const sPerp = pPerp / cfg.resPerp - 0.5
      const wv = (tilt * sPerp * cfg.resPerp) / cfg.resMain
      for (let i = 1; i < 120; i++) {
        const local0 = i / 120
        const sMain = 3 * W + local0 * W - wv
        const pMain = (sMain * cfg.scale + 0.5) * cfg.resMain
        const Lp = Lprime(local0, cfg.ior, cfg.curvature)
        // directional derivative along the rib normal n = (1, tilt)/|.|
        const nlen = Math.sqrt(1 + tilt * tilt)
        const nx = 1 / nlen, ny = tilt / nlen
        const a = sampleUVpxTilt(pMain - h * nx, pPerp - h * ny, cfg, tilt)
        const b = sampleUVpxTilt(pMain + h * nx, pPerp + h * ny, cfg, tilt)
        const dn = [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)]
        // expected: L' * n
        const eN = Math.max(Math.abs(dn[0] - Lp * nx), Math.abs(dn[1] - Lp * ny))
        if (eN > worstNormal) { worstNormal = eN; where = `tilt=${tilt} local=${local0.toFixed(3)} dn=(${dn[0].toFixed(5)},${dn[1].toFixed(5)}) expect=(${(Lp * nx).toFixed(5)},${(Lp * ny).toFixed(5)})` }
        // and along the MAIN axis it is NOT L' -- record how far off, as the known-bad
        const a2 = sampleUVpxTilt(pMain - h, pPerp, cfg, tilt)
        const b2 = sampleUVpxTilt(pMain + h, pPerp, cfg, tilt)
        worstAxis = Math.max(worstAxis, Math.abs((b2[0] - a2[0]) / (2 * h) - Lp))
      }
    }
  }
  return {
    worstRibNormalError: worstNormal,
    where,
    worstMainAxisDeviation: worstAxis,
    pass: worstNormal < 1e-3 && worstAxis > 1e-2,
  }
}

// ---------------------------------------------------------------------------
// D. Tables
// ---------------------------------------------------------------------------

function derivativeTable(ior: number, curvature: number, bow: number) {
  const rows: Array<{ local: number; Lp: number; B: number; sMax: number; sMin: number }> = []
  for (const local of [0.0001, 0.02, 0.05, 0.0774, 0.10, 0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 0.9226, 0.95, 0.98, 0.9999]) {
    const Lp = Lprime(local, ior, curvature)
    const B = Bshear(local, ior, curvature, bow)
    const [sMax, sMin] = singulars(Lp, B)
    rows.push({ local, Lp, B, sMax, sMin })
  }
  return rows
}

/**
 * sigmaMax >= 1 ALWAYS for this Jacobian (row 2 is (B, 1), norm >= 1), so a
 * ">1" test fires on the identity map and is worthless — it did, on the ior=1.0
 * control, in the first run of this script. The threshold below carries a
 * margin, and metricSelfTest() proves identity scores exactly 1.0 and a real
 * 2x downscale scores exactly 2.0.
 */
const MINIFY_THRESHOLD = 1.05

function metricSelfTest() {
  // known-good: ior = 1 is the identity map at every curvature and bow
  let identityWorst = 0
  for (const c of [0, 0.2, 0.5, 0.8, 1.0, 2.0]) {
    for (const bow of [0, 1, -1]) {
      for (let i = 1; i < 500; i++) {
        const l = i / 500
        const s = singulars(Lprime(l, 1.0, c), Bshear(l, 1.0, c, bow))[0]
        identityWorst = Math.max(identityWorst, Math.abs(s - 1))
      }
    }
  }
  // known-bad: a literal uniform 2x minification, J = 2I
  const twoX = singulars(2, 0)[0]
  // known-bad 2: pure shear of 3 -- sigmaMax must exceed 3
  const shear3 = singulars(1, 3)[0]
  return {
    identityMaxDeviationFrom1: identityWorst,
    twoXDownscaleSigma: twoX,
    shear3Sigma: shear3,
    pass: identityWorst < 1e-9 && Math.abs(twoX - 2) < 1e-9 && shear3 > 3,
  }
}

/** Roots of L'(local) = 0 (the caustics) and bands where sigmaMax > threshold. */
function roots(ior: number, curvature: number, bow: number) {
  const N = 200001
  const caustics: number[] = []
  const minifyBands: Array<[number, number]> = []
  let prevL = Lprime(1e-9, ior, curvature)
  let inBand = singulars(prevL, Bshear(1e-9, ior, curvature, bow))[0] > MINIFY_THRESHOLD
  let bandStart = inBand ? 0 : -1
  for (let i = 1; i < N; i++) {
    const local = i / (N - 1)
    const L = Lprime(local, ior, curvature)
    if (prevL === 0 || (prevL < 0) !== (L < 0)) caustics.push(local - 0.5 / (N - 1))
    const s = singulars(L, Bshear(local, ior, curvature, bow))[0]
    const nowIn = s > MINIFY_THRESHOLD
    if (nowIn && !inBand) bandStart = local
    if (!nowIn && inBand) { minifyBands.push([bandStart, local]); bandStart = -1 }
    inBand = nowIn
    prevL = L
  }
  if (inBand) minifyBands.push([bandStart, 1])
  const grid: number[] = []
  for (let i = 0; i <= 20000; i++) grid.push(i / 20000)
  const absL = grid.map(l => Math.abs(Lprime(l, ior, curvature)))
  const sM = grid.map(l => singulars(Lprime(l, ior, curvature), Bshear(l, ior, curvature, bow))[0])
  // 1-D band (main axis only, bow ignored) where |L'| > 1 -- classical minification
  let oneDfrac = 0
  for (let i = 0; i < 20000; i++) if (Math.abs(Lprime((i + 0.5) / 20000, ior, curvature)) > 1) oneDfrac += 1 / 20000
  return {
    caustics,
    maxAbsLprime: Math.max(...absL),
    maxSigma: Math.max(...sM),
    sigmaAtSeam: singulars(Lprime(1e-9, ior, curvature), Bshear(1e-9, ior, curvature, bow))[0],
    minifyBands,
    minifyFraction: minifyBands.reduce((a, [s, e]) => a + (e - s), 0),
    oneDMinifyFraction: oneDfrac,
  }
}

/** Solve for the parameter value at which max|L'| first reaches 1 (the 1-D cliff). */
function cliff(vary: 'ior' | 'curvature', fixed: number) {
  const f = (v: number) => {
    const ior = vary === 'ior' ? v : fixed
    const c = vary === 'curvature' ? v : fixed
    const k = kOf(c)
    return Aof(ior, c) / Math.pow(1 - k * k, 1.5) - 2   // |L'| at the seam == 1  <=>  A/(1-k^2)^1.5 == 2
  }
  let lo = vary === 'ior' ? 1.0 : 0.0
  let hi = vary === 'ior' ? 3.0 : 2.0
  if (f(lo) > 0) return lo
  if (f(hi) < 0) return NaN
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) < 0) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

// ---------------------------------------------------------------------------
// E. Run
// ---------------------------------------------------------------------------

const self = metricSelfTest()
console.log('=== METRIC SELF-TEST (sigmaMax) ===')
console.log(`  known-good identity (ior=1.0, all curvature/bow): max |sigmaMax - 1| = ${self.identityMaxDeviationFrom1.toExponential(3)}  (must be 0)`)
console.log(`  known-bad  uniform 2x downscale:  sigmaMax = ${self.twoXDownscaleSigma}  (must be 2)`)
console.log(`  known-bad  pure shear 3:          sigmaMax = ${self.shear3Sigma.toFixed(4)}  (must be > 3)`)
console.log(`  SELF-TEST: ${self.pass ? 'PASS' : 'FAIL'}`)
console.log(`  => sigmaMax >= 1 by construction; "minifying" threshold set to ${MINIFY_THRESHOLD}\n`)

const cal = calibrate()
console.log('=== GATE CALIBRATION: closed form vs literal shader transcription ===')
console.log(`  known-good  max |numeric - closed form| = ${cal.worstGood.toExponential(3)}  (must be < 1e-4)`)
console.log(`  known-bad   max |numeric - wrong form|  = ${cal.worstBad.toExponential(3)}  (must be > 1e-2)`)
const gatePass = cal.worstGood < 1e-4 && cal.worstBad > 1e-2
console.log(`  GATE: ${gatePass ? 'PASS' : 'FAIL'}`)
if (!gatePass) console.log('  worst good case:', cal.worstGoodWhere)

const matrix: Array<{ ior: number; curvature: number; bow: number }> = []
for (const ior of [1.0, 1.25, 1.5, 1.54, 2.0, 3.0]) {
  for (const curvature of [0.0, 0.2, 0.5, 0.8, 1.0, 2.0]) {
    for (const bow of [0, 1]) matrix.push({ ior, curvature, bow })
  }
}

const summary = matrix.map(m => {
  const r = roots(m.ior, m.curvature, m.bow)
  const D = Dof(m.ior, m.curvature)
  return {
    ...m,
    A: Aof(m.ior, m.curvature),
    k: kOf(m.curvature),
    D,
    foldActive: D > 1,
    jumpRibs: 2 * F(D),
    caustics: r.caustics.map(c => +c.toFixed(5)),
    maxAbsLprime: +r.maxAbsLprime.toFixed(4),
    minifying1D: r.maxAbsLprime > 1,
    oneDMinifyFraction: +r.oneDMinifyFraction.toFixed(4),
    maxSigma: +r.maxSigma.toFixed(4),
    sigmaAtSeam: +r.sigmaAtSeam.toFixed(4),
    minifying2D: r.maxSigma > MINIFY_THRESHOLD,
    minifyFraction: +r.minifyFraction.toFixed(4),
  }
})

const wc = waveCheck()
console.log('\n=== TILTED-RIB CHECK: L\' is the RIB-NORMAL derivative, not the main-axis one ===')
console.log(`  known-good  max |d(sampleUV)/dn - L'*n| = ${wc.worstRibNormalError.toExponential(3)}  (must be < 1e-3)`)
console.log(`  known-bad   max |main-axis derivative - L'| = ${wc.worstMainAxisDeviation.toExponential(3)}  (must be > 1e-2)`)
console.log(`  GATE: ${wc.pass ? 'PASS' : 'FAIL'}${wc.pass ? '' : '  worst: ' + wc.where}`)

console.log('\n=== SEAM JUMP: measured (literal shader) vs closed form 2*F(D)*period ===')
const jumpRows = [
  { ...DEF }, { ...DEF, ior: 1.0 }, { ...DEF, ior: 2.0 }, { ...DEF, ior: 3.0 },
  { ...DEF, curvature: 0.2 }, { ...DEF, curvature: 1.0 }, { ...DEF, curvature: 2.0 },
  { ...DEF, ribWidth: 20 }, { ...DEF, ribWidth: 200 },
  { ...DEF, dpr: 1 }, { ...DEF, dpr: 1.5 },
  { ...DEF, scale: 0.5 }, { ...DEF, scale: 2 },
  { ...DEF, ior: 3.0, curvature: 2.0 },
].map(cfg => {
  const j = seamJumpPx(cfg)
  return {
    ribWidth: cfg.ribWidth, ior: cfg.ior, curvature: cfg.curvature, dpr: cfg.dpr, scale: cfg.scale,
    periodPx: +j.periodPx.toFixed(2),
    measuredPx: +j.measured.toFixed(3),
    closedPx: +j.closed.toFixed(3),
    err: +Math.abs(j.measured - j.closed).toFixed(6),
    tol: +j.tol.toFixed(6),
    jumpInRibs: +(j.closed / j.periodPx).toFixed(4),
  }
})
for (const r of jumpRows) {
  console.log(`  rw=${String(r.ribWidth).padStart(3)} ior=${r.ior.toFixed(2)} c=${r.curvature.toFixed(2)} dpr=${r.dpr} s=${r.scale}  period=${String(r.periodPx).padStart(6)}px  jump=${String(r.measuredPx).padStart(8)}px (closed ${r.closedPx}, err ${r.err} tol ${r.tol})  = ${r.jumpInRibs} ribs`)
}
const jumpGate = jumpRows.every(r => r.err < r.tol)
console.log(`  GATE (closed form matches literal shader): ${jumpGate ? 'PASS' : 'FAIL'}`)

console.log('\n=== 1-D MINIFICATION CLIFF (max|L\'| == 1 at the seam) ===')
for (const c of [0.5, 0.8, 1.0]) console.log(`  at curvature ${c.toFixed(2)}: cliff at ior = ${cliff('ior', c).toFixed(4)}`)
for (const i of [1.25, 1.5, 2.0]) console.log(`  at ior ${i.toFixed(2)}: cliff at curvature = ${cliff('curvature', i).toFixed(4)}`)
console.log(`  defaults are ior 1.50 / curvature 0.80 -> ${((1 - 1.5 / cliff('ior', 0.8)) * 100).toFixed(1)}% below the ior cliff, ${((1 - 0.8 / cliff('curvature', 1.5)) * 100).toFixed(1)}% below the curvature cliff`)

console.log('\n=== |L\'| IN THE OUTERMOST DEVICE PIXELS OF A RIB (rib period 160 device px) ===')
console.log('  px from seam | c=0.50   c=0.80   c=0.90   c=1.00   c=2.00   (ior 1.5)')
for (const px of [0.5, 1, 2, 4, 8, 16]) {
  const l = px / 160
  const cells = [0.5, 0.8, 0.9, 1.0, 2.0].map(c => Math.abs(Lprime(l, 1.5, c)).toFixed(2).padStart(7)).join('  ')
  console.log(`  ${px.toString().padStart(12)} | ${cells}`)
}

console.log('\n=== SEAM GEOMETRY: staircase step run (device px of seam per 1 px transverse step) ===')
const geo: Array<Record<string, string | number>> = []
function tiltRow(label: string, tilt: number) {
  const runPx = tilt === 0 ? Infinity : Math.abs(1 / tilt)
  geo.push({ config: label, seamTilt_pxPerPx: +tilt.toFixed(4), angleDeg: +(Math.atan(tilt) * 180 / Math.PI).toFixed(2), stepRunDevicePx: Number.isFinite(runPx) ? +runPx.toFixed(2) : 'inf (axis-aligned)' })
  console.log(`  ${label.padEnd(46)} tilt=${tilt.toFixed(4)} px/px (${(Math.atan(tilt) * 180 / Math.PI).toFixed(1)} deg)  step run = ${Number.isFinite(runPx) ? runPx.toFixed(2) + ' px' : 'INFINITE (axis-aligned, no staircase)'}`)
}
tiltRow('straight, srt_rotate 0', 0)
for (const deg of [0.5, 1, 2, 5, 15, 45]) tiltRow(`straight, srt_rotate ${deg} deg`, Math.tan(deg * Math.PI / 180))
// wave ribs: seam tilt = -dw/dperp; peak |dw/dperp| per shape at amp/wl (px)
const amp = 20, wl = 200
const shapes: Array<[string, number]> = [
  ['wave/sine     (amp 20, wl 200)', 2 * Math.PI * amp / wl],
  ['wave/triangle (amp 20, wl 200)', 4 * amp / wl],
  ['wave/u_shape  (amp 20, wl 200)', 8 * amp / wl],
  ['wave/chevron  (amp 20, wl 200) at 500px out', 2 * Math.PI * amp / wl * (500 / wl)],
  ['circular      (amp 20, wl 200)', 2 * Math.PI * amp / wl],
  ['noise/simplex (amp 20, wl 200)', 2.0 * amp / wl],
]
for (const [label, t] of shapes) tiltRow(`${label} peak`, t)
tiltRow('wave/sine at the crest (dw/dperp = 0)', 0)
console.log('  (wave seams sweep tilt from 0 to peak twice per wavelength -> step run sweeps')
console.log('   from 1/peak px up to INFINITE at every crest and trough: a variable-length staircase)')

console.log('\n=== d(sampleUV)/d(screen px) ACROSS THE RIB — defaults (ior 1.5, c 0.8, bow 1) ===')
console.log('  local     L\' (main)   B (perp shear)  sigmaMax  sigmaMin')
for (const r of derivativeTable(1.5, 0.8, 1)) {
  console.log(`  ${r.local.toFixed(4)}  ${r.Lp.toFixed(5).padStart(9)}  ${r.B.toFixed(5).padStart(14)}  ${r.sMax.toFixed(4).padStart(8)}  ${r.sMin.toFixed(4).padStart(8)}`)
}

console.log('\n=== PIXEL FOOTPRINT ===')
const foot: Array<Record<string, number | string>> = []
for (const rw of [20, 80, 200]) {
  for (const dpr of [1, 2]) {
    for (const [label, scl] of [['static', 1], ['animated 0.75', 0.75]] as const) {
      const eff = Math.min(dpr, 2) * scl
      const period = rw * eff
      foot.push({
        ribWidth: rw, devicePixelRatio: dpr, dprScale: scl, u_dpr: eff,
        ribPeriodDevicePx: +period.toFixed(2),
        ribPeriodCssPx: rw,
        seamsPer100DevicePx: +(100 / period).toFixed(3),
        seamsPer100CssPx: +(100 / rw).toFixed(3),
        sampleSpacingCssPx: +(1 / eff).toFixed(4),
        state: label,
      })
      console.log(`  rw=${String(rw).padStart(3)} dPR=${dpr} ${label.padEnd(13)} u_dpr=${eff.toFixed(2)}  rib=${period.toFixed(1)} device px (${rw} CSS px)  seams/100 device px=${(100 / period).toFixed(3)}  sample spacing=${(1 / eff).toFixed(3)} CSS px`)
    }
  }
}

for (const bowSel of [0, 1]) {
  console.log(`\n=== MINIFICATION ACROSS THE MATRIX (bow=${bowSel}) ===`)
  console.log('  ior   curv   A        D       fold  jump/rib  max|L\'|     1D-min%  sigmaSeam    2D-min%')
  for (const s of summary.filter(s => s.bow === bowSel)) {
    console.log(`  ${s.ior.toFixed(2)}  ${s.curvature.toFixed(2)}  ${s.A.toFixed(3).padStart(6)} ${s.D.toFixed(4).padStart(8)}  ${s.foldActive ? 'Y' : 'n'}     ${s.jumpRibs.toFixed(4)}  ${s.maxAbsLprime.toFixed(3).padStart(10)}  ${(s.oneDMinifyFraction * 100).toFixed(2).padStart(7)}  ${s.sigmaAtSeam.toFixed(3).padStart(10)}  ${(s.minifyFraction * 100).toFixed(2).padStart(7)}`)
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  metricSelfTest: self,
  waveRibCheck: wc,
  minifyThreshold: MINIFY_THRESHOLD,
  cliffs: {
    iorAtCurvature: Object.fromEntries([0.5, 0.8, 1.0].map(c => [c, cliff('ior', c)])),
    curvatureAtIor: Object.fromEntries([1.25, 1.5, 2.0].map(i => [i, cliff('curvature', i)])),
  },
  seamGeometry: geo,
  calibration: { ...cal, pass: gatePass },
  seamJump: { rows: jumpRows, pass: jumpGate },
  derivativeAtDefaults: derivativeTable(1.5, 0.8, 1),
  derivativeAtDefaultsNoBow: derivativeTable(1.5, 0.8, 0),
  pixelFootprint: foot,
  matrix: summary,
}, null, 2))
console.log(`\nwrote ${OUT}`)
