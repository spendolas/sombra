/**
 * Mechanism-engaged gate for the opt-in WebGPU `timestamp-query` capability
 * (Perf View Task 1). Boots a real headless Chrome on the project's own Vite
 * dev server — exactly like `scripts/verify-pass-resolution-gpu.ts` — imports
 * the SHIPPING renderer factory (`src/renderer/create-renderer.ts`), builds a
 * real multi-pass Gaussian-blur RenderPlan, and drives frames.
 *
 * Two assertions, one proving the feature works and one proving the gate:
 *   ON  — createShaderRenderer(canvas, plan, { enableTimestamps: true }):
 *         timestampsActive() === true, getPassTimingsNs() is a number[] of
 *         length === passCount with EVERY entry > 0.
 *   OFF — createShaderRenderer(canvas, plan) (flag omitted):
 *         timestampsActive() === false AND getPassTimingsNs() === null.
 *         (Default path is byte-identical — no query set is ever created.)
 *
 * If the WebGPU adapter lacks `timestamp-query`, or the backend falls back to
 * WebGL2, that is REPORTED (the feature-detect path), not failed.
 *
 * Run: npx tsx scripts/perf/verify-inapp-timestamps.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

interface Result {
  backend: string
  supported: boolean          // adapter has timestamp-query
  onActive: boolean           // timestampsActive() with flag on
  passCount: number
  timings: number[] | null    // getPassTimingsNs() with flag on
  offActive: boolean          // timestampsActive() with flag off
  offTimings: number[] | null // getPassTimingsNs() with flag off
  error?: string
}

async function main() {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null

  try {
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1' },
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite dev server did not report a local URL')
    const base = new URL(url).pathname.endsWith('/') ? new URL(url).pathname : `${new URL(url).pathname}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu'],
    })
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    page.on('console', (m) => { if (m.type() === 'error') console.error('  [console]', m.text()) })
    // tsx/esbuild keepNames wraps callbacks in __name(...); provide it in-page.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__gate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>timestamp gate</title>' }))
    await page.goto(`${origin}${base}__gate.html`)

    const result: Result = await page.evaluate(async (c) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const [nodesMod, glslMod, irMod, scenesMod, factoryMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
        import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
        import(/* @vite-ignore */ `${c.base}src/perf/scenes.ts`),
        import(/* @vite-ignore */ `${c.base}src/renderer/create-renderer.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      const { compileGraph } = glslMod
      const { compileGraphIR } = irMod
      const { buildGaussian } = scenesMod
      const { createShaderRenderer } = factoryMod

      const out: any = {
        backend: '', supported: false, onActive: false, passCount: 0,
        timings: null, offActive: false, offTimings: null,
      }

      // --- adapter feature probe (the feature-detect path) ----------------
      if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
        const adapter = await (navigator as any).gpu.requestAdapter()
        out.supported = !!adapter?.features?.has('timestamp-query')
      }

      // --- a real multi-pass Gaussian-blur plan ---------------------------
      const graph = buildGaussian()
      const plan = compileGraph(graph.nodes, graph.edges)
      if (!plan.success) throw new Error(`GLSL compile failed: ${JSON.stringify(plan.errors)}`)
      const ir = compileGraphIR(graph.nodes, graph.edges)
      if (!ir) throw new Error('IR compile returned null')
      plan.wgsl = { passes: ir.passes }
      out.passCount = ir.passes.length

      const mkCanvas = () => {
        const canvas = document.createElement('canvas')
        canvas.style.width = '256px'
        canvas.style.height = '256px'
        canvas.style.display = 'block'
        document.body.appendChild(canvas)
        return canvas
      }

      const applyPlan = (r: any) => {
        const res = r.updateRenderPlan(plan)
        if (!res.success) throw new Error(`updateRenderPlan: ${res.error}`)
        if (plan.userUniforms?.length) {
          r.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
        }
      }

      // Drive frames, awaiting GPU completion so timestamps resolve, then poll
      // the async readback until it lands (never blocks the render loop itself).
      const drive = async (r: any, frames: number) => {
        const device = r.getDevice?.()
        for (let i = 0; i < frames; i++) {
          r.render()
          if (device) await device.queue.onSubmittedWorkDone()
        }
      }
      const pollTimings = async (r: any): Promise<number[] | null> => {
        const device = r.getDevice?.()
        for (let i = 0; i < 60; i++) {
          const t = r.getPassTimingsNs?.() ?? null
          if (t) return t
          r.render()
          if (device) await device.queue.onSubmittedWorkDone()
          await new Promise((res) => setTimeout(res, 8))
        }
        return r.getPassTimingsNs?.() ?? null
      }

      // --- ON: flag enabled ------------------------------------------------
      const canvasOn = mkCanvas()
      const rOn = await createShaderRenderer(canvasOn, plan, { enableTimestamps: true })
      out.backend = rOn.backend
      rOn.setAnimated(false)
      applyPlan(rOn)
      await drive(rOn, 15)
      out.onActive = !!rOn.timestampsActive?.()
      out.timings = out.onActive ? await pollTimings(rOn) : rOn.getPassTimingsNs?.() ?? null
      rOn.dispose()

      // --- OFF: flag omitted (default path) --------------------------------
      const canvasOff = mkCanvas()
      const rOff = await createShaderRenderer(canvasOff, plan)
      rOff.setAnimated(false)
      applyPlan(rOff)
      await drive(rOff, 15)
      out.offActive = !!rOff.timestampsActive?.()
      out.offTimings = rOff.getPassTimingsNs?.() ?? null
      rOff.dispose()

      return out
    }, { base })

    // --- report + assert --------------------------------------------------
    console.log('\n  in-app timestamp-query gate')
    console.log(`  backend resolved:        ${result.backend}`)
    console.log(`  adapter has timestamp-query: ${result.supported}`)
    console.log(`  pass count:              ${result.passCount}`)
    console.log(`  ON  timestampsActive():  ${result.onActive}`)
    console.log(`  ON  getPassTimingsNs():  ${result.timings ? `[${result.timings.join(', ')}]` : 'null'}`)
    console.log(`  OFF timestampsActive():  ${result.offActive}`)
    console.log(`  OFF getPassTimingsNs():  ${result.offTimings ? `[${result.offTimings.join(', ')}]` : 'null'}`)

    const failures: string[] = []

    // The OFF (default) path must ALWAYS hold — byte-identical, no query set.
    if (result.offActive !== false) failures.push('OFF: timestampsActive() should be false')
    if (result.offTimings !== null) failures.push('OFF: getPassTimingsNs() should be null')

    if (result.backend !== 'webgpu') {
      console.log(`\n  NOTE: backend fell back to ${result.backend}; timestamp queries are WebGPU-only.`)
    } else if (!result.supported) {
      console.log('\n  NOTE: this WebGPU adapter lacks the timestamp-query feature (feature-detect path).')
      if (result.onActive !== false) failures.push('ON: timestampsActive() must be false when the adapter lacks the feature')
      if (result.timings !== null) failures.push('ON: getPassTimingsNs() must be null when the feature is unsupported')
    } else {
      // Supported + WebGPU: the feature must actually produce timings.
      if (result.onActive !== true) failures.push('ON: timestampsActive() should be true')
      if (!Array.isArray(result.timings)) {
        failures.push('ON: getPassTimingsNs() should be a number[]')
      } else {
        if (result.timings.length !== result.passCount) {
          failures.push(`ON: timings length ${result.timings.length} !== passCount ${result.passCount}`)
        }
        if (!result.timings.every((v) => v > 0)) {
          failures.push(`ON: every per-pass duration must be > 0 (got [${result.timings.join(', ')}])`)
        }
      }
    }

    if (failures.length) {
      console.error('\n  FAIL')
      for (const f of failures) console.error(`   - ${f}`)
      process.exitCode = 1
    } else {
      console.log('\n  PASS')
    }
  } catch (err) {
    console.error('\n  FAIL (setup):', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  } finally {
    await browser?.close()
    await server?.close()
  }
}

void main()
