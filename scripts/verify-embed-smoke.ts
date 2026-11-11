/**
 * verify-embed-smoke — end-to-end: the built-in dev harness must mount the
 * player, render non-blank pixels, and react to handle.set(); and the player's
 * lifecycle contract (SR-4) must hold:
 *
 *   - a failed mount is detectable on the handle: ok === false, error set,
 *     on('error') replays once, and fallback:false leaves the container empty;
 *   - a live handle reports later failures through on('error') / onError /
 *     sombra:error (a render plan that fails to re-apply on context restore —
 *     injected on the live renderer instance);
 *   - destroy() releases the WebGL2 context: 20 mount/destroy cycles leave no
 *     live contexts behind, Chrome never warns "Too many active WebGL
 *     contexts", and a 21st mount still renders. Contexts are counted through a
 *     getContext wrapper installed by the test page (live = !isContextLost()).
 *
 * Starts its own Vite dev server unless EMBED_DEV_URL points at one
 * (e.g. EMBED_DEV_URL=http://localhost:5173/embed-dev.html).
 * Run: npm run verify:embed:smoke
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`) }
}

declare global {
  var __life: {
    scene: string
    contexts: Array<{ ctx: WebGL2RenderingContext }>
    live(): number
    instances: Array<Record<string, unknown>>
    mount(opts: Record<string, unknown>, el?: HTMLElement): Promise<Record<string, unknown>>
  }
}

let server: ViteDevServer | null = null
let browser: Browser | null = null
try {
  let origin: string, base: string
  if (process.env.EMBED_DEV_URL) {
    const u = new URL(process.env.EMBED_DEV_URL)
    origin = u.origin
    base = u.pathname.replace(/embed-dev\.html$/, '')
  } else {
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1' },
    })
    await server.listen()
    const local = server.resolvedUrls?.local[0]
    if (!local) throw new Error('vite dev server did not report a local URL')
    origin = new URL(local).origin
    const p = new URL(local).pathname
    base = p.endsWith('/') ? p : `${p}/`
  }

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })

  // ── 1. Dev harness: mount, pixels, set() ──────────────────────────────────
  {
    const page = await browser.newPage()
    await page.goto(`${origin}${base}embed-dev.html`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => (window as unknown as { __embedHandle?: unknown }).__embedHandle !== undefined, undefined, { timeout: 10000 })

    // Non-blank pixels, read back in the same task as a render().
    const nonBlank = await page.evaluate(() => {
      const h = (window as unknown as { __embedHandle: { render(): void } }).__embedHandle
      const c = document.querySelector('canvas') as HTMLCanvasElement
      h.render()
      const snap = document.createElement('canvas'); snap.width = c.width; snap.height = c.height
      const ctx = snap.getContext('2d')!; ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(0, 0, Math.min(8, c.width), Math.min(8, c.height)).data
      return d.some((v, i) => i % 4 !== 3 && v !== 0)
    })
    check('canvas produced non-black pixels', nonBlank)

    const setOk = await page.evaluate(() => {
      const h = (window as unknown as {
        __embedHandle: { variables(): Array<{ key: string; max?: number }>; set(k: string, v: number): void }
      }).__embedHandle
      const keys = h.variables()
      if (!keys.length) return true // no knobs is valid for some graphs
      try { h.set(keys[0].key, keys[0].max ?? 1); return true } catch { return false }
    })
    check('handle.set() on a knob does not throw', setOk)

    const okFlag = await page.evaluate(() => {
      const h = (window as unknown as { __embedHandle: { ok: boolean; error?: Error } }).__embedHandle
      return { ok: h.ok, error: h.error === undefined }
    })
    check('a good mount has ok === true and no error', okFlag.ok && okFlag.error)
    await page.close()
  }

  // ── 2. Lifecycle, on a bare page (WebGL2 forced) ────────────────────────────
  {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
    const consoleText: string[] = []
    page.on('console', (m) => consoleText.push(m.text()))
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    await page.addInitScript({ content: `
      globalThis.__name = globalThis.__name || ((f) => f);
      // Count every WebGL2 context the page creates (installed before any script).
      globalThis.__ctxs = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = orig.call(this, type, ...rest);
        if (type === 'webgl2' && ctx && !globalThis.__ctxs.some((c) => c.ctx === ctx)) globalThis.__ctxs.push({ ctx });
        return ctx;
      };` })
    await page.route((u) => u.pathname.endsWith('/__embed-life.html'), (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>embed lifecycle</title><body style="margin:0">' }))
    // A real 404 (the Vite dev server would otherwise answer an unknown path
    // with the editor's index.html and a 200).
    await page.route((u) => u.pathname.endsWith('/__no-such-scene.ombra'), (route) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }))
    await page.goto(`${origin}${base}__embed-life.html?backend=webgl2`)

    await page.evaluate(async (b) => {
      const imp = (p: string) => import(/* @vite-ignore */ `${b}${p}`)
      const { initializeNodeLibrary } = await imp('src/nodes/index.ts')
      const { compileGraph } = await imp('src/compiler/glsl-generator.ts')
      const { buildManifest } = await imp('src/embed/manifest.ts')
      const { stripPlan, encodeArtifact } = await imp('src/embed/artifact.ts')
      const { mount } = await imp('src/embed/player.ts')
      const { createDefaultGraph } = await imp('src/utils/test-graph.ts')
      const { WebGL2ShaderRenderer } = await imp('src/webgl/renderer.ts')
      initializeNodeLibrary()
      const { nodes, edges } = createDefaultGraph()
      // 'medium' tier: DPR scale 0.75 whether animated or not, so the first-frame
      // size check below can tell a tier applied before the frame from one after.
      const out = nodes.find((n: { data: { type: string } }) => n.data.type === 'fragment_output')
      out.data.params = { ...out.data.params, quality: 'medium' }
      const plan = compileGraph(nodes, edges)   // GLSL only: this page tests WebGL2
      const scene = encodeArtifact({
        v: 1, kind: 'frozen', plan: stripPlan(plan),
        manifest: buildManifest(plan.userUniforms, nodes),
        images: [], meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
      })
      const instances: Array<Record<string, unknown>> = []
      const init = WebGL2ShaderRenderer.prototype.init
      WebGL2ShaderRenderer.prototype.init = function (this: Record<string, unknown>, c: HTMLCanvasElement) {
        instances.push(this); return init.call(this, c)
      }
      const ctxs = (globalThis as unknown as { __ctxs: Array<{ ctx: WebGL2RenderingContext }> }).__ctxs
      globalThis.__life = {
        scene, instances, contexts: ctxs,
        live: () => ctxs.filter((c) => !c.ctx.isContextLost()).length,
        async mount(opts, el) {
          const box = el ?? document.createElement('div')
          if (!el) { box.style.cssText = 'width:200px;height:150px'; document.body.appendChild(box) }
          return mount(box, { scene, ...opts })
        },
      }
    }, base)

    // 2a. Failed mount: 404 src, fallback:false.
    const fail = await page.evaluate(async () => {
      const el = document.createElement('div'); document.body.appendChild(el)
      const calls: string[] = []
      let onErrorCalls = 0, domEvents = 0
      el.addEventListener('sombra:error', () => { domEvents++ })
      const h = await globalThis.__life.mount({ scene: undefined, src: '/__no-such-scene.ombra', fallback: false, onError: () => { onErrorCalls++ } }, el) as {
        ok: boolean; error?: Error; on(ev: string, cb: (e: unknown) => void): void; destroy(): void
      }
      h.on('error', (e) => calls.push(e instanceof Error ? e.message : `not an Error: ${String(e)}`))
      h.on('load', () => calls.push('load?!'))
      const r = { ok: h.ok, error: h.error instanceof Error ? h.error.message : null, calls: [...calls], onErrorCalls, domEvents, children: el.childNodes.length }
      h.destroy(); h.destroy()
      return r
    })
    check('failed mount: handle.ok === false', fail.ok === false, JSON.stringify(fail))
    check('failed mount: handle.error is the Error', !!fail.error && /HTTP 404/.test(fail.error), String(fail.error))
    check('failed mount: on(\'error\') called once with that Error', fail.calls.length === 1 && fail.calls[0] === fail.error, JSON.stringify(fail.calls))
    check('failed mount: onError and sombra:error still fire once', fail.onErrorCalls === 1 && fail.domEvents === 1)
    check('failed mount (fallback:false): container left empty', fail.children === 0, `${fail.children} children`)

    // 2a'. Failed mount with the default fallback: destroy() removes it, twice is safe.
    const fb = await page.evaluate(async () => {
      const el = document.createElement('div'); document.body.appendChild(el)
      const h = await globalThis.__life.mount({ scene: 'not-a-scene' }, el) as { ok: boolean; destroy(): void }
      const shown = el.childNodes.length
      let threw = false
      try { h.destroy(); h.destroy() } catch { threw = true }
      return { ok: h.ok, shown, after: el.childNodes.length, threw }
    })
    check('failed mount (fallback): placeholder shown, destroy() removes it, idempotent', !fb.ok && fb.shown > 0 && fb.after === 0 && !fb.threw, JSON.stringify(fb))

    // 2b. Live handle: a failed re-apply on context restore fires 'error'.
    const live = await page.evaluate(async () => {
      const el = document.createElement('div'); el.style.cssText = 'width:200px;height:150px'; document.body.appendChild(el)
      let onErrorCalls = 0, domEvents = 0
      el.addEventListener('sombra:error', () => { domEvents++ })
      const h = await globalThis.__life.mount({ onError: () => { onErrorCalls++ } }, el) as {
        ok: boolean; on(ev: string, cb: (e: unknown) => void): void; destroy(): void
      }
      const errors: string[] = []
      h.on('error', (e) => errors.push(e instanceof Error ? e.message : String(e)))
      const before = errors.length
      const r = globalThis.__life.instances[globalThis.__life.instances.length - 1]
      r.updateRenderPlan = () => ({ success: false, error: 'injected restore failure' })
      const gl = r.gl as WebGL2RenderingContext
      const ext = gl.getExtension('WEBGL_lose_context')!
      const restored = new Promise<void>((res) => gl.canvas.addEventListener('webglcontextrestored', () => res(), { once: true }))
      ext.loseContext()
      await new Promise((res) => setTimeout(res, 100))
      ext.restoreContext()
      await restored
      await new Promise((res) => setTimeout(res, 50))
      h.destroy()
      return { ok: h.ok, before, errors, onErrorCalls, domEvents }
    })
    check('live handle: ok === true', live.ok === true)
    check('live handle: on(\'error\') does not replay on a good mount', live.before === 0)
    check('live handle: failed plan re-apply on restore fires on(\'error\')', live.errors.length === 1 && /injected restore failure/.test(live.errors[0]), JSON.stringify(live.errors))
    check('live handle: …and onError + sombra:error', live.onErrorCalls === 1 && live.domEvents === 1, JSON.stringify(live))

    // 2b'. The first frame is drawn at the quality tier's resolution. Paused
    // mount → the mount frame is the only frame, so the canvas size is its size.
    const first = await page.evaluate(async () => {
      const el = document.createElement('div'); el.style.cssText = 'width:200px;height:150px'; document.body.appendChild(el)
      const h = await globalThis.__life.mount({ autoplay: false }, el) as { destroy(): void }
      const r = globalThis.__life.instances[globalThis.__life.instances.length - 1]
      const c = el.querySelector('canvas') as HTMLCanvasElement
      const scale = r.currentDprScale as number
      const out = { w: c.width, expect: Math.floor(200 * Math.min(devicePixelRatio || 1, 2) * scale), scale }
      h.destroy()
      return out
    })
    check('first frame drawn at the tier\'s scale (medium → 0.75)', first.scale === 0.75 && first.w === first.expect, JSON.stringify(first))

    // 2c. 20× mount/destroy → no live contexts left; a 21st mount renders.
    const churn = await page.evaluate(async () => {
      const L = globalThis.__life
      const liveBefore = L.live()
      const created0 = L.contexts.length
      let backendsOk = true
      for (let i = 0; i < 20; i++) {
        const el = document.createElement('div'); el.style.cssText = 'width:120px;height:90px'; document.body.appendChild(el)
        const h = await L.mount({}, el) as { ok: boolean; destroy(): void }
        if (!h.ok) backendsOk = false
        h.destroy(); h.destroy()            // idempotent
        el.remove()
      }
      const created = L.contexts.length - created0
      const liveAfterChurn = L.live()
      const el = document.createElement('div'); el.style.cssText = 'width:120px;height:90px'; document.body.appendChild(el)
      const h = await L.mount({}, el) as { ok: boolean; render(): void }
      const r = L.instances[L.instances.length - 1]
      const c = el.querySelector('canvas') as HTMLCanvasElement
      h.render()                             // read back in the same task as the draw
      const snap = document.createElement('canvas'); snap.width = c.width; snap.height = c.height
      const ctx = snap.getContext('2d')!; ctx.drawImage(c, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let lit = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 0 && d[i + 3] > 0) lit++
      return { liveBefore, created, liveAfterChurn, backendsOk, lastOk: h.ok, backend: String(r.backend), lit, total: d.length / 4, liveEnd: L.live() }
    })
    const warned = consoleText.some((t) => /Too many active WebGL contexts/i.test(t))
    check('churn: every mount created its own WebGL2 context (counter engaged)', churn.created === 20 && churn.backendsOk, JSON.stringify(churn))
    check('churn: no live WebGL2 context left after 20 destroy()s', churn.liveAfterChurn === churn.liveBefore, JSON.stringify(churn))
    check('churn: no "Too many active WebGL contexts" warning', !warned)
    check('churn: a 21st mount renders non-blank on WebGL2', churn.lastOk && churn.backend === 'webgl2' && churn.lit > churn.total / 2, JSON.stringify(churn))
    await page.close()
  }
} finally {
  await browser?.close()
  await server?.close()
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
