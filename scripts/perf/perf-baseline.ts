/**
 * perf:baseline — opt-in regression diff of reports/perf/latest.json against a
 * committed-per-runner reports/perf/baseline.json. Tolerance: GPU total may rise
 * at most +15%, FPS p50 may fall at most -15%. Non-zero exit on any regression.
 *
 * GPU timings are machine-dependent, so the baseline is per-runner (not a shared
 * hard gate). Usage:
 *   npm run perf:baseline                 # diff latest vs baseline
 *   npm run perf:baseline -- --update     # copy latest → baseline (accept)
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { OUT_DIR, type PerfRow, type Report } from './lib/perf-report'

const GPU_TOL = 0.15 // GPU total may rise at most +15%
const FPS_TOL = 0.15 // FPS p50 may fall at most -15%

const LATEST = resolve(OUT_DIR, 'latest.json')
const BASELINE = resolve(OUT_DIR, 'baseline.json')

function load(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report
}
function key(r: PerfRow): string {
  return `${r.scene}|${r.resolution}|${r.backend}`
}

function main(): void {
  const update = process.argv.includes('--update')
  if (!existsSync(LATEST)) {
    console.error(`no ${LATEST} — run npm run perf:gpu / perf:fps / perf:all first`)
    process.exit(1)
  }
  if (update) {
    copyFileSync(LATEST, BASELINE)
    console.log(`✓ baseline updated from latest → ${BASELINE}`)
    return
  }
  if (!existsSync(BASELINE)) {
    console.error(`no ${BASELINE} — establish one with:  npm run perf:baseline -- --update`)
    process.exit(1)
  }

  const latest = load(LATEST)
  const base = load(BASELINE)
  const baseBy = new Map<string, PerfRow>()
  for (const r of base.rows) baseBy.set(key(r), r)

  const regressions: string[] = []
  const notes: string[] = []
  for (const r of latest.rows) {
    const b = baseBy.get(key(r))
    if (!b) { notes.push(`  (new) ${key(r)} — no baseline row`); continue }

    if (r.gpuNsTotal != null && b.gpuNsTotal != null && b.gpuNsTotal > 0) {
      const delta = (r.gpuNsTotal - b.gpuNsTotal) / b.gpuNsTotal
      const line = `  GPU  ${key(r)}: ${(b.gpuNsTotal / 1000).toFixed(1)}µs → ${(r.gpuNsTotal / 1000).toFixed(1)}µs (${(delta * 100).toFixed(1)}%)`
      if (delta > GPU_TOL) regressions.push(`REGRESSION ${line} > +${GPU_TOL * 100}%`)
      else notes.push(line)
    }
    if (r.fps && b.fps && b.fps.p50 > 0) {
      const delta = (r.fps.p50 - b.fps.p50) / b.fps.p50
      const line = `  FPS  ${key(r)}: ${b.fps.p50.toFixed(0)} → ${r.fps.p50.toFixed(0)} fps (${(delta * 100).toFixed(1)}%)`
      if (delta < -FPS_TOL) regressions.push(`REGRESSION ${line} < -${FPS_TOL * 100}%`)
      else notes.push(line)
    }
  }

  console.log(`perf:baseline — latest ${latest.generatedAt} vs baseline ${base.generatedAt}`)
  if (notes.length) console.log(notes.join('\n'))
  if (regressions.length) {
    console.error('\n✗ regressions:')
    console.error(regressions.join('\n'))
    process.exit(1)
  }
  console.log('\n✓ perf:baseline — no regressions beyond tolerance')
}

main()
