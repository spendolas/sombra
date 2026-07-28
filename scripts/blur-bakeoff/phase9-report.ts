/**
 * Phase 9b — aggregation of the frost bake-off sweep.
 *
 * Reads reports/blur-bakeoff/phase9/phase9.json (written by phase9-frost.ts
 * --sweep) and answers the four questions the phase was run to answer. It does
 * NOT re-run the GPU; it only reduces the per-row matrix.
 *
 *   npx tsx scripts/blur-bakeoff/phase9-report.ts [--quick]
 *
 * Every threshold used here is one that phase9-frost.ts --validate proved on a
 * synthetic known-good AND known-bad, except the "indistinguishable from C7"
 * criterion, which is SELF-CALIBRATING: a candidate counts as converged when its
 * deviation from C7 is no larger than the deviation between two independent
 * realisations of C7 itself (the C7 row of the re-roll table). That is the
 * ground truth's own noise floor, so it cannot be gamed by picking a number.
 */

import fs from 'node:fs'
import path from 'node:path'

const OUT = path.join('reports', 'blur-bakeoff', 'phase9')
const quick = process.argv.includes('--quick')
const SRC = path.join(OUT, `phase9${quick ? '-quick' : ''}.json`)

interface Row {
  candidate: string
  backend: string
  stim: string
  frost: number
  dpr: number
  radiusPx: number
  taps: number
  fetches: number
  acf1: number
  acf4: number
  acfMaxBeyond2: number
  shoulderLag: number
  domPeriod: number | null
  domAmp: number
  blockExcess: number
  vsGtMean: number
  vsGtP99: number
  vsFamilyMean: number
  vsFamilyP99: number
  speckleExcess: number
  alphaMean: number
  alphaMax: number
  grainAnisotropy: number | null
}
interface Psf {
  candidate: string
  dpr: number
  R: number
  squareness: number
  holeDeficit: number
  massOutsideR: number
  profileL1Disc: number
  profileL1Gauss: number
  ringiness: number
  clipFraction: number
  massCaptured: number
}
interface Reroll { candidate: string; backend: string; frost: number; dpr: number; mean: number; p99: number; max: number }
interface Flip { candidate: string; backend: string; frost: number; flipMean: number; floorMean: number; excess: number; flipMax: number }
interface Cand { id: string; taps: number; fetches: number; familyRef: string; note: string }

const P = JSON.parse(fs.readFileSync(SRC, 'utf8')) as {
  rows: Row[]
  psf: Psf[]
  reroll: Reroll[]
  dprFlip: Flip[]
  candidates: Cand[]
  cost: { gfetchPerSec: number | null; splitDisagreement: number; residRmsMs: number; spanMs: number; usable: boolean; size: number; reps: number } | null
  captures: number
  elapsedSec: number
}

const GT = new Set(['C7', 'GTsq', 'GTg'])
const r2 = (v: number) => Math.round(v * 100) / 100
const r3 = (v: number) => Math.round(v * 1000) / 1000
const max = (a: number[]) => (a.length ? Math.max(...a) : NaN)
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)

const L: string[] = []
const say = (s = '') => {
  L.push(s)
  console.log(s)
}

// The gates, exactly as --validate calibrated them.
//
// IMPORTANT — which of these is allowed to decide "blocky".
// --validate calibrated acf4 < 0.15 / shoulderLag <= 1 on a PHOTOGRAPHIC
// stimulus plus iid noise. Measured here on the real matrix, the alpha-sprite
// stimulus puts a floor of acf1 ~ 0.25, acf4 ~ 0.11-0.19, shoulderLag 3-4 under
// EVERY sparse candidate, ground-truth-converged ones included, and that floor
// FALLS with tap count (C3-8 acf4 0.177 -> C3-24 0.111, shoulder 4 -> 3) while
// the periodic metrics stay flat (domAmp ~0.09-0.13 for all of them). It is
// therefore estimator noise in the premultiplied ratio near an alpha edge, not
// block structure — and a blockiness verdict built on acf alone would fire on
// the known-good, which is the exact failure this project keeps being burned by.
//
// So: BLOCKINESS is decided by the two PERIODIC metrics, which --validate proved
// on a known-good (domAmp 0.014 codes, blockExcess -0.02 codes) and a known-bad
// (2.031 codes at period 8, 8.37 codes). acf is reported as a corroborator,
// against an in-cell floor measured from the 24-tap candidates rather than
// against the photographic constant.
const GATES = {
  domAmp: 0.25, // codes — periodic block-edge amplitude. THE blockiness gate.
  blockExcess: 0.5, // codes — block-edge step excess. THE blockiness gate.
  acf4Excess: 0.15, // over the in-cell 24-tap floor — corroborator only
  squareness: 1.05,
  holeDeficit: 0.15,
  ringiness: 0.2,
  profileL1Disc: 0.1,
  massCapturedLo: 0.95,
  massCapturedHi: 1.05,
}

/** Empirical converged floor for the correlation metrics, per (backend,stim,frost,dpr):
 *  the best a 24-tap stratified disc achieves in that exact cell. */
const FLOOR_CANDS = ['C3-24', 'C3j-24', 'C5-24']
function cellKey(r: Row): string {
  return `${r.backend}|${r.stim}|${r.frost}|${r.dpr}`
}

const order = P.candidates.map((c) => c.id)
const byId = new Map(P.candidates.map((c) => [c.id, c]))
const rowsOf = (id: string, f?: (r: Row) => boolean) => P.rows.filter((r) => r.candidate === id && (!f || f(r)))

say(`# Phase 9b — frost bake-off, reduced\n`)
say(`Source: ${SRC}  (${P.rows.length} rows, ${P.captures} GPU captures, ${P.elapsedSec}s)`)
const backends = [...new Set(P.rows.map((r) => r.backend))]
const frosts = [...new Set(P.rows.map((r) => r.frost))].sort((a, b) => a - b)
const dprs = [...new Set(P.rows.map((r) => r.dpr))].sort()
const stims = [...new Set(P.rows.map((r) => r.stim))]
say(`Matrix: backends ${backends.join('/')} | frost ${frosts.join(', ')} | dpr ${dprs.join(', ')} | stimuli ${stims.join(', ')}\n`)

// ---------------------------------------------------------------------------
// 0. The self-calibrated convergence floor: C7 against another C7.
// ---------------------------------------------------------------------------
const c7Reroll = P.reroll.filter((r) => r.candidate === 'C7')
const floorByFD = new Map<string, number>()
for (const r of c7Reroll) floorByFD.set(`${r.frost}|${r.dpr}`, r.mean)
const floorGlobal = max(c7Reroll.map((r) => r.mean))
say(`## 0. Convergence floor (C7 vs an independently seeded C7)\n`)
say('| frost | dpr | C7-vs-C7 mean (codes) | p99 | max |')
say('|---|---|---|---|---|')
for (const r of c7Reroll.sort((a, b) => a.dpr - b.dpr || a.frost - b.frost))
  say(`| ${r.frost} | ${r.dpr} | ${r.mean} | ${r.p99} | ${r.max} |`)
say(`\nWorst floor over the matrix: **${r2(floorGlobal)} codes**. A candidate whose vsGT mean is at`)
say(`or under the floor for its own (frost, dpr) is inside the ground truth's own sampling noise:`)
say(`no measurement in this bench can tell it from C7.\n`)

// ---------------------------------------------------------------------------
// 1. Headline per-candidate table: worst case over the WHOLE matrix.
// ---------------------------------------------------------------------------
// in-cell converged floor for acf4 / shoulder
const acf4Floor = new Map<string, number>()
const shoulderFloor = new Map<string, number>()
for (const r of P.rows) {
  if (!FLOOR_CANDS.includes(r.candidate)) continue
  const k = cellKey(r)
  acf4Floor.set(k, Math.min(acf4Floor.get(k) ?? Infinity, r.acf4))
  shoulderFloor.set(k, Math.min(shoulderFloor.get(k) ?? Infinity, r.shoulderLag))
}

say(`## 1. Worst case over the whole matrix (all backends, frost, DPR, stimuli)\n`)
say('| cand | taps | fetch/px | domAmp max | blockX max | acf4 max | acf4 excess over 24-tap floor | shoulder max | vsGT mean worst | vsGT mean avg | vsFam mean worst | speckleΔ worst | alphaMean worst | alphaMax | blocky? | converged? |')
say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
interface Agg {
  id: string
  taps: number
  fetches: number
  acf4: number
  acf4Ex: number
  shoulder: number
  domAmp: number
  blockX: number
  vsGtWorst: number
  vsGtAvg: number
  vsFamWorst: number
  speckleWorst: number
  alphaMeanWorst: number
  alphaMax: number
  blocky: boolean
  converged: boolean
  convergedFrac: string
}
const aggs: Agg[] = []
for (const id of order) {
  const rs = rowsOf(id)
  if (!rs.length) continue
  const blocky = max(rs.map((r) => r.domAmp)) >= GATES.domAmp || max(rs.map((r) => r.blockExcess)) >= GATES.blockExcess
  const acf4Ex = max(rs.map((r) => r.acf4 - (acf4Floor.get(cellKey(r)) ?? 0)))
  // converged: vsGT mean <= the C7-vs-C7 floor at the SAME (frost, dpr), everywhere
  const conv = rs.filter((r) => {
    const f = floorByFD.get(`${r.frost}|${r.dpr}`)
    return f !== undefined && r.vsGtMean <= f
  })
  const withFloor = rs.filter((r) => floorByFD.has(`${r.frost}|${r.dpr}`))
  const a: Agg = {
    id,
    taps: byId.get(id)!.taps,
    fetches: byId.get(id)!.fetches,
    acf4: r3(max(rs.map((r) => r.acf4))),
    acf4Ex: r3(acf4Ex),
    shoulder: max(rs.map((r) => r.shoulderLag)),
    domAmp: r3(max(rs.map((r) => r.domAmp))),
    blockX: r2(max(rs.map((r) => r.blockExcess))),
    vsGtWorst: r2(max(rs.map((r) => r.vsGtMean))),
    vsGtAvg: r2(mean(rs.map((r) => r.vsGtMean))),
    vsFamWorst: r2(max(rs.map((r) => r.vsFamilyMean))),
    speckleWorst: r2(max(rs.map((r) => r.speckleExcess))),
    alphaMeanWorst: r2(max(rs.map((r) => r.alphaMean))),
    alphaMax: max(rs.map((r) => r.alphaMax)),
    blocky,
    converged: withFloor.length > 0 && conv.length === withFloor.length,
    convergedFrac: `${conv.length}/${withFloor.length}`,
  }
  aggs.push(a)
  say(
    `| ${a.id} | ${a.taps} | ${a.fetches} | ${a.domAmp} | ${a.blockX} | ${a.acf4} | ${a.acf4Ex} | ${a.shoulder} | ${a.vsGtWorst} | ${a.vsGtAvg} | ${a.vsFamWorst} | ${a.speckleWorst} | ${a.alphaMeanWorst} | ${a.alphaMax} | ${a.blocky ? '**YES**' : 'no'} | ${a.converged ? 'YES' : a.convergedFrac} |`,
  )
}
say(`\nBlockiness gate = domAmp >= ${GATES.domAmp} codes OR blockExcess >= ${GATES.blockExcess} codes (the two PERIODIC`)
say(`metrics; see the GATES comment for why acf is not allowed to decide this). "acf4 excess" is`)
say(`over the best 24-tap candidate in the SAME cell, so the stimulus-dependent estimator floor is`)
say(`subtracted; a value near 0 means the candidate's residual is no more correlated than a`)
say(`converged one's. "converged" = vsGT mean at or under the C7-vs-C7 floor in EVERY (frost, dpr) cell.\n`)

// ---------------------------------------------------------------------------
// 2. Frost sweep: the wide end is the decisive case.
// ---------------------------------------------------------------------------
for (const dpr of dprs) {
  say(`## 2.${dpr} vsGT mean (codes) by frost, DPR ${dpr}, averaged over stimuli and backends\n`)
  say(`| cand | ${frosts.map((f) => `f=${f} (R=${f * 24 * dpr}px)`).join(' | ')} |`)
  say(`|---|${frosts.map(() => '---').join('|')}|`)
  for (const id of order) {
    const cells = frosts.map((f) => {
      const rs = rowsOf(id, (r) => r.frost === f && r.dpr === dpr)
      return rs.length ? r2(mean(rs.map((r) => r.vsGtMean))) : '-'
    })
    say(`| ${id} | ${cells.join(' | ')} |`)
  }
  say('')
}

// ---------------------------------------------------------------------------
// 3. Blockiness detail: the lattice question, per stimulus.
// ---------------------------------------------------------------------------
say(`## 3. Blockiness, worst stimulus per candidate (acf4 / shoulder / domAmp codes / blockExcess codes)\n`)
say('| cand | worst stim | frost | dpr | acf1 | acf4 | shoulder | period | domAmp | blockExcess |')
say('|---|---|---|---|---|---|---|---|---|---|')
for (const id of order) {
  const rs = rowsOf(id)
  if (!rs.length) continue
  const w = rs.reduce((a, b) => (b.acf4 + b.domAmp / 4 > a.acf4 + a.domAmp / 4 ? b : a))
  say(`| ${id} | ${w.stim} | ${w.frost} | ${w.dpr} | ${w.acf1} | ${w.acf4} | ${w.shoulderLag} | ${w.domPeriod ?? '-'} | ${w.domAmp} | ${w.blockExcess} |`)
}
say('')

// ---------------------------------------------------------------------------
// 4. Backend parity.
// ---------------------------------------------------------------------------
say(`## 4. Backend parity (WebGPU vs WebGL2, same cell)\n`)
if (backends.length < 2) {
  say('Only one backend in this run — parity not measurable.\n')
} else {
  say('Disqualification rule: any candidate whose two backends disagree by more than 1.0 code')
  say('in vsGT mean, in any cell.\n')
  say('| cand | max |Δ vsGT mean| | cell | max |Δ acf4| | max |Δ speckleΔ| | verdict |')
  say('|---|---|---|---|---|---|')
  for (const id of order) {
    const wg = rowsOf(id, (r) => r.backend === 'webgpu')
    let worst = 0
    let worstCell = ''
    let worstAcf = 0
    let worstSpk = 0
    for (const a of wg) {
      const b = P.rows.find(
        (r) => r.candidate === id && r.backend === 'webgl2' && r.stim === a.stim && r.frost === a.frost && r.dpr === a.dpr,
      )
      if (!b) continue
      const d = Math.abs(a.vsGtMean - b.vsGtMean)
      if (d > worst) {
        worst = d
        worstCell = `${a.stim} f=${a.frost} dpr=${a.dpr}`
      }
      worstAcf = Math.max(worstAcf, Math.abs(a.acf4 - b.acf4))
      worstSpk = Math.max(worstSpk, Math.abs(a.speckleExcess - b.speckleExcess))
    }
    say(`| ${id} | ${r2(worst)} | ${worstCell} | ${r3(worstAcf)} | ${r2(worstSpk)} | ${worst > 1.0 ? '**DISQUALIFIED**' : 'ok'} |`)
  }
  say('')
}

// ---------------------------------------------------------------------------
// 5. Kernel shape.
// ---------------------------------------------------------------------------
say(`## 5. Kernel shape (PSF, R = 24*dpr device px)\n`)
say('| cand | dpr | squareness | holeDeficit | massOutsideR | L1 vs disc | ringiness | massCaptured | shape verdict |')
say('|---|---|---|---|---|---|---|---|---|')
for (const p of P.psf) {
  const valid = p.massCaptured >= GATES.massCapturedLo && p.massCaptured <= GATES.massCapturedHi
  const bad: string[] = []
  if (p.squareness >= GATES.squareness) bad.push('square')
  if (p.holeDeficit >= GATES.holeDeficit) bad.push('hole')
  if (p.ringiness >= GATES.ringiness) bad.push('rings')
  if (p.profileL1Disc >= GATES.profileL1Disc) bad.push('profile')
  say(
    `| ${p.candidate} | ${p.dpr} | ${p.squareness} | ${p.holeDeficit} | ${p.massOutsideR} | ${p.profileL1Disc} | ${p.ringiness} | ${p.massCaptured}${valid ? '' : ' **!**'} | ${bad.length ? bad.join('+') : 'clean disc'} |`,
  )
}
say('')

// ---------------------------------------------------------------------------
// 6. Temporal: re-roll and the DPR-tier flip.
// ---------------------------------------------------------------------------
say(`## 6. Re-roll on a new seed (mean |Δ| codes), photo-street, WebGPU\n`)
const rrF = [...new Set(P.reroll.map((r) => r.frost))].sort((a, b) => a - b)
const rrD = [...new Set(P.reroll.map((r) => r.dpr))].sort()
say(`| cand | ${rrD.flatMap((d) => rrF.map((f) => `dpr${d} f${f}`)).join(' | ')} | worst |`)
say(`|---|${rrD.flatMap(() => rrF.map(() => '---')).join('|')}|---|`)
for (const id of order) {
  const cells: string[] = []
  const vals: number[] = []
  for (const d of rrD)
    for (const f of rrF) {
      const r = P.reroll.find((x) => x.candidate === id && x.dpr === d && x.frost === f)
      cells.push(r ? String(r.mean) : '-')
      if (r) vals.push(r.mean)
    }
  say(`| ${id} | ${cells.join(' | ')} | ${r2(max(vals))} |`)
}
say('')

say(`## 7. DPR-tier flip 2.0 -> 1.5 (excess over the pure-resample floor, codes)\n`)
const fF = [...new Set(P.dprFlip.map((r) => r.frost))].sort((a, b) => a - b)
say(`| cand | ${fF.map((f) => `f=${f} flip`).join(' | ')} | ${fF.map((f) => `f=${f} floor`).join(' | ')} | ${fF.map((f) => `f=${f} EXCESS`).join(' | ')} |`)
say(`|---|${fF.map(() => '---').join('|')}|${fF.map(() => '---').join('|')}|${fF.map(() => '---').join('|')}|`)
for (const id of order) {
  const g = (f: number) => P.dprFlip.find((x) => x.candidate === id && x.frost === f)
  say(
    `| ${id} | ${fF.map((f) => g(f)?.flipMean ?? '-').join(' | ')} | ${fF.map((f) => g(f)?.floorMean ?? '-').join(' | ')} | ${fF.map((f) => g(f)?.excess ?? '-').join(' | ')} |`,
  )
}
say('')

// ---------------------------------------------------------------------------
// 8. Did any gate fire on the ground truth? That is a bench bug, not a result.
// ---------------------------------------------------------------------------
say(`## 8. Gates fired on GROUND TRUTH rows (bench-bug check)\n`)
const bugs: string[] = []
for (const id of ['C7', 'GTsq', 'GTg']) {
  for (const r of rowsOf(id)) {
    const cell = `${id} ${r.backend} ${r.stim} f=${r.frost} dpr=${r.dpr}`
    if (r.acf4 >= GATES.acf4) bugs.push(`${cell}: acf4 ${r.acf4} >= ${GATES.acf4}`)
    if (r.shoulderLag > GATES.shoulderLag) bugs.push(`${cell}: shoulderLag ${r.shoulderLag} > ${GATES.shoulderLag}`)
    if (r.domAmp >= GATES.domAmp) bugs.push(`${cell}: domAmp ${r.domAmp} >= ${GATES.domAmp}`)
    if (r.blockExcess >= GATES.blockExcess) bugs.push(`${cell}: blockExcess ${r.blockExcess} >= ${GATES.blockExcess}`)
  }
}
// C7 is the disc reference; GTsq is a SQUARE and GTg a GAUSSIAN by construction,
// so only C7's shape is expected to read as a clean disc.
for (const p of P.psf.filter((x) => x.candidate === 'C7')) {
  const cell = `C7 psf dpr=${p.dpr}`
  if (p.squareness >= GATES.squareness) bugs.push(`${cell}: squareness ${p.squareness} >= ${GATES.squareness}`)
  if (p.holeDeficit >= GATES.holeDeficit) bugs.push(`${cell}: holeDeficit ${p.holeDeficit} >= ${GATES.holeDeficit}`)
  if (p.ringiness >= GATES.ringiness) bugs.push(`${cell}: ringiness ${p.ringiness} >= ${GATES.ringiness}`)
  if (p.profileL1Disc >= GATES.profileL1Disc) bugs.push(`${cell}: profileL1Disc ${p.profileL1Disc} >= ${GATES.profileL1Disc}`)
  if (p.massCaptured < GATES.massCapturedLo || p.massCaptured > GATES.massCapturedHi)
    bugs.push(`${cell}: massCaptured ${p.massCaptured} outside [${GATES.massCapturedLo}, ${GATES.massCapturedHi}]`)
  if (p.clipFraction > 0) bugs.push(`${cell}: clipFraction ${p.clipFraction} > 0`)
}
if (!bugs.length) say('None. Every gate is silent on C7 / GTsq / GTg.\n')
else for (const b of bugs) say(`- ${b}`)
say('')

// ---------------------------------------------------------------------------
// 9. Ranking + the cheapest converged candidate.
// ---------------------------------------------------------------------------
say(`## 9. Ranking\n`)
const shippable = aggs.filter((a) => !GT.has(a.id) && a.id !== 'C6')
// primary: not blocky. secondary: worst vsGT mean. tie-break: fetches.
const ranked = [...shippable].sort((a, b) => Number(a.blocky) - Number(b.blocky) || a.vsGtWorst - b.vsGtWorst || a.fetches - b.fetches)
say('| # | cand | blocky | vsGT worst | speckleΔ worst | fetch/px | derived ms @1080p |')
say('|---|---|---|---|---|---|---|')
const rate = P.cost?.gfetchPerSec ?? null
const ms = (f: number, px = 1920 * 1080) => (rate ? String(Math.round(((f * px) / (rate * 1e9)) * 1e4) / 10) : 'n/a')
ranked.forEach((a, i) => say(`| ${i + 1} | ${a.id} | ${a.blocky ? 'YES' : 'no'} | ${a.vsGtWorst} | ${a.speckleWorst} | ${a.fetches} | ${ms(a.fetches)} |`))
say('')

const convergedShippable = shippable.filter((a) => a.converged && !a.blocky).sort((a, b) => a.fetches - b.fetches)
say(`### Cheapest candidate inside the C7 noise floor everywhere\n`)
if (convergedShippable.length) {
  const c = convergedShippable[0]
  say(`**${c.id}** — ${c.taps} taps, ${c.fetches} fetches/px, worst vsGT ${c.vsGtWorst} codes vs a floor of ${r2(floorGlobal)}.`)
} else {
  say('No shippable candidate reaches the C7-vs-C7 floor at every frost/DPR. Nearest approach:')
  const near = [...shippable].filter((a) => !a.blocky).sort((a, b) => a.vsGtWorst - b.vsGtWorst)
  for (const a of near.slice(0, 6)) say(`- ${a.id}: worst vsGT ${a.vsGtWorst} codes (${a.convergedFrac} cells inside the floor), ${a.fetches} fetches/px`)
}
say('')

// A perceptual budget that is not the ground truth's noise floor: the smallest
// tap count whose worst-case vsGT mean is under 1 code (below 8-bit visibility
// on a smooth gradient) and under 2 codes at p99.
say(`### Tap count needed, by budget\n`)
say('| budget (worst-case vsGT mean, codes) | cheapest non-blocky candidate | fetch/px |')
say('|---|---|---|')
for (const budget of [0.5, 1, 1.5, 2, 3, 4, 6]) {
  const ok = shippable.filter((a) => !a.blocky && a.vsGtWorst <= budget).sort((a, b) => a.fetches - b.fetches)
  say(`| <= ${budget} | ${ok.length ? ok[0].id : 'none'} | ${ok.length ? ok[0].fetches : '-'} |`)
}
say('')

if (P.cost) {
  say(`## 10. Cost\n`)
  say(
    `Marginal fetch rate **${P.cost.gfetchPerSec} Gfetch/s** (${P.cost.size}x${P.cost.size}, ${P.cost.reps} reps, interleaved ladder; ` +
      `split-half disagreement ${Math.round(P.cost.splitDisagreement * 1000) / 10}%, fit residual ${r2(P.cost.residRmsMs)} ms over a ${r2(P.cost.spanMs)} ms span, usable=${P.cost.usable}).`,
  )
  say('All per-candidate ms figures are DERIVED from this rate; they are a lower bound counting dependent bilinear fetches only.\n')
}

fs.writeFileSync(path.join(OUT, `phase9-reduced${quick ? '-quick' : ''}.md`), L.join('\n') + '\n')
console.log(`\nwrote ${path.join(OUT, `phase9-reduced${quick ? '-quick' : ''}.md`)}`)
