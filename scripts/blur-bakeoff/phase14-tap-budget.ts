/**
 * Phase 14b — how many taps, and which sampling strategy.
 *
 * Same doubles-exact copy of the shipped map as phase14-filter-derivation.ts.
 * Every estimator is measured against an 8192-tap uniform-in-screen box, whose
 * own convergence is checked against 16384 taps and reported. Calibration:
 * a KNOWN-GOOD control (the exact box, N=8192) must score 0, and a KNOWN-BAD
 * control (1 tap) must score large, on every source model — printed first.
 *
 * No GPU. Outputs reports/blur-bakeoff/phase14/tap-budget.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const fract = (v: number) => v - Math.floor(v)
const glslMod = (a: number, b: number) => a - b * Math.floor(a / b)

interface LensCfg { ior: number; curvature: number }
function lensConstants({ ior, curvature }: LensCfg) {
  const c = Math.min(Math.max(curvature, 0.01), 1.0)
  const amp = curvature > 1.0 ? curvature : 1.0
  const k = Math.min(c, 0.99)
  return { c, amp, k, A: (ior - 1.0) * amp * k }
}
function Lraw(local: number, cfg: LensCfg): number {
  const { amp, k } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  const slope = (x * k) / Math.sqrt(Math.max(1.0 - x * x * k * k, 0.001))
  return local + -slope * (cfg.ior - 1.0) * 0.5 * amp
}
function Lprime(local: number, cfg: LensCfg): number {
  const { k, A } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  return 1.0 - A / Math.pow(1.0 - k * k * x * x, 1.5)
}
const T = (L: number) => 1.0 - Math.abs(fract(L * 0.5) * 2.0 - 1.0)
function sagNorm(local: number, cfg: LensCfg): number {
  const { k } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  return (Math.sqrt(Math.max(1 - x * x * k * k, 0)) - Math.sqrt(Math.max(1 - k * k, 0))) / k
}
function reedLens(coord: number, ribW: number, cfg: LensCfg): [number, number] {
  const { amp } = lensConstants(cfg)
  const local = glslMod(coord, ribW) / ribW
  return [(Math.floor(coord / ribW) + T(Lraw(local, cfg))) * ribW,
    sagNorm(local, cfg) * (cfg.ior - 1.0) * amp]
}

interface Scene {
  ribWidth: number; ior: number; curvature: number; bow: number
  amplitude: number; wavelength: number; dpr: number
}
const ribPx = (s: Scene) => s.ribWidth * s.dpr
function waveAt(s: Scene, perpPx: number) {
  const ampPx = s.amplitude * s.dpr, wlPx = s.wavelength * s.dpr
  if (ampPx === 0) return { w: 0, gp: 0 }
  return {
    w: Math.sin((perpPx / wlPx) * 6.28318) * ampPx,
    gp: (6.28318 * ampPx / wlPx) * Math.cos((perpPx / wlPx) * 6.28318),
  }
}
function sampleAt(s: Scene, mainPx: number, perpPx: number): [number, number] {
  const R = ribPx(s)
  const { w, gp } = waveAt(s, perpPx)
  const W = mainPx + w
  const [lm, ly] = reedLens(W, R, s)
  const disp = lm - W, den = 1 + gp * gp
  return [mainPx + disp / den, perpPx + (disp * gp) / den + ly * (R * 0.5) * s.bow]
}

const USER_1D: Scene = { ribWidth: 80, ior: 1.65, curvature: 2.15, bow: 0, amplitude: 0, wavelength: 577, dpr: 1.5 }
const USER_FULL: Scene = { ...USER_1D, bow: 2.72, amplitude: 20 }
const DEF_1D: Scene = { ribWidth: 80, ior: 1.5, curvature: 0.8, bow: 0, amplitude: 0, wavelength: 577, dpr: 2 }

// ------------------------------------------------------------- source models
type Src = (u: number, v: number) => number
function sceneSrc(): Src {
  // blur 51 then 4.35x magnification: finest feature ~220 px, ~30-code range
  return (u, v) => 128 + 8 * Math.sin((2 * Math.PI * u) / 441) + 5 * Math.sin((2 * Math.PI * v) / 233 + 1.1)
    + 3 * Math.sin((2 * Math.PI * (u + v)) / 617 + 0.4)
}
function noiseSrc(sigma: number): Src {
  const h = (a: number, b: number) => {
    let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ 0x9e3779b9
    x = Math.imul(x ^ (x >>> 13), 1274126177)
    return ((x ^ (x >>> 16)) >>> 0) / 4294967295
  }
  return (u, v) => {
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j
    const t = h(i, j) * (1 - fu) * (1 - fv) + h(i + 1, j) * fu * (1 - fv)
      + h(i, j + 1) * (1 - fu) * fv + h(i + 1, j + 1) * fu * fv
    return 128 + sigma * (t * 2 - 1)
  }
}
/** step of contrast C placed exactly at `at`, 1-px bilinear ramp */
function stepSrc(at: number, C: number): Src {
  return (u) => {
    const t = u - at
    if (t <= -0.5) return 0
    if (t >= 0.5) return C
    return C * (t + 0.5)
  }
}

// ------------------------------------------------------------------ estimators
function geom(s: Scene, perpPx: number) {
  const { gp } = waveAt(s, perpPx)
  const len = Math.hypot(1, gp)
  const nx = 1 / len, ny = gp / len
  const hw = (Math.abs(nx) + Math.abs(ny)) * 0.5
  const plateau = Math.abs(Math.abs(nx) - Math.abs(ny))
  return { nx, ny, hw, plateau }
}
/** uniform-in-screen box over the pixel's projection on the seam normal.
 *  `off` is the within-stratum position: 0.5 = midpoint rule (N=1 is then
 *  EXACTLY the shipped centre tap, which is the known-bad control). */
function screenBox(s: Scene, I: Src, m: number, p: number, N: number, off = 0.5, trap = false): number {
  const { nx, ny, hw, plateau } = geom(s, p)
  let acc = 0, wsum = 0
  for (let i = 0; i < N; i++) {
    const t = -hw + (2 * hw * (i + off)) / N
    const w = trap ? Math.min(1, Math.max(0, (hw - Math.abs(t)) / Math.max(hw - plateau / 2, 1e-9))) : 1
    const q = sampleAt(s, m + t * nx, p + t * ny)
    acc += I(q[0], q[1]) * w; wsum += w
  }
  return acc / wsum
}
/** uniform-in-pre-image, equal weights: N points evenly spaced in SOURCE px
 *  between the two footprint endpoints (M1's second option). */
function preimageBox(s: Scene, I: Src, m: number, p: number, N: number): number {
  const { nx, ny, hw } = geom(s, p)
  const a = sampleAt(s, m - hw * nx, p - hw * ny)
  const b = sampleAt(s, m + hw * nx, p + hw * ny)
  let acc = 0
  for (let i = 0; i < N; i++) {
    const f = (i + 0.5) / N
    acc += I(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
  }
  return acc / N
}
/** the shipped 2-tap analytic seam split (coverage-weighted centroids) */
function shippedSplit(s: Scene, I: Src, m: number, p: number): number {
  const R = ribPx(s)
  const { w, gp } = waveAt(s, p)
  const { nx, ny, hw } = geom(s, p)
  const phi = (m + w) / R
  const den = 1 + gp * gp
  const rate = Math.sqrt(den) / R
  const ss = (Math.floor(phi + 0.5) - phi) / rate
  if (Math.abs(ss) >= hw) return I(...sampleAt(s, m, p))
  const wa = (ss + hw) / (2 * hw)
  const ca = (ss - hw) * 0.5, cb = (ss + hw) * 0.5
  const A = sampleAt(s, m + ca * nx, p + ca * ny)
  const B = sampleAt(s, m + cb * nx, p + cb * ny)
  return I(A[0], A[1]) * wa + I(B[0], B[1]) * (1 - wa)
}

// ------------------------------------------------------------------ main sweep
const NS = [1, 2, 4, 8, 16, 32, 64, 128, 256]
const report: Record<string, unknown> = {}

function sweep(tag: string, s: Scene, perp: number, srcKind: 'scene' | 'noise' | 'step') {
  const R = ribPx(s)
  const cfg = { ior: s.ior, curvature: s.curvature }
  const rows: unknown[] = []
  let gtSelf = 0
  for (let i = 0; i < R; i++) {
    const m = i + 0.5
    const { w } = waveAt(s, perp)
    const lp = Math.abs(Lprime(glslMod(m + w, R) / R, cfg))
    // For the step source, sweep the edge across the footprint (8 placements,
    // planted at the source position of 8 sub-pixel screen offsets) and keep the
    // WORST — planting it at one lucky spot flatters every estimator.
    const placements = srcKind === 'step'
      ? [-0.4375, -0.3125, -0.1875, -0.0625, 0.0625, 0.1875, 0.3125, 0.4375]
      : [0]
    const acc: Record<string, Record<number, number>> = { errScreen: {}, errTrap: {}, errPre: {}, errJit: {} }
    let errSplit = 0
    for (const sp of placements) {
      const I: Src = srcKind === 'scene' ? sceneSrc()
        : srcKind === 'noise' ? noiseSrc(60)
          : stepSrc(sampleAt(s, m + sp, perp)[0], 255)
      const gt = screenBox(s, I, m, perp, 8192)
      gtSelf = Math.max(gtSelf, Math.abs(gt - screenBox(s, I, m, perp, 16384)))
      for (const N of NS) {
        const put = (k: string, v: number) => { acc[k][N] = Math.max(acc[k][N] ?? 0, v) }
        put('errScreen', Math.abs(screenBox(s, I, m, perp, N) - gt))
        put('errTrap', Math.abs(screenBox(s, I, m, perp, N, 0.5, true) - gt))
        put('errPre', Math.abs(preimageBox(s, I, m, perp, N) - gt))
        // stratified + random phase, RMS over 16 rolls (what M4 buys)
        let a = 0
        for (let r = 0; r < 16; r++) a += (screenBox(s, I, m, perp, N, (r * 0.0619 + 0.31) % 1) - gt) ** 2
        put('errJit', Math.sqrt(a / 16))
      }
      errSplit = Math.max(errSplit, Math.abs(shippedSplit(s, I, m, perp) - gt))
    }
    rows.push({ m, absLp: lp, errScreen: acc.errScreen, errTrap: acc.errTrap, errPre: acc.errPre, errJit: acc.errJit, errSplit })
  }
  // bucket by |L'|
  const buckets = [
    { name: "|L'|<1 (no minification)", lo: 0, hi: 1 },
    { name: "1-3", lo: 1, hi: 3 },
    { name: "3-8", lo: 3, hi: 8 },
    { name: "8-30", lo: 8, hi: 30 },
    { name: "30-1000", lo: 30, hi: 1e9 },
  ]
  const out: unknown = { tag, srcKind, gtSelfCheck: gtSelf, buckets: [] }
  console.log(`\n--- ${tag} / source=${srcKind}  (GT self-check 8192 vs 16384: ${gtSelf.toFixed(4)} codes) ---`)
  for (const b of buckets) {
    const sel = rows.filter((r) => r.absLp >= b.lo && r.absLp < b.hi)
    if (!sel.length) continue
    const agg = (f: (r: unknown) => number) => ({ mean: sel.reduce((a, r) => a + f(r), 0) / sel.length, max: Math.max(...sel.map(f)) })
    const line = (label: string, key: string) => {
      const parts = NS.filter((N) => N <= 64).map((N) => `${N}:${agg((r) => r[key][N]).max.toFixed(2)}`)
      console.log(`    ${label.padEnd(16)} max-of-bucket by N  ${parts.join('  ')}`)
    }
    const minN = (key: string) => NS.find((N) => agg((r) => r[key][N]).max < 2.0) ?? null
    console.log(`  bucket ${b.name.padEnd(24)} n=${String(sel.length).padStart(3)} px   1-tap max ${agg((r) => r.errScreen[1]).max.toFixed(2)}  split max ${agg((r) => r.errSplit).max.toFixed(2)} codes`)
    line('screen-uniform', 'errScreen')
    line('screen-trapezoid', 'errTrap')
    line('preimage-uniform', 'errPre')
    line('jittered(RMS)', 'errJit')
    console.log(`    min N for max<2 codes:  screen ${minN('errScreen')}  trap ${minN('errTrap')}  preimage ${minN('errPre')}  jitter ${minN('errJit')}`)
    out.buckets.push({
      ...b, n: sel.length,
      oneTapMax: agg((r) => r.errScreen[1]).max, splitMax: agg((r) => r.errSplit).max,
      screen: Object.fromEntries(NS.map((N) => [N, agg((r) => r.errScreen[N])])),
      trap: Object.fromEntries(NS.map((N) => [N, agg((r) => r.errTrap[N])])),
      pre: Object.fromEntries(NS.map((N) => [N, agg((r) => r.errPre[N])])),
      jit: Object.fromEntries(NS.map((N) => [N, agg((r) => r.errJit[N])])),
      minN: { screen: minN('errScreen'), trap: minN('errTrap'), pre: minN('errPre'), jit: minN('errJit') },
    })
  }
  return out
}

// ------------------------------------------------------- calibration controls
{
  console.log('=== CALIBRATION: known-good and known-bad controls ===')
  const s = USER_FULL, perp = 137.0, m = 95.5
  for (const [k, I] of [['scene', sceneSrc()], ['noise60', noiseSrc(60)], ['step255', stepSrc(sampleAt(s, m + 0.25, perp)[0], 255)]] as [string, Src][]) {
    const gt = screenBox(s, I, m, perp, 8192)
    console.log(`  ${k.padEnd(8)} known-good (exact box, N=8192 vs 16384): ${Math.abs(gt - screenBox(s, I, m, perp, 16384)).toFixed(4)} codes`
      + `  |  known-bad (1 centre tap): ${Math.abs(screenBox(s, I, m, perp, 1) - gt).toFixed(2)} codes`)
  }
  // the 1-tap estimator must equal the shipped single centre tap exactly
  const I0 = sceneSrc()
  const c0 = sampleAt(s, m, perp)
  console.log(`  N=1 midpoint == shipped centre tap? delta ${Math.abs(screenBox(s, I0, m, perp, 1) - I0(c0[0], c0[1])).toExponential(1)} codes`)
}

const all: unknown[] = []
for (const [tag, s, perp] of [
  ['USER straight-rib 1-D (ior1.65 curv2.15, dpr1.5)', USER_1D, 0],
  ['USER full (wave+bow, dpr1.5)', USER_FULL, 137.0],
  ['DEFAULTS (ior1.5 curv0.8, dpr2)', DEF_1D, 0],
] as [string, Scene, number][]) {
  for (const src of ['scene', 'noise', 'step'] as const) all.push(sweep(tag, s, perp, src))
}
report.sweeps = all

// ------------------------------------------- closed-form tap-count predictions
{
  console.log('\n=== predicted tap budgets ===')
  const tol = 2.0
  const rows = [2, 4, 13.78, 175.88, 239.42, 491.84].map((Lp) => ({
    absLp: Lp,
    oneTapPerSourcePx: Math.ceil(Lp),
    nyquistOfSource: Math.ceil(2 * Lp),
    stepRule255: Math.ceil(255 / (2 * tol)),
    stepRule30: Math.ceil(30 / (2 * tol)),
    noiseRule60: Math.min(Math.ceil((60 / tol) ** 2), Math.ceil(Lp)),
    mipTaps8: Math.max(0, Math.log2(Lp / 8)),
  }))
  console.table(rows)
  report.predictions = rows
}

mkdirSync('reports/blur-bakeoff/phase14', { recursive: true })
writeFileSync('reports/blur-bakeoff/phase14/tap-budget.json', JSON.stringify(report, null, 2))
console.log('\nwrote reports/blur-bakeoff/phase14/tap-budget.json')
