/**
 * THROWAWAY verify for PerfSession (Perf View, Task 3). Boots a real headless
 * Chrome on the project's Vite dev server (same boot as
 * verify-inapp-timestamps.ts), constructs a PerfSession, and asserts live
 * measurement + subject switching + a WebGL2 fps-only path.
 *
 * Run: npx tsx scripts/perf/verify-perf-session.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

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
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    page.on('console', (m) => { if (m.type() === 'error') console.error('  [console]', m.text()) })
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__gate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>perf-session gate</title>' }))
    await page.goto(`${origin}${base}__gate.html`)

    const result = await page.evaluate(async (c) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const [nodesMod, sessionMod] = await Promise.all([
        import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
        import(/* @vite-ignore */ `${c.base}src/perf/perf-session.ts`),
      ])
      nodesMod.initializeNodeLibrary()
      const { PerfSession } = sessionMod

      const mkCanvas = () => {
        const canvas = document.createElement('canvas')
        canvas.style.display = 'block'
        document.body.appendChild(canvas)
        return canvas
      }

      // Collect N samples after a fresh (re)start of measurement.
      const collect = (s: any, n: number, timeoutMs = 6000): Promise<any[]> =>
        new Promise((res, rej) => {
          const got: any[] = []
          const to = setTimeout(() => rej(new Error(`only ${got.length}/${n} samples in ${timeoutMs}ms`)), timeoutMs)
          s.onSample((sample: any) => {
            got.push(sample)
            if (got.length >= n) { clearTimeout(to); res(got) }
          })
        })

      const out: any = {}

      // --- WebGPU scene: gaussian_r (3 passes) --------------------------------
      const canvasA = mkCanvas()
      const sessionA = new PerfSession(canvasA)
      const gaussianSamplesP = collect(sessionA, 2)
      await sessionA.start({
        subject: { kind: 'scene', sceneId: 'gaussian_r' },
        width: 1280, height: 720, dpr: 1, backend: 'webgpu',
      })
      const gaussian = await gaussianSamplesP
      out.backend = (sessionA as any).renderer?.backend
      const g = gaussian[gaussian.length - 1]
      out.gaussian = {
        fps: g.fps, passCount: g.passCount, passNs: g.passNs,
        gpuTotalNs: g.gpuTotalNs, timingMethod: g.timingMethod,
      }

      // --- subject switch → passthrough (1 pass) ------------------------------
      const passSamplesP = collect(sessionA, 2)
      sessionA.update({ subject: { kind: 'scene', sceneId: 'passthrough' } })
      const passthrough = await passSamplesP
      const p = passthrough[passthrough.length - 1]
      out.passthrough = { fps: p.fps, passCount: p.passCount, passNs: p.passNs }
      sessionA.dispose()

      // --- WebGL2 path (fps-only, timingMethod unavailable) -------------------
      const canvasB = mkCanvas()
      const sessionB = new PerfSession(canvasB)
      const glSamplesP = collect(sessionB, 2)
      await sessionB.start({
        subject: { kind: 'scene', sceneId: 'gaussian_r' },
        width: 960, height: 540, dpr: 1, backend: 'webgl2',
      })
      const gl = await glSamplesP
      out.webgl2Backend = (sessionB as any).renderer?.backend
      const w = gl[gl.length - 1]
      out.webgl2 = {
        fps: w.fps, passCount: w.passCount,
        timingMethod: w.timingMethod, passNs: w.passNs,
      }
      sessionB.dispose()

      return out
    }, { base })

    // --- report -------------------------------------------------------------
    console.log('\n  PerfSession in-app gate')
    console.log(`  WebGPU backend resolved:   ${result.backend}`)
    console.log(`  gaussian_r  fps:           ${result.gaussian.fps.toFixed(1)}`)
    console.log(`  gaussian_r  passCount:     ${result.gaussian.passCount}`)
    console.log(`  gaussian_r  timingMethod:  ${result.gaussian.timingMethod}`)
    console.log(`  gaussian_r  passNs:        ${result.gaussian.passNs ? `[${result.gaussian.passNs.join(', ')}]` : 'null'}`)
    console.log(`  gaussian_r  gpuTotalNs:    ${result.gaussian.gpuTotalNs}`)
    console.log(`  passthrough fps:           ${result.passthrough.fps.toFixed(1)}`)
    console.log(`  passthrough passCount:     ${result.passthrough.passCount}`)
    console.log(`  webgl2 backend resolved:   ${result.webgl2Backend}`)
    console.log(`  webgl2 fps:                ${result.webgl2.fps.toFixed(1)}`)
    console.log(`  webgl2 passCount:          ${result.webgl2.passCount}`)
    console.log(`  webgl2 timingMethod:       ${result.webgl2.timingMethod}`)
    console.log(`  webgl2 passNs:             ${result.webgl2.passNs ? `[${result.webgl2.passNs.join(', ')}]` : 'null'}`)

    // --- assert -------------------------------------------------------------
    const failures: string[] = []
    if (!(result.gaussian.fps > 0)) failures.push('gaussian fps must be > 0')
    if (result.gaussian.passCount !== 3) failures.push(`gaussian passCount should be 3 (got ${result.gaussian.passCount})`)

    if (result.backend === 'webgpu' && result.gaussian.timingMethod === 'timestamp-query') {
      if (!Array.isArray(result.gaussian.passNs) || result.gaussian.passNs.length !== 3) {
        failures.push(`gaussian passNs should be length-3 array (got ${JSON.stringify(result.gaussian.passNs)})`)
      } else if (!result.gaussian.passNs.every((v: number) => v > 0)) {
        failures.push(`gaussian passNs entries must all be > 0 (got [${result.gaussian.passNs.join(', ')}])`)
      }
    } else {
      console.log('\n  NOTE: WebGPU timestamp-query unavailable on this adapter — per-pass ns not asserted.')
    }

    if (!(result.passthrough.fps > 0)) failures.push('passthrough fps must be > 0')
    if (result.passthrough.passCount !== 1) failures.push(`passthrough passCount should be 1 after switch (got ${result.passthrough.passCount})`)

    if (!(result.webgl2.fps > 0)) failures.push('webgl2 fps must be > 0')
    if (result.webgl2Backend !== 'webgl2') failures.push(`webgl2 request should resolve to webgl2 backend (got ${result.webgl2Backend})`)
    if (result.webgl2.timingMethod !== 'unavailable') failures.push(`webgl2 timingMethod should be 'unavailable' (got ${result.webgl2.timingMethod})`)
    if (result.webgl2.passNs !== null) failures.push('webgl2 passNs should be null')

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
