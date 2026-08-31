/**
 * perf:gpu — per-pass GPU time across scene × resolution × backend, via the
 * standalone instrumented rig (WebGPU timestamp-query; WebGL2 wall-clock).
 *
 *   npm run perf:gpu -- --res=1080,4k --backend=webgpu --scenes=gaussian_r,chain_heavy
 *
 * Writes reports/perf/latest.json + summary.txt and prints the table. Exits
 * non-zero if any mechanism-engaged assertion is a hard failure.
 */

import { createPerfRig, type PerfRig } from './lib/perf-rig'
import { SCENES, getScene, compileScene, type SceneDef } from './lib/scenes'
import { resolveResolutions, frameVariance, type Backend, type Resolution } from './lib/perf-util'
import {
  assertPassCount, assertTiming, assertNonDegenerate, assertMonotonicity, anyFailed,
} from './lib/scene-assert'
import { writeReport, formatTable, formatAssertions, type PerfRow } from './lib/perf-report'

export interface GpuOptions {
  resolutions: Resolution[]
  backends: Backend[]
  scenes: SceneDef[]
}

export interface GpuResult {
  rows: PerfRow[]
  adapterInfo: string
  backends: Backend[]
}

/**
 * Measure GPU per-pass timings for the given matrix. `rig` may be shared with a
 * caller (perf-all) so the browser boots once.
 */
export async function runGpu(rig: PerfRig, opts: GpuOptions): Promise<GpuResult> {
  const backends = opts.backends.filter((b) => rig.available[b])
  if (backends.length === 0) {
    throw new Error(`no requested GPU backend available (wanted ${opts.backends.join(',')}, adapter has webgpu=${rig.available.webgpu} webgl2=${rig.available.webgl2})`)
  }

  const rows: PerfRow[] = []
  for (const scene of opts.scenes) {
    const heavy = compileScene(scene.build())
    const cheap = scene.cheap ? compileScene(scene.cheap()) : null

    for (const be of backends) {
      for (const res of opts.resolutions) {
        const r = await rig.run({ backend: be, width: res.width, height: res.height, dpr: 1, frameScale: 1, passes: heavy.passes })
        const variance = frameVariance(r.image)

        // Cheap variant at the same res/backend for the monotonicity probe.
        let cheapTotal: number | null = null
        if (cheap) {
          const rc = await rig.run({ backend: be, width: res.width, height: res.height, dpr: 1, frameScale: 1, passes: cheap.passes })
          cheapTotal = rc.gpuNsTotal
        }

        const assertions = [
          assertPassCount(scene.expectedPasses, heavy.passCount),
          assertTiming(be, r.timingMethod, r.gpuNsTotal),
          assertNonDegenerate(variance),
        ]
        if (cheap) assertions.push(assertMonotonicity(r.gpuNsTotal, cheapTotal, be === 'webgpu'))

        const label = `${scene.id} @${res.key} ${be}`
        console.log(`  ${label}: passes=${heavy.passCount} total=${r.gpuNsTotal == null ? '—' : (r.gpuNsTotal / 1000).toFixed(1) + 'µs'} method=${r.timingMethod} reps=${r.repeats} var=${variance.toExponential(2)}${cheap ? ` cheap=${cheapTotal == null ? '—' : (cheapTotal / 1000).toFixed(1) + 'µs'}` : ''}`)

        rows.push({
          scene: scene.id,
          resolution: res.key,
          backend: be,
          passCount: heavy.passCount,
          timingMethod: r.timingMethod,
          gpuNsPerPass: r.gpuNsPerPass,
          gpuNsTotal: r.gpuNsTotal,
          outputVariance: variance,
          repeats: r.repeats,
          fps: null,
          assertions,
        })
      }
    }
  }
  return { rows, adapterInfo: rig.adapterInfo, backends }
}

// --- CLI --------------------------------------------------------------------

export interface ParsedArgs {
  resolutions: Resolution[]
  backends: Backend[]
  scenes: SceneDef[]
  frames: number
  json: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : undefined
  }
  const resolutions = resolveResolutions(get('res'))
  const backendSpec = get('backend')
  const backends: Backend[] = backendSpec
    ? (backendSpec.split(',').map((s) => s.trim()) as Backend[])
    : ['webgpu', 'webgl2']
  for (const b of backends) {
    if (b !== 'webgpu' && b !== 'webgl2') throw new Error(`unknown backend "${b}" (webgpu|webgl2)`)
  }
  const sceneSpec = get('scenes')
  const scenes = sceneSpec ? sceneSpec.split(',').map((s) => getScene(s.trim())) : SCENES
  const frames = get('frames') ? Math.max(1, parseInt(get('frames')!, 10)) : 180
  const json = argv.includes('--json')
  return { resolutions, backends, scenes, frames, json }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`perf:gpu — scenes=${args.scenes.map((s) => s.id).join(',')} res=${args.resolutions.map((r) => r.key).join(',')} backend=${args.backends.join(',')}`)
  const rig = await createPerfRig()
  let result: GpuResult
  try {
    console.log(`  adapter: ${rig.adapterInfo}  (timestamp-query: ${rig.hasTimestamp})`)
    result = await runGpu(rig, args)
  } finally {
    await rig.close()
  }

  const report = {
    generatedAt: new Date().toISOString(),
    adapterInfo: result.adapterInfo,
    backends: result.backends,
    rows: result.rows,
  }
  const { jsonPath, summaryPath } = writeReport(report)
  console.log(formatTable(result.rows))
  console.log(formatAssertions(result.rows))
  console.log(`\nwrote ${jsonPath}\nwrote ${summaryPath}`)

  if (anyFailed(result.rows.flatMap((r) => r.assertions))) {
    console.error('\n✗ perf:gpu — one or more mechanism-engaged assertions FAILED')
    process.exit(1)
  }
  console.log('\n✓ perf:gpu — all mechanism-engaged assertions green')
}

// Run only as a CLI, not when imported by perf-all.
if (import.meta.filename === process.argv[1] || process.argv[1]?.endsWith('perf-gpu.ts')) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
