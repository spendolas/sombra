/**
 * perf:fps — uncapped sustained wall-clock FPS via the REAL renderers, across
 * scene × resolution × backend.
 *
 *   npm run perf:fps -- --res=1080,1440,4k --backend=webgpu,webgl2 --frames=180
 *
 * Writes reports/perf/latest.json + summary.txt and prints the table. The 4K
 * assertion checks the canvas actually backed at 3840; a GPU that rejects the
 * dimension triggers an explicit-note fallback to 1080 (never a silent shrink).
 */

import { createRendererDriver, type RendererDriver } from './lib/renderer-driver'
import { SCENES, getScene, compileScene, type SceneDef } from './lib/scenes'
import { resolveResolutions, frameStats, type Backend, type Resolution } from './lib/perf-util'
import type { Assertion } from './lib/scene-assert'
import { anyFailed } from './lib/scene-assert'
import { writeReport, formatTable, formatAssertions, type PerfRow } from './lib/perf-report'

export interface FpsOptions {
  resolutions: Resolution[]
  backends: Backend[]
  scenes: SceneDef[]
  frames: number
}

export interface FpsResult {
  rows: PerfRow[]
  backends: Backend[]
}

const FALLBACK: Resolution = { key: '1080', width: 1920, height: 1080 }

export async function runFpsMatrix(driver: RendererDriver, opts: FpsOptions): Promise<FpsResult> {
  const backends = opts.backends.filter((b) => driver.available[b])
  if (backends.length === 0) {
    throw new Error(`no requested FPS backend available (wanted ${opts.backends.join(',')}, adapter has webgpu=${driver.available.webgpu} webgl2=${driver.available.webgl2})`)
  }

  const rows: PerfRow[] = []
  for (const scene of opts.scenes) {
    const graph = scene.build()
    const compiled = compileScene(graph)

    for (const be of backends) {
      for (const res of opts.resolutions) {
        let useRes = res
        let note = ''
        let run = await driver.runFps({ backend: be, width: res.width, height: res.height, nodes: graph.nodes, edges: graph.edges, frames: opts.frames })

        // 4K max-dimension rejection → explicit fallback, never a silent shrink.
        const rejected = !run.ok || run.canvasWidth !== res.width || run.canvasHeight !== res.height
        if (rejected && res.key === '4k') {
          note = ` [4K rejected (${run.ok ? `backed ${run.canvasWidth}x${run.canvasHeight}` : run.error}); FELL BACK to 1080]`
          console.warn(`  ${scene.id} ${be} @4k: ${run.ok ? `canvas backed ${run.canvasWidth}x${run.canvasHeight}, expected 3840x2160` : `error: ${run.error}`} → falling back to 1080`)
          useRes = FALLBACK
          run = await driver.runFps({ backend: be, width: FALLBACK.width, height: FALLBACK.height, nodes: graph.nodes, edges: graph.edges, frames: opts.frames })
        }
        if (!run.ok) throw new Error(`fps ${scene.id} ${be} @${useRes.key}: ${run.error}`)

        const stats = frameStats(run.frameMs)
        const assertions: Assertion[] = [
          { name: 'pass-count', ok: compiled.passCount === scene.expectedPasses, detail: `expected ${scene.expectedPasses}, got ${compiled.passCount}` },
          { name: 'render-size', ok: run.canvasWidth === useRes.width && run.canvasHeight === useRes.height, detail: `backing ${run.canvasWidth}x${run.canvasHeight}, expected ${useRes.width}x${useRes.height}${note}` },
          { name: 'fps-measured', ok: stats.samples > 0 && stats.fps > 0, detail: `${stats.fps.toFixed(0)} fps p50 over ${stats.samples} frames` },
        ]

        console.log(`  ${scene.id} @${useRes.key} ${be}: ${stats.fps.toFixed(0)} fps p50 (p95 ${(1000 / stats.frameMsP95).toFixed(0)}), frameMs p50=${stats.frameMsP50.toFixed(2)} p95=${stats.frameMsP95.toFixed(2)} backing=${run.canvasWidth}x${run.canvasHeight}${note}`)

        rows.push({
          scene: scene.id,
          resolution: useRes === res ? res.key : `${res.key}→1080`,
          backend: be,
          passCount: compiled.passCount,
          timingMethod: 'none',
          gpuNsPerPass: [],
          gpuNsTotal: null,
          outputVariance: 0,
          fps: {
            p50: stats.fps,
            p95: stats.frameMsP95 > 0 ? 1000 / stats.frameMsP95 : 0,
            frameMsP50: stats.frameMsP50,
            frameMsP95: stats.frameMsP95,
            frameMsMin: stats.frameMsMin,
            frameMsMax: stats.frameMsMax,
          },
          assertions,
        })
      }
    }
  }
  return { rows, backends }
}

// --- CLI --------------------------------------------------------------------

function get(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const resolutions = resolveResolutions(get(argv, 'res'))
  const backendSpec = get(argv, 'backend')
  const backends: Backend[] = backendSpec ? (backendSpec.split(',').map((s) => s.trim()) as Backend[]) : ['webgpu', 'webgl2']
  for (const b of backends) if (b !== 'webgpu' && b !== 'webgl2') throw new Error(`unknown backend "${b}"`)
  const sceneSpec = get(argv, 'scenes')
  const scenes = sceneSpec ? sceneSpec.split(',').map((s) => getScene(s.trim())) : SCENES
  const frames = get(argv, 'frames') ? Math.max(1, parseInt(get(argv, 'frames')!, 10)) : 180

  console.log(`perf:fps — scenes=${scenes.map((s) => s.id).join(',')} res=${resolutions.map((r) => r.key).join(',')} backend=${backends.join(',')} frames=${frames}`)
  const driver = await createRendererDriver()
  let result: FpsResult
  try {
    console.log(`  available: webgpu=${driver.available.webgpu} webgl2=${driver.available.webgl2}`)
    result = await runFpsMatrix(driver, { resolutions, backends, scenes, frames })
  } finally {
    await driver.close()
  }

  const report = {
    generatedAt: new Date().toISOString(),
    adapterInfo: 'real-renderer FPS (see perf:gpu for adapter)',
    backends: result.backends,
    rows: result.rows,
  }
  const { jsonPath, summaryPath } = writeReport(report)
  console.log(formatTable(result.rows))
  console.log(formatAssertions(result.rows))
  console.log(`\nwrote ${jsonPath}\nwrote ${summaryPath}`)

  if (anyFailed(result.rows.flatMap((r) => r.assertions))) {
    console.error('\n✗ perf:fps — one or more assertions FAILED')
    process.exit(1)
  }
  console.log('\n✓ perf:fps — all assertions green')
}

if (import.meta.filename === process.argv[1] || process.argv[1]?.endsWith('perf-fps.ts')) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
