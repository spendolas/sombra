/**
 * perf:all — run BOTH metrics (standalone GPU rig + real-renderer FPS) and print
 * one combined scene × resolution × backend table, WebGPU and WebGL2 side by
 * side. Writes reports/perf/latest.json + summary.txt.
 *
 *   npm run perf:all -- --res=1080,4k --backend=webgpu,webgl2 --scenes=gaussian_r --frames=120 --json
 */

import { createPerfRig } from './lib/perf-rig'
import { createRendererDriver } from './lib/renderer-driver'
import { runGpu } from './perf-gpu'
import { runFpsMatrix } from './perf-fps'
import { SCENES, getScene, type SceneDef } from './lib/scenes'
import { resolveResolutions, type Backend, type Resolution } from './lib/perf-util'
import { anyFailed } from './lib/scene-assert'
import { writeReport, formatTable, formatAssertions, type PerfRow } from './lib/perf-report'

function get(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

interface Args {
  resolutions: Resolution[]
  backends: Backend[]
  scenes: SceneDef[]
  frames: number
  json: boolean
}

function parse(argv: string[]): Args {
  const resolutions = resolveResolutions(get(argv, 'res'))
  const backendSpec = get(argv, 'backend')
  const backends: Backend[] = backendSpec ? (backendSpec.split(',').map((s) => s.trim()) as Backend[]) : ['webgpu', 'webgl2']
  for (const b of backends) if (b !== 'webgpu' && b !== 'webgl2') throw new Error(`unknown backend "${b}"`)
  const sceneSpec = get(argv, 'scenes')
  const scenes = sceneSpec ? sceneSpec.split(',').map((s) => getScene(s.trim())) : SCENES
  const frames = get(argv, 'frames') ? Math.max(1, parseInt(get(argv, 'frames')!, 10)) : 180
  const json = argv.includes('--json')
  return { resolutions, backends, scenes, frames, json }
}

/** Merge fps rows into the matching gpu rows (tolerating the 4k→1080 fallback key). */
function merge(gpuRows: PerfRow[], fpsRows: PerfRow[]): PerfRow[] {
  const baseKey = (res: string): string => res.replace(/→.*$/, '')
  const fpsBy = new Map<string, PerfRow>()
  for (const f of fpsRows) fpsBy.set(`${f.scene}|${f.backend}|${baseKey(f.resolution)}`, f)

  const merged: PerfRow[] = []
  const usedFps = new Set<string>()
  for (const g of gpuRows) {
    const k = `${g.scene}|${g.backend}|${baseKey(g.resolution)}`
    const f = fpsBy.get(k)
    if (f) {
      usedFps.add(k)
      merged.push({
        ...g,
        // Keep the fallback annotation if the FPS run fell back.
        resolution: f.resolution.includes('→') ? f.resolution : g.resolution,
        fps: f.fps,
        assertions: [...g.assertions, ...f.assertions.filter((a) => a.name !== 'pass-count')],
      })
    } else {
      merged.push(g)
    }
  }
  // Any fps rows with no gpu counterpart (e.g. gpu backend unavailable).
  for (const f of fpsRows) {
    const k = `${f.scene}|${f.backend}|${baseKey(f.resolution)}`
    if (!usedFps.has(k)) merged.push(f)
  }
  return merged
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2))
  console.log(`perf:all — scenes=${args.scenes.map((s) => s.id).join(',')} res=${args.resolutions.map((r) => r.key).join(',')} backend=${args.backends.join(',')} frames=${args.frames}`)

  // --- GPU metric (standalone rig) ---
  console.log('\n[1/2] GPU per-pass timing (standalone rig)')
  const rig = await createPerfRig()
  let gpu
  try {
    console.log(`  adapter: ${rig.adapterInfo}  (timestamp-query: ${rig.hasTimestamp})`)
    gpu = await runGpu(rig, { resolutions: args.resolutions, backends: args.backends, scenes: args.scenes })
  } finally {
    await rig.close()
  }

  // --- FPS metric (real renderers) ---
  console.log('\n[2/2] Uncapped FPS (real renderers)')
  const driver = await createRendererDriver()
  let fps
  try {
    console.log(`  available: webgpu=${driver.available.webgpu} webgl2=${driver.available.webgl2}`)
    fps = await runFpsMatrix(driver, { resolutions: args.resolutions, backends: args.backends, scenes: args.scenes, frames: args.frames })
  } finally {
    await driver.close()
  }

  const rows = merge(gpu.rows, fps.rows)
  const report = {
    generatedAt: new Date().toISOString(),
    adapterInfo: gpu.adapterInfo,
    backends: [...new Set([...gpu.backends, ...fps.backends])],
    rows,
  }
  const { jsonPath, summaryPath } = writeReport(report)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatTable(rows))
    console.log(formatAssertions(rows))
  }
  console.log(`\nwrote ${jsonPath}\nwrote ${summaryPath}`)

  if (anyFailed(rows.flatMap((r) => r.assertions))) {
    console.error('\n✗ perf:all — one or more mechanism-engaged assertions FAILED')
    process.exit(1)
  }
  console.log('\n✓ perf:all — all mechanism-engaged assertions green')
}

main().catch((e) => { console.error(e); process.exit(1) })
