/**
 * verify-embed-clock — the embed player's clock and play/pause contract (SR-3),
 * on BOTH backends, in a real browser.
 *
 * What it pins:
 *   - play(); play(); pause() actually stops drawing. The renderer's
 *     startAnimation() used to stack a second rAF chain on a second call, and
 *     stopAnimation() cancelled only the latest — so pause() stopped nothing.
 *   - u_time comes from the player's clock (starts at 0, holds while the loop is
 *     stopped). A held clock is proven on PIXELS: the scene is noise driven by
 *     Time, so the same frame drawn 2 s apart is identical only if u_time held.
 *     The scene is first shown to change over time, so that equality cannot pass
 *     on a static image.
 *   - While the loop is stopped, set()/setTime()/resize()/container resize each
 *     draw exactly one frame (coalesced), also under prefers-reduced-motion.
 *   - setTimeScale(0) holds time while frames keep being drawn.
 *   - play() respects the visibility gate; a WebGL2 context restore does not
 *     restart a paused loop.
 *
 * Frame counts come from the renderer's own getFrameCount() (frames actually
 * drawn). The page instruments the renderer classes it loads from the dev
 * server — the same module instances the player imports — to grab the live
 * instance and read the centre pixels back IN THE SAME TASK as each render()
 * (a WebGL2 drawing buffer is undefined after the task; WebGPU's current
 * texture expires with it).
 *
 * Self-contained: starts its own Vite dev server and headless Chrome.
 * Run: npm run verify:embed:clock
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

type Px = number[]
interface MountInfo { bare: boolean; backend: string; instances: number; hasTimeSource: boolean; firstTime: number | null; colorKeys: string[] }

declare global {
  var __clk: {
    mount(opts: Record<string, unknown>): Promise<MountInfo>
    frames(): number
    px(): Px
    renderNow(): Px
    playing(): boolean
    time(): number
    h: Record<string, (...a: unknown[]) => unknown>
    el: HTMLElement
    r: Record<string, unknown>
    canvasSize(): { w: number; h: number; expectW: number; expectH: number }
    sleep(ms: number): Promise<void>
  }
}

async function installHarness(page: Page, base: string): Promise<void> {
  await page.evaluate(async (b) => {
    const imp = (p: string) => import(/* @vite-ignore */ `${b}${p}`)
    const { initializeNodeLibrary } = await imp('src/nodes/index.ts')
    const { compileGraph } = await imp('src/compiler/glsl-generator.ts')
    const { compileGraphIR, toPlanWgsl } = await imp('src/compiler/ir-compiler.ts')
    const { buildManifest } = await imp('src/embed/manifest.ts')
    const { stripPlan, encodeArtifact } = await imp('src/embed/artifact.ts')
    const { mount } = await imp('src/embed/player.ts')
    const { WebGL2ShaderRenderer } = await imp('src/webgl/renderer.ts')
    const { WebGPUShaderRenderer } = await imp('src/webgpu/renderer.ts')
    initializeNodeLibrary()

    // Time → Noise.phase → Mix.factor; two Color knobs → Mix A/B → Output.
    // Quality 'high' pins the DPR scale to 1 so the canvas size is predictable.
    const n = (id: string, type: string, params: Record<string, unknown> = {}) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const e = (id: string, s: string, sp: string, t: string, tp: string, ty: string) =>
      ({ id, source: s, target: t, sourceHandle: sp, targetHandle: tp, type: 'typed', data: { sourcePort: sp, targetPort: tp, sourcePortType: ty } })
    const nodes = [
      n('time', 'time', { speed: 1 }),
      n('noise', 'noise', { noiseType: 'simplex' }),
      n('ca', 'color_constant', { color: [1, 0, 1, 1] }),
      n('cb', 'color_constant', { color: [1, 0, 1, 1] }),
      n('mix', 'mix', { factor: 0.5 }),
      n('out', 'fragment_output', { quality: 'high' }),
    ]
    const edges = [
      e('e1', 'time', 'time', 'noise', 'phase', 'float'),
      e('e2', 'noise', 'value', 'mix', 'factor', 'float'),
      e('e3', 'ca', 'color', 'mix', 'a', 'color'),
      e('e4', 'cb', 'color', 'mix', 'b', 'color'),
      e('e5', 'mix', 'result', 'out', 'color', 'color'),
    ]
    const plan = compileGraph(nodes, edges)
    if (!plan.success) throw new Error('fixture failed to compile: ' + plan.error)
    if (!plan.isTimeLiveAtOutput) throw new Error('fixture is not time-live')
    if (navigator.gpu) {
      const w = compileGraphIR(nodes, edges)
      if (w) plan.wgsl = toPlanWgsl(w)
    }
    const scene = encodeArtifact({
      v: 1, kind: 'frozen', plan: stripPlan(plan),
      manifest: buildManifest(plan.userUniforms, nodes),
      images: [], meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
    })

    // Instrument the classes the player will instantiate (same module URLs).
    const instances: Array<Record<string, unknown>> = []
    const snap = document.createElement('canvas'); snap.width = 4; snap.height = 4
    const sctx = snap.getContext('2d', { willReadFrequently: true })!
    sctx.imageSmoothingEnabled = false
    for (const C of [WebGL2ShaderRenderer, WebGPUShaderRenderer]) {
      const init = C.prototype.init
      C.prototype.init = function (this: Record<string, unknown>, c: HTMLCanvasElement) {
        instances.push(this)
        return init.call(this, c)
      }
      const render = C.prototype.render
      C.prototype.render = function (this: Record<string, unknown>) {
        if (this.__firstTime === undefined) {
          const ts = this.timeSource as (() => number) | null
          this.__firstTime = ts ? ts() : null     // not running at mount → no side effect
        }
        render.call(this)
        const c = this.canvas as HTMLCanvasElement
        if (c && c.width > 0 && c.height > 0) {
          sctx.clearRect(0, 0, 4, 4)
          sctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 4, 4)   // same task as the draw
          this.__px = Array.from(sctx.getImageData(0, 0, 4, 4).data)
        }
      }
    }

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    globalThis.__clk = {
      sleep,
      h: {}, el: document.body, r: {},
      async mount(opts) {
        const el = document.createElement('div')
        el.style.cssText = 'width:320px;height:240px;position:relative'
        document.body.appendChild(el)
        const before = instances.length
        const h = await mount(el, { scene, ...opts })
        this.h = h; this.el = el
        this.r = instances[instances.length - 1]
        const colorKeys = (h.variables() as Array<{ key: string; nodeType: string }>)
          .filter((k) => k.nodeType === 'color_constant').map((k) => k.key)
        return {
          bare: !('__sombra' in window),   // the editor app did not boot in this page
          backend: String(this.r?.backend),
          instances: instances.length - before,
          hasTimeSource: typeof this.r?.timeSource === 'function',
          firstTime: (this.r?.__firstTime ?? null) as number | null,
          colorKeys,
        }
      },
      frames() { return (this.r.getFrameCount as () => number).call(this.r) },
      px() { return (this.r.__px as Px) ?? [] },
      renderNow() { this.h.render(); return this.px() },
      playing() { return this.h.isPlaying() as boolean },
      time() { return this.h.getTime() as number },
      canvasSize() {
        const c = this.r.canvas as HTMLCanvasElement
        const s = Math.min(devicePixelRatio || 1, 2) * (this.r.currentDprScale as number)
        return { w: c.width, h: c.height, expectW: Math.floor(c.clientWidth * s), expectH: Math.floor(c.clientHeight * s) }
      },
    }
  }, base)
}

const RED = [1, 0, 0, 1], GREEN = [0, 1, 0, 1], BLACK = [0, 0, 0, 1], WHITE = [1, 1, 1, 1]
const isColor = (px: Px, rgb: number[]) => px.length === 64 &&
  px.every((v, i) => (i % 4 === 3 ? v === 255 : Math.abs(v - rgb[i % 4] * 255) <= 2))
const same = (a: Px, b: Px) => a.length > 0 && a.length === b.length && a.every((v, i) => v === b[i])

async function waitFor(page: Page, fn: string, ms = 3000): Promise<boolean> {
  try { await page.waitForFunction(fn, undefined, { timeout: ms }); return true } catch { return false }
}

async function newPage(browser: Browser, url: string, reduced: boolean, base: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error('  [page error]', e.message))
  await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
  // Match on the path: a glob would miss `?backend=webgl2` and let Vite serve the
  // whole editor app instead.
  await page.route((u) => u.pathname.endsWith('/__embed-clock.html'), (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>embed clock gate</title><body style="margin:0">' }))
  await page.goto(url)
  await installHarness(page, base)
  return page
}

async function runBackend(browser: Browser, origin: string, base: string, backend: 'webgl2' | 'webgpu') {
  const qs = backend === 'webgl2' ? '?backend=webgl2' : ''
  const url = `${origin}${base}__embed-clock.html${qs}`
  console.log(`\n[${backend}]`)

  // ── Normal motion ───────────────────────────────────────────────────────────
  {
    const page = await newPage(browser, url, false, base)
    const info = await page.evaluate(() => globalThis.__clk.mount({}))
    check(`${backend}: page is the bare fixture, not the editor`, info.bare)
    check(`${backend}: renderer backend is ${backend}`, info.backend === backend, `got ${info.backend}`)
    check(`${backend}: instrumentation caught exactly one renderer`, info.instances === 1, `got ${info.instances}`)
    check(`${backend}: player installed a time source on the renderer`, info.hasTimeSource)
    check(`${backend}: first frame drawn at u_time = 0`, info.firstTime === 0, `got ${info.firstTime}`)
    check(`${backend}: fixture exposes two colour knobs`, info.colorKeys.length === 2, JSON.stringify(info.colorKeys))
    const [ka, kb] = info.colorKeys
    await page.evaluate(([a, b, c1, c2]) => { globalThis.__clk.h.set(a, c1); globalThis.__clk.h.set(b, c2) }, [ka, kb, BLACK, WHITE] as const)

    const looping = await waitFor(page, 'globalThis.__clk.playing() && globalThis.__clk.frames() > 5')
    check(`${backend}: autoplay starts the loop once in view`, looping)

    // The scene really changes over time (otherwise the hold checks are vacuous).
    const varies = await page.evaluate(async () => {
      const k = globalThis.__clk
      const a = k.px(); await k.sleep(500); const b = k.px()
      return { a, b }
    })
    check(`${backend}: scene pixels change over time while playing`, varies.a.length === 64 && !same(varies.a, varies.b))

    // play(); play(); pause() → drawing stops.
    const dbl = await page.evaluate(async () => {
      const k = globalThis.__clk
      k.h.play(); k.h.play(); k.h.pause()
      const f0 = k.frames()
      await k.sleep(500)
      return { d: k.frames() - f0, playing: k.playing() }
    })
    check(`${backend}: play(); play(); pause() stops drawing within 2 frames`, dbl.d <= 2, `drew ${dbl.d} frames after pause`)
    check(`${backend}: isPlaying() false after pause`, !dbl.playing)

    // pause → time and pixels hold for 2 s; play → time continuous.
    const hold = await page.evaluate(async () => {
      const k = globalThis.__clk
      const t0 = k.time(); const p0 = k.renderNow()
      await k.sleep(2000)
      const t1 = k.time(); const p1 = k.renderNow()
      k.h.play()
      const t2 = k.time()
      await k.sleep(400)
      return { t0, t1, t2, t3: k.time(), p0, p1, playing: k.playing() }
    })
    check(`${backend}: getTime() holds while paused`, hold.t1 === hold.t0, `${hold.t0} → ${hold.t1}`)
    check(`${backend}: u_time held — same frame 2 s later`, same(hold.p0, hold.p1))
    check(`${backend}: resume is continuous (|Δt| ≤ 0.1 s)`, Math.abs(hold.t2 - hold.t0) <= 0.1, `${hold.t0} → ${hold.t2}`)
    check(`${backend}: clock advances again after play()`, hold.playing && hold.t3 > hold.t2 + 0.1, `${hold.t2} → ${hold.t3}`)

    // set() while paused → exactly one frame, new pixels.
    const setP = await page.evaluate(async ([a, b, red, green]) => {
      const k = globalThis.__clk
      k.h.pause(); await k.sleep(200)
      const f0 = k.frames()
      k.h.set(a, red); k.h.set(b, red)               // two sets, one task → one frame
      await k.sleep(300)
      const f1 = k.frames(); const p1 = k.px()
      k.h.set(a, green); k.h.set(b, green)
      await k.sleep(300)
      return { f0, f1, f2: k.frames(), p1, p2: k.px() }
    }, [ka, kb, RED, GREEN] as const)
    check(`${backend}: set() while paused draws exactly one frame`, setP.f1 === setP.f0 + 1, `${setP.f0} → ${setP.f1}`)
    check(`${backend}: that frame shows the new colour`, isColor(setP.p1, RED), JSON.stringify(setP.p1.slice(0, 4)))
    check(`${backend}: a second set() repaints again`, setP.f2 === setP.f1 + 1 && isColor(setP.p2, GREEN))
    await page.evaluate(([a, b, c1, c2]) => { globalThis.__clk.h.set(a, c1); globalThis.__clk.h.set(b, c2) }, [ka, kb, BLACK, WHITE] as const)

    // resize while paused: container resize (harness) and handle.resize().
    const rs = await page.evaluate(async () => {
      const k = globalThis.__clk
      await k.sleep(200)
      const f0 = k.frames()
      k.el.style.width = '200px'; k.el.style.height = '150px'
      await k.sleep(400)
      const s = k.canvasSize(); const f1 = k.frames()
      k.h.resize()
      await k.sleep(300)
      return { f0, f1, f2: k.frames(), s }
    })
    check(`${backend}: container resize while paused repaints`, rs.f1 > rs.f0, `${rs.f0} → ${rs.f1}`)
    check(`${backend}: canvas backing size follows the container`, rs.s.w === rs.s.expectW && rs.s.h === rs.s.expectH && rs.s.w > 0,
      JSON.stringify(rs.s))
    check(`${backend}: handle.resize() while paused draws one frame`, rs.f2 === rs.f1 + 1, `${rs.f1} → ${rs.f2}`)

    // setTime() while paused → jumps, one frame.
    const st = await page.evaluate(async () => {
      const k = globalThis.__clk
      const f0 = k.frames()
      k.h.setTime(10)
      await k.sleep(300)
      return { f0, f1: k.frames(), t: k.time() }
    })
    check(`${backend}: setTime() while paused jumps and draws one frame`, st.t === 10 && st.f1 === st.f0 + 1, JSON.stringify(st))

    // setTimeScale(0) → time constant while frames rise.
    const ts = await page.evaluate(async () => {
      const k = globalThis.__clk
      k.h.play(); await k.sleep(300)
      k.h.setTimeScale(0)
      const t0 = k.time(); const f0 = k.frames()
      await k.sleep(500)
      const t1 = k.time(); const f1 = k.frames()
      k.h.setTimeScale(1); await k.sleep(300)
      return { t0, t1, df: f1 - f0, t2: k.time(), scale: k.h.getTimeScale() }
    })
    check(`${backend}: setTimeScale(0) holds time`, ts.t1 === ts.t0, `${ts.t0} → ${ts.t1}`)
    check(`${backend}: …while the loop keeps painting`, ts.df >= 5, `${ts.df} frames`)
    check(`${backend}: setTimeScale(1) resumes the clock`, ts.t2 > ts.t1 && ts.scale === 1)

    // play() respects the visibility gate.
    const gate = await page.evaluate(async () => {
      const k = globalThis.__clk
      k.h.pause()
      k.el.style.position = 'fixed'; k.el.style.top = '-5000px'
      await k.sleep(400)
      k.h.play()
      const offscreen = k.playing()
      const f0 = k.frames(); await k.sleep(300); const df = k.frames() - f0
      k.el.style.position = 'relative'; k.el.style.top = '0'
      await k.sleep(500)
      return { offscreen, df, back: k.playing() }
    })
    check(`${backend}: play() while off-screen does not start the loop`, !gate.offscreen && gate.df === 0, JSON.stringify(gate))
    check(`${backend}: …and the loop starts once back in view`, gate.back)

    // WebGL2: a context restore must not restart a paused loop (and must
    // resume a playing one).
    if (backend === 'webgl2') {
      const cr = await page.evaluate(async () => {
        const k = globalThis.__clk
        const gl = k.r.gl as WebGL2RenderingContext
        const ext = gl.getExtension('WEBGL_lose_context')!
        const lost = new Promise<void>((r) => gl.canvas.addEventListener('webglcontextrestored', () => r(), { once: true }))
        k.h.pause(); await k.sleep(200)
        ext.loseContext(); await k.sleep(100); ext.restoreContext(); await lost
        await k.sleep(100)
        const f0 = k.frames(); await k.sleep(400)
        const paused = { df: k.frames() - f0, playing: k.playing() }
        const lost2 = new Promise<void>((r) => gl.canvas.addEventListener('webglcontextrestored', () => r(), { once: true }))
        k.h.play(); await k.sleep(200)
        ext.loseContext(); await k.sleep(100); ext.restoreContext(); await lost2
        await k.sleep(100)
        const f1 = k.frames(); await k.sleep(400)
        return { paused, playing: { df: k.frames() - f1, playing: k.playing() } }
      })
      check(`webgl2: context restore keeps a paused loop stopped`, cr.paused.df === 0 && !cr.paused.playing, JSON.stringify(cr.paused))
      check(`webgl2: context restore resumes a playing loop`, cr.playing.df >= 5 && cr.playing.playing, JSON.stringify(cr.playing))
    }

    const dead = await page.evaluate(async () => {
      const k = globalThis.__clk
      k.h.play(); await k.sleep(200)
      k.h.destroy()
      const f0 = k.frames(); await k.sleep(300)
      return k.frames() - f0
    })
    check(`${backend}: destroy() stops drawing`, dead === 0, `${dead} frames after destroy`)
    await page.context().close()
  }

  // ── prefers-reduced-motion ───────────────────────────────────────────────────
  {
    const page = await newPage(browser, url, true, base)
    const info = await page.evaluate(() => globalThis.__clk.mount({}))
    const [ka, kb] = info.colorKeys
    const rm = await page.evaluate(async ([a, b, red]) => {
      const k = globalThis.__clk
      await k.sleep(600)
      const f0 = k.frames(); const playing0 = k.playing()
      k.h.set(a, red); k.h.set(b, red)
      await k.sleep(300)
      const f1 = k.frames(); const p1 = k.px()
      k.h.play(); await k.sleep(300)
      const playing1 = k.playing(); const f2 = k.frames()
      k.el.style.width = '160px'
      await k.sleep(400)
      return { f0, playing0, f1, p1, playing1, f2, f3: k.frames(), s: k.canvasSize() }
    }, [ka, kb, RED] as const)
    check(`${backend} reduced-motion: exactly one frame after mount`, rm.f0 === 1, `got ${rm.f0}`)
    check(`${backend} reduced-motion: no loop`, !rm.playing0)
    check(`${backend} reduced-motion: set() repaints once with the new colour`, rm.f1 === 2 && isColor(rm.p1, RED), `frames ${rm.f1}`)
    check(`${backend} reduced-motion: play() keeps respecting the preference`, !rm.playing1 && rm.f2 === rm.f1)
    check(`${backend} reduced-motion: container resize repaints at the new size`, rm.f3 > rm.f2 && rm.s.w === rm.s.expectW, JSON.stringify(rm.s))

    const ign = await page.evaluate(async () => {
      const k = globalThis.__clk
      await k.mount({ reducedMotion: 'ignore' })
      await k.sleep(600)
      return { playing: k.playing(), frames: k.frames() }
    })
    check(`${backend} reduced-motion: reducedMotion:'ignore' runs the loop`, ign.playing && ign.frames > 5, JSON.stringify(ign))
    await page.context().close()
  }
}

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
  const local = server.resolvedUrls?.local[0]
  if (!local) throw new Error('vite dev server did not report a local URL')
  const p = new URL(local).pathname
  const base = p.endsWith('/') ? p : `${p}/`
  const origin = new URL(local).origin

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
  await runBackend(browser, origin, base, 'webgl2')
  await runBackend(browser, origin, base, 'webgpu')
} finally {
  await browser?.close()
  await server?.close()
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
