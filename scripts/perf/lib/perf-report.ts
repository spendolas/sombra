/**
 * perf-report — the row schema, JSON persistence (reports/perf/latest.json),
 * and the stdout table (scene × resolution, WebGPU and WebGL2 side by side).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Assertion } from './scene-assert'
import type { Backend } from './perf-util'
import { round } from './perf-util'

export const OUT_DIR = resolve(import.meta.dirname, '../../../reports/perf')

export interface FpsBlock {
  p50: number
  p95: number
  frameMsP50: number
  frameMsP95: number
  frameMsMin: number
  frameMsMax: number
}

export interface PerfRow {
  scene: string
  resolution: string
  backend: Backend
  passCount: number
  timingMethod: 'timestamp-query' | 'wall-clock' | 'none'
  gpuNsPerPass: Array<number | null>
  gpuNsTotal: number | null
  outputVariance: number
  repeats?: number
  fps: FpsBlock | null
  assertions: Assertion[]
}

export interface Report {
  generatedAt: string
  adapterInfo: string
  backends: Backend[]
  rows: PerfRow[]
}

function usTotal(row: PerfRow): string {
  return row.gpuNsTotal == null ? '—' : (row.gpuNsTotal / 1000).toFixed(1)
}
function usWorstPass(row: PerfRow): string {
  const vals = row.gpuNsPerPass.filter((v): v is number => v != null)
  if (vals.length === 0) return '—'
  return (Math.max(...vals) / 1000).toFixed(1)
}
function fpsP50(row: PerfRow): string {
  return row.fps ? row.fps.p50.toFixed(0) : '—'
}
function fpsP95(row: PerfRow): string {
  return row.fps ? row.fps.p95.toFixed(0) : '—'
}
function methodTag(row: PerfRow): string {
  return row.timingMethod === 'timestamp-query' ? 'ts' : row.timingMethod === 'wall-clock' ? 'wc' : 'none'
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length)
}
function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s
}

/**
 * Render the scene × resolution table with both backends side by side. Columns
 * per backend: passes | total GPU µs | µs/pass(worst) | FPS p50 | FPS p95 | method.
 */
export function formatTable(rows: PerfRow[]): string {
  const scenes = [...new Set(rows.map((r) => r.scene))]
  const resolutions = [...new Set(rows.map((r) => r.resolution))]
  const backends = [...new Set(rows.map((r) => r.backend))]

  const lines: string[] = []
  // Column widths
  const W = { pass: 6, gpu: 9, worst: 9, p50: 6, p95: 6, method: 7 }
  const groupCols = (be: Backend): string =>
    [pad('pass', W.pass), pad('GPUµs', W.gpu), pad('µs/pass', W.worst), pad('FPS50', W.p50), pad('FPS95', W.p95), pad('meth', W.method)].join(' ') + `  «${be}»`

  for (const scene of scenes) {
    lines.push('')
    lines.push(`[${scene}]`)
    // header row
    const head = pad('res', 6) + ' | ' + backends.map((b) => groupCols(b)).join(' | ')
    lines.push('  ' + head)
    for (const res of resolutions) {
      const cells: string[] = [pad(res, 6)]
      for (const be of backends) {
        const row = rows.find((r) => r.scene === scene && r.resolution === res && r.backend === be)
        if (!row) {
          cells.push([pad('—', W.pass), pad('—', W.gpu), pad('—', W.worst), pad('—', W.p50), pad('—', W.p95), pad('—', W.method)].join(' ') + '     ')
          continue
        }
        cells.push([
          padL(String(row.passCount), W.pass),
          padL(usTotal(row), W.gpu),
          padL(usWorstPass(row), W.worst),
          padL(fpsP50(row), W.p50),
          padL(fpsP95(row), W.p95),
          pad(methodTag(row), W.method),
        ].join(' ') + '     ')
      }
      lines.push('  ' + cells.join(' | '))
    }
  }
  lines.push('')
  lines.push('legend: GPUµs = total GPU time all passes; µs/pass = worst single pass; meth ts=timestamp-query (WebGPU), wc=wall-clock (WebGL2, weaker); FPS = uncapped sustained.')
  return lines.join('\n')
}

/** One-line-per-scene assertion summary. */
export function formatAssertions(rows: PerfRow[]): string {
  const lines: string[] = ['', 'Assertions (mechanism-engaged):']
  for (const row of rows) {
    const tag = `${row.scene} @${row.resolution} ${row.backend}`
    for (const a of row.assertions) {
      const mark = a.ok ? '✓' : a.unmeasured ? '∅' : '✗'
      lines.push(`  ${mark} ${pad(tag, 30)} ${pad(a.name, 18)} ${a.detail}`)
    }
  }
  return lines.join('\n')
}

export function writeReport(report: Report): { jsonPath: string; summaryPath: string } {
  mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = resolve(OUT_DIR, 'latest.json')
  const summaryPath = resolve(OUT_DIR, 'summary.txt')
  // Round GPU numbers in JSON for readability but keep full precision for totals.
  const jsonRows = report.rows.map((r) => ({
    ...r,
    gpuNsPerPass: r.gpuNsPerPass.map((v) => (v == null ? null : round(v, 1))),
    gpuNsTotal: r.gpuNsTotal == null ? null : round(r.gpuNsTotal, 1),
    outputVariance: round(r.outputVariance, 6),
    fps: r.fps
      ? {
          p50: round(r.fps.p50, 1),
          p95: round(r.fps.p95, 1),
          frameMsP50: round(r.fps.frameMsP50, 3),
          frameMsP95: round(r.fps.frameMsP95, 3),
          frameMsMin: round(r.fps.frameMsMin, 3),
          frameMsMax: round(r.fps.frameMsMax, 3),
        }
      : null,
  }))
  writeFileSync(jsonPath, JSON.stringify({ ...report, rows: jsonRows }, null, 2))
  const summary = [
    `Sombra perf report — ${report.generatedAt}`,
    `adapter: ${report.adapterInfo}`,
    `backends: ${report.backends.join(', ')}`,
    formatTable(report.rows),
    formatAssertions(report.rows),
  ].join('\n')
  writeFileSync(summaryPath, summary + '\n')
  return { jsonPath, summaryPath }
}
