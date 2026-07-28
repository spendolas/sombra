/**
 * Phase 14c — fold structure, the inverse map, staircase geometry, tap cost.
 * Pure CPU maths. Outputs reports/blur-bakeoff/phase14/fold-structure.json
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
  return local + -((x * k) / Math.sqrt(Math.max(1 - x * x * k * k, 0.001))) * (cfg.ior - 1) * 0.5 * amp
}
function Lprime(local: number, cfg: LensCfg): number {
  const { k, A } = lensConstants(cfg)
  const x = (local - 0.5) * 2.0
  return 1 - A / Math.pow(1 - k * k * x * x, 1.5)
}
const T = (L: number) => 1 - Math.abs(fract(L * 0.5) * 2 - 1)
function sagNorm(local: number, cfg: LensCfg) {
  const { k } = lensConstants(cfg)
  const x = (local - 0.5) * 2
  return (Math.sqrt(Math.max(1 - x * x * k * k, 0)) - Math.sqrt(Math.max(1 - k * k, 0))) / k
}
interface Scene { ribWidth: number; ior: number; curvature: number; bow: number; amplitude: number; wavelength: number; dpr: number }
const USER: Scene = { ribWidth: 80, ior: 1.65, curvature: 2.15, bow: 2.72, amplitude: 20, wavelength: 577, dpr: 1.5 }
const ribPx = (s: Scene) => s.ribWidth * s.dpr
function waveAt(s: Scene, p: number) {
  const a = s.amplitude * s.dpr, wl = s.wavelength * s.dpr
  if (a === 0) return { w: 0, gp: 0 }
  return { w: Math.sin((p / wl) * 6.28318) * a, gp: (6.28318 * a / wl) * Math.cos((p / wl) * 6.28318) }
}
function sampleAt(s: Scene, m: number, p: number): [number, number] {
  const R = ribPx(s), { w, gp } = waveAt(s, p), W = m + w
  const local = glslMod(W, R) / R
  const lm = (Math.floor(W / R) + T(Lraw(local, s))) * R
  const disp = lm - W, den = 1 + gp * gp
  const { amp } = lensConstants(s)
  const ly = sagNorm(local, s) * (s.ior - 1) * amp
  return [m + disp / den, p + (disp * gp) / den + ly * (R * 0.5) * s.bow]
}
const report: Record<string, unknown> = {}

// ---- 1. exact segment extents + multiplicity for the worst pixels
{
  console.log('=== footprint segments and multiplicity (user, dpr 1.5) ===')
  const s = USER, R = ribPx(s), perp = 137.0
  const { gp } = waveAt(s, perp)
  const len = Math.hypot(1, gp), nx = 1 / len, ny = gp / len
  const hw = (Math.abs(nx) + Math.abs(ny)) * 0.5
  const rows: unknown[] = []
  for (let i = 0; i < R; i++) {
    const m = i + 0.5
    const N = 40001
    const pos: number[] = []
    for (let j = 0; j < N; j++) {
      const t = -hw + (2 * hw * j) / (N - 1)
      pos.push(sampleAt(s, m + t * nx, perp + t * ny)[0])
    }
    const segs: { lo: number; hi: number }[] = []
    let lo = pos[0], hi = pos[0], folds = 0, dir = 0
    for (let j = 1; j < pos.length; j++) {
      const d = pos[j] - pos[j - 1]
      if (Math.abs(d) > 0.5 * R) { segs.push({ lo, hi }); lo = pos[j]; hi = pos[j]; dir = 0; continue }
      const sg = Math.sign(d)
      if (sg && dir && sg !== dir) folds++
      if (sg) dir = sg
      lo = Math.min(lo, pos[j]); hi = Math.max(hi, pos[j])
    }
    segs.push({ lo, hi })
    // multiplicity: how many times the map covers the busiest source point
    const grid = 2000, gLo = Math.min(...segs.map((q) => q.lo)), gHi = Math.max(...segs.map((q) => q.hi))
    let mult = 0
    if (gHi > gLo) {
      const cnt = new Int32Array(grid)
      for (let j = 1; j < pos.length; j++) {
        if (Math.abs(pos[j] - pos[j - 1]) > 0.5 * R) continue
        const a = Math.min(pos[j - 1], pos[j]), b = Math.max(pos[j - 1], pos[j])
        const ia = Math.max(0, Math.floor(((a - gLo) / (gHi - gLo)) * (grid - 1)))
        const ib = Math.min(grid - 1, Math.ceil(((b - gLo) / (gHi - gLo)) * (grid - 1)))
        for (let q = ia; q <= ib; q++) cnt[q]++
      }
      // count monotone branch crossings, not sample counts: normalise by
      // samples-per-branch-crossing of the coarsest branch
      const perBranch = (N - 1) / Math.max(1, (gHi - gLo))
      mult = Math.max(...Array.from(cnt)) / Math.max(1, perBranch * ((gHi - gLo) / grid))
    }
    rows.push({ m, segs, folds, span: segs.reduce((a, q) => a + (q.hi - q.lo), 0), disjoint: segs.length > 1, mult })
  }
  const worst = [...rows].sort((a, b) => b.span - a.span).slice(0, 5)
  for (const r of worst) {
    console.log(`  main ${r.m}: total ${r.span.toFixed(1)} src px, ${r.segs.length} segment(s) ${r.segs.map((q: unknown) => `[${q.lo.toFixed(1)}, ${q.hi.toFixed(1)}]`).join(' U ')}, ${r.folds} fold(s), peak coverage multiplicity ~${r.mult.toFixed(1)}`)
  }
  const nDis = rows.filter((r) => r.disjoint).length, nFold = rows.filter((r) => r.folds).length
  console.log(`  per rib (${R} px): ${nDis} pixel(s) with a DISJOINT footprint (seam jump), ${nFold} pixel(s) containing >=1 fold`)
  report.segments = { worst, nDisjoint: nDis, nFolded: nFold, ribPx: R }
}

// ---- 2. is the inverse of L closed form?  -> yes, a quartic
{
  console.log('\n=== inverse map L^{-1}: quartic in x ===')
  const cfg = { ior: 1.65, curvature: 2.15 }
  const { k, A } = lensConstants(cfg)
  const c1 = A / 2
  // (x/2 + b)^2 (1 - k^2 x^2) - c1^2 x^2 = 0, b = 1/2 - u
  const quarticResidual = (x: number, u: number) => {
    const b = 0.5 - u
    return (x / 2 + b) ** 2 * (1 - k * k * x * x) - c1 * c1 * x * x
  }
  let worst = 0
  for (let i = 1; i < 500; i++) {
    const local = i / 500
    const x = 2 * local - 1
    const u = Lraw(local, cfg)
    worst = Math.max(worst, Math.abs(quarticResidual(x, u)))
  }
  console.log(`  |residual| of the quartic at 499 true (x, L(x)) pairs: max ${worst.toExponential(2)}`)
  console.log(`  => L^{-1} is algebraic (quartic, Ferrari-solvable) but multivalued: squaring adds the`)
  console.log(`     sign-flipped branch, so each tap needs a quartic solve + root selection + rejection.`)
  report.inverse = { form: '(x/2 + (1/2-u))^2 (1 - k^2 x^2) - (A/2)^2 x^2 = 0', maxResidual: worst }
}

// ---- 3. staircase geometry: fold loci are iso-phase lines
{
  console.log('\n=== staircase run length (rows per 1 px lateral step) ===')
  const s = USER
  const gpMax = (6.28318 * s.amplitude * s.dpr) / (s.wavelength * s.dpr)
  const rows = [0, 0.25, 0.5, 0.75, 0.9].map((f) => {
    const gp = gpMax * Math.cos(f * Math.PI)
    return { phaseFrac: f, gp, tiltDeg: (Math.atan(Math.abs(gp)) * 180) / Math.PI, rowsPerPx: Math.abs(gp) > 1e-9 ? 1 / Math.abs(gp) : Infinity }
  })
  console.table(rows)
  console.log(`  gp_max = 2*pi*amplitude/wavelength = ${gpMax.toFixed(5)} (dpr-independent) => min run ${(1 / gpMax).toFixed(2)} rows/px, tilt <= ${(Math.atan(gpMax) * 180 / Math.PI).toFixed(2)} deg`)
  report.staircase = { gpMax, minRowsPerPx: 1 / gpMax, rows }
}

// ---- 4. alternative caustic counts (does 28 reproduce under any counting?)
{
  console.log('\n=== caustic-count reconciliation ===')
  const count = (cfg: LensCfg) => {
    const { k, A } = lensConstants(cfg)
    const zeros = A <= 1 && Math.sqrt(1 - Math.pow(A, 2 / 3)) / k <= 1 ? 2 : 0
    // integer crossings of L on each monotone branch
    let wraps = 0
    const bs: number[] = zeros ? [0, 0.5 * (1 - Math.sqrt(1 - Math.pow(A, 2 / 3)) / k), 0.5 * (1 + Math.sqrt(1 - Math.pow(A, 2 / 3)) / k), 1] : [0, 1]
    for (let i = 0; i < bs.length - 1; i++) {
      const La = Lraw(bs[i] + 1e-12, cfg), Lb = Lraw(bs[i + 1] - 1e-12, cfg)
      wraps += Math.max(0, Math.floor(Math.max(La, Lb)) - Math.ceil(Math.min(La, Lb)) + 1)
    }
    const range = Math.abs(Lraw(1e-12, cfg) - Lraw(1 - 1e-12, cfg))
    return { zeros, wraps, total: zeros + wraps, lines2x: 2 * (zeros + wraps), Lrange: range, ribTraversals: zeros + wraps + 1 }
  }
  const tbl = [0.85, 0.9, 1.0, 1.5, 2.0].map((cv) => ({ curvature: cv, ...count({ ior: 1.5, curvature: cv }) }))
  console.table(tbl)
  const u = count({ ior: 1.65, curvature: 2.15 })
  console.log(`  USER (1.65/2.15): ${JSON.stringify(u)}`)
  console.log('  published series was 2 -> 4 -> 8 -> 28 for curvature 0.85/0.90/1.00/2.00')
  report.causticCounts = { tbl, user: u }
}

// ---- 5. cost of an adaptive tap count across a real rib
{
  console.log('\n=== average tap cost of N = clamp(ceil(|L\'|), 1, Nmax) ===')
  const out: unknown[] = []
  for (const [tag, cfg, dpr] of [
    ['defaults 1.5/0.80', { ior: 1.5, curvature: 0.8 }, 2],
    ['1.5/0.85', { ior: 1.5, curvature: 0.85 }, 2],
    ['USER 1.65/2.15', { ior: 1.65, curvature: 2.15 }, 1.5],
    ['USER 1.65/2.15', { ior: 1.65, curvature: 2.15 }, 2],
    ['2.5/0.80', { ior: 2.5, curvature: 0.8 }, 2],
    ['1.5/1.50', { ior: 1.5, curvature: 1.5 }, 2],
  ] as [string, LensCfg, number][]) {
    const R = 80 * dpr
    const row: unknown = { tag, dpr, ribPx: R }
    for (const Nmax of [1, 2, 4, 8, 16, 32]) {
      let taps = 0, over = 0
      for (let i = 0; i < R; i++) {
        const lp = Math.abs(Lprime((i + 0.5) / R, cfg))
        const want = Math.max(1, Math.ceil(lp))
        taps += Math.min(want, Nmax)
        if (want > Nmax) over++
      }
      row[`Nmax${Nmax}`] = +(taps / R).toFixed(3)
      row[`capped${Nmax}`] = over
    }
    out.push(row)
    console.log(`  ${tag} @dpr${dpr}: mean taps/px  ${[1, 2, 4, 8, 16, 32].map((n) => `Nmax${n}:${row[`Nmax${n}`]}(${row[`capped${n}`]}px capped)`).join('  ')}`)
  }
  report.tapCost = out
}

mkdirSync('reports/blur-bakeoff/phase14', { recursive: true })
writeFileSync('reports/blur-bakeoff/phase14/fold-structure.json', JSON.stringify(report, null, 2))
console.log('\nwrote reports/blur-bakeoff/phase14/fold-structure.json')
