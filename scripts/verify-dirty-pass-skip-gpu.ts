/**
 * Is WebGL2's clean-pass skip still SOUND now that passes share textures?
 *
 * The WebGL2 renderer re-renders only passes marked dirty. That was safe while
 * every pass owned a texture: `fboPool[i]` could only ever hold pass i's output.
 * Slot reuse breaks the premise — a slot ends the frame holding its LAST
 * writer's output, so a skipped earlier writer's image is simply gone and its
 * consumer samples someone else's picture from the previous frame. No error,
 * `success: true`, a plausible wrong image.
 *
 * Two fixtures:
 *   CHAIN   gradient → 4× pixelate → Fragment Output. Five passes, slots
 *           [0, 1, 0, 1, -1], two physical textures. Passes 0 and 3 share slot
 *           0; passes 1 and 2 share slot 1. Two stacked effects is all it takes.
 *   BRANCH  two gradients → Mix → Fragment Output. Three passes, slots
 *           [0, 1, -1]: both branch outputs stay alive to the end, so neither
 *           slot is ever reused and both passes have a single writer.
 *
 * The test is a TWO-FRAME render with a PARTIAL dirty set — the only shape that
 * can see this at all, since frame 1 renders everything and a pure-compiler gate
 * never runs a renderer:
 *
 *   frame 1  render everything
 *   change one pass's uniform  (dirties that pass and everything downstream)
 *   frame 2  render — with the partial dirty set, or with every pass forced dirty
 *
 * Those two frame-2 images must be BYTE-IDENTICAL. "Render everything" is the
 * definition of correct here, so any difference is the skip dropping something
 * it had no right to drop. Compared as a SHA-256 of the full-size RGBA buffer:
 * a stale WebGL2 binding draws a convincing wrong image, and a sum or a
 * downsample would wave it through.
 *
 * MECHANISM-ENGAGED, four ways — an identity check passes perfectly when the
 * thing under test never ran:
 *   1. the CHAIN fixture really shares slots and the BRANCH one really does not
 *      (both asserted from the compiled plan's own targetSlots);
 *   2. the uniform change really moved the image (frame 1 ≠ frame 2);
 *   3. the skip is really still ON (scenario C's partial frame 2 issues FEWER
 *      draw calls than the plan has passes, and so fewer than its own forced
 *      reference — otherwise "identical" would only mean the optimisation had
 *      been deleted rather than narrowed);
 *   4. each scenario's draw count is asserted exactly, so a rule that quietly
 *      renders more or less than intended cannot pass.
 *
 * Three scenarios, chosen for what each proves:
 *   A  CHAIN, dirty the FIRST pixelate (pass 1). Pass 0 is clean but pass 3
 *      overwrites slot 0 later in the same frame. This is the reported bug.
 *   B  CHAIN, dirty the THIRD pixelate (pass 3). Pass 2 is clean and is the LAST
 *      writer of slot 0 — yet pass 0, which re-renders, rewrites slot 0 at the
 *      top of the frame and destroys what pass 2 left there. This is the second
 *      half of the hazard, and it is why the rule is "sole writer of its slot"
 *      rather than "last writer in the frame": the first draft of this fix
 *      passed A and failed B.
 *   C  BRANCH, dirty the Mix (the final pass). Both intermediate passes are
 *      clean AND sole writers of their slots, so both are still skipped. This is
 *      the scenario that would break if the fix were "give up and render
 *      everything".
 *
 * WebGPU is not covered because it has no per-pass dirty state at all: its
 * render loop walks every pass every frame, and `markAllDirty()` is a documented
 * no-op (src/webgpu/renderer.ts). There is nothing here for it to get wrong.
 *
 * Runs the real `src/webgl/renderer.ts` in headless Chrome against a throwaway
 * Vite dev server — no app, no worker, no React.
 *
 * Run: npx tsx scripts/verify-dirty-pass-skip-gpu.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')

/** Canvas edge in CSS px. Headless devicePixelRatio is 1, so also device px. */
const SIZE = 256

/** Distinct block sizes so no two pixelate passes can coincidentally agree. */
const PIXEL_SIZES = [9, 17, 27, 39]

type Fixture = 'chain' | 'branch'

interface RunReq {
  /** Which graph to compile. */
  fixture: Fixture
  /** Uniform to change between the two frames. */
  uniform: string
  /** Value to change it to. */
  value: number
  /** Force every pass dirty before frame 2 (the "render everything" reference). */
  forceAll: boolean
}

interface RunRes {
  ok: boolean
  error?: string
  width: number
  height: number
  /** Full-size RGBA of frame 2, base64. */
  b64: string
  /** Full-size RGBA of frame 1, base64. */
  b64First: string
  drawsFrame1: number
  drawsFrame2: number
  passCount: number
  slotCount: number | null
  targetSlots: Array<number | null>
}

async function installHarness(page: Page, cfg: {
  size: number
  pixelSizes: number[]
  base: string
}): Promise<boolean> {
  return await page.evaluate(async (c) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any

    const [nodesMod, glslMod] = await Promise.all([
      import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
    ])
    nodesMod.initializeNodeLibrary()
    const { compileGraph } = glslMod
    const rendererMod = await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)

    const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const edge = (id: string, s: string, t: string, th: string) =>
      ({ id, source: s, sourceHandle: 'color', target: t, targetHandle: th })

    /**
     * CHAIN:  gradient → pixelate × N → fragment_output  (slots reused)
     * BRANCH: two gradient → pixelate legs → Mix → fragment_output (slots not
     *         reused: both legs stay alive until the Mix reads them)
     * Only shipped nodes, so the slot layouts are ones a user can really build.
     */
    function buildPlan(fixture: string) {
      const nodes: any[] = []
      const edges: any[] = []
      if (fixture === 'chain') {
        nodes.push(node('g', 'gradient'))
        c.pixelSizes.forEach((px, i) => {
          nodes.push(node(`px${i}`, 'pixelate', { pixelSize: px }))
          edges.push(edge(`e${i}`, i === 0 ? 'g' : `px${i - 1}`, `px${i}`, 'source'))
        })
        nodes.push(node('out', 'fragment_output'))
        edges.push(edge('eo', `px${c.pixelSizes.length - 1}`, 'out', 'color'))
      } else {
        nodes.push(node('g0', 'gradient'), node('g1', 'gradient'))
        nodes.push(node('px0', 'pixelate', { pixelSize: c.pixelSizes[0] }))
        nodes.push(node('px1', 'pixelate', { pixelSize: c.pixelSizes[3] }))
        nodes.push(node('bl', 'mix', { factor: 0.5 }), node('out', 'fragment_output'))
        edges.push(edge('a', 'g0', 'px0', 'source'))
        edges.push(edge('b', 'g1', 'px1', 'source'))
        edges.push(edge('c', 'px0', 'bl', 'a'))
        edges.push(edge('d', 'px1', 'bl', 'b'))
        edges.push({ id: 'e', source: 'bl', sourceHandle: 'result', target: 'out', targetHandle: 'color' })
      }
      const plan = compileGraph(nodes, edges)
      if (!plan.success) throw new Error(`GLSL compile failed: ${JSON.stringify(plan.errors)}`)
      return plan
    }

    /**
     * Composite onto an opaque 2D canvas and read back as base64 RGBA.
     * Must stay synchronous with render(): the WebGL2 context has no
     * `preserveDrawingBuffer`, so an await here would let the compositor discard
     * the frame and every capture would come back black.
     */
    function grab(canvas: HTMLCanvasElement) {
      const out = document.createElement('canvas')
      out.width = canvas.width
      out.height = canvas.height
      const ctx = out.getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(canvas, 0, 0)
      const px = ctx.getImageData(0, 0, out.width, out.height).data
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < px.length; i += CH) {
        bin += String.fromCharCode.apply(null, px.subarray(i, i + CH) as unknown as number[])
      }
      return { width: out.width, height: out.height, b64: btoa(bin) }
    }

    w.__gate = {
      async run(req: { fixture: string; uniform: string; value: number; forceAll: boolean }) {
        const fail = (error: string) => ({
          ok: false, error, width: 0, height: 0, b64: '', b64First: '',
          drawsFrame1: -1, drawsFrame2: -1, passCount: 0, slotCount: null,
          targetSlots: [] as Array<number | null>,
        })
        const canvas = document.createElement('canvas')
        // Count real draw calls, so "identical" can be told apart from
        // "the optimisation was removed and everything renders anyway".
        const proto = WebGL2RenderingContext.prototype as any
        const origDraw = proto.drawArrays
        let draws = 0
        proto.drawArrays = function (...args: any[]) {
          draws++
          return origDraw.apply(this, args)
        }
        try {
          canvas.style.width = `${c.size}px`
          canvas.style.height = `${c.size}px`
          canvas.style.display = 'block'
          document.body.appendChild(canvas)
          const r = new rendererMod.WebGL2ShaderRenderer()
          await r.init(canvas)
          // Pin the DPR scale and stop the rAF loop: an animated renderer
          // re-dirties time-live passes every frame and renders at 0.75x.
          r.setAnimated(false)
          r.setQualityTier('high')
          r.setAnchor([0.5, 0.5])

          const plan = buildPlan(req.fixture)
          const res = r.updateRenderPlan(plan)
          if (!res.success) return fail(`updateRenderPlan: ${res.error}`)
          // Fragment Output multiplies by u_out_alpha, which reads 0 when
          // unbound — skipping this renders a transparent frame that looks
          // exactly like a broken pass (src/viewer.ts does the same).
          r.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))

          // Warm-up frame: settles the FBO pool, which setAnimated()'s DPR
          // change can otherwise leave stale into the first measured frame.
          r.render()
          r.markAllDirty()

          draws = 0
          r.render()
          const drawsFrame1 = draws
          const first = grab(canvas)

          r.updateUniforms([{ name: req.uniform, value: req.value }])
          if (req.forceAll) r.markAllDirty()

          draws = 0
          r.render()
          const drawsFrame2 = draws
          const second = grab(canvas)

          r.dispose()
          canvas.remove()
          return {
            ok: true,
            ...second,
            b64First: first.b64,
            drawsFrame1,
            drawsFrame2,
            passCount: plan.passes.length,
            slotCount: plan.slotCount ?? null,
            targetSlots: plan.passes.map((p: any) => p.targetSlot ?? null),
          }
        } catch (e: any) {
          return fail(String(e?.message ?? e))
        } finally {
          proto.drawArrays = origDraw
        }
      },
    }

    try {
      return !!document.createElement('canvas').getContext('webgl2')
    } catch {
      return false
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, cfg)
}

function sha256(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
}

interface Scenario {
  name: string
  fixture: Fixture
  /** Which node's uniform to change. */
  uniform: string
  value: number
  /** Passes the plan should have, and the slots they should target. */
  expectSlots: Array<number | null>
  /** Exact draw calls expected in the partial-dirty frame 2. */
  expectPartialDraws: number
  why: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'A: chain, clean pass is overwritten LATER in the same frame',
    fixture: 'chain',
    uniform: 'u_px0_pixelSize',
    value: 13,
    expectSlots: [0, 1, 0, 1, -1],
    // Pass 0 is clean but shares slot 0 with pass 3, so it must re-render.
    expectPartialDraws: 5,
    why: 'pass 0 is clean, holds slot 0, and pass 3 overwrites slot 0 later in the frame',
  },
  {
    name: 'B: chain, clean pass is overwritten at the TOP of the next frame',
    fixture: 'chain',
    uniform: 'u_px2_pixelSize',
    value: 31,
    expectSlots: [0, 1, 0, 1, -1],
    // Pass 2 is clean and IS the last writer of slot 0 in frame order — but
    // pass 0 re-renders into slot 0 before pass 3 reads it, so pass 2 must
    // re-render too.
    expectPartialDraws: 5,
    why: 'pass 2 is clean and holds slot 0, but pass 0 rewrites slot 0 ahead of pass 3 reading it',
  },
  {
    name: 'C: branch, clean passes are the sole writers of their slots',
    fixture: 'branch',
    uniform: 'u_bl_factor',
    value: 0.23,
    expectSlots: [0, 1, -1],
    // Only the final Mix pass is dirty; both branch passes own their slots
    // outright, so both are still legitimately skipped.
    expectPartialDraws: 1,
    why: 'nothing else writes either branch slot, so the skip is still sound',
  },
]

async function main() {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  const results = new Map<string, { partial: RunRes; forced: RunRes }>()
  let setupError: string | undefined
  let available = false

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
    const path = new URL(url).pathname
    const base = path.endsWith('/') ? path : `${path}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    // tsx compiles this file with esbuild's keepNames, which wraps named
    // functions in `__name(...)`. Playwright ships the callback SOURCE to the
    // page, where that helper does not exist — so provide it.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.route('**/__dirtygate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>dirty-pass-skip gate</title>' }))
    await page.goto(`${origin}${base}__dirtygate.html`)

    available = await installHarness(page, { size: SIZE, pixelSizes: PIXEL_SIZES, base })
    if (!available) throw new Error('headless Chrome reported no WebGL2 context')

    for (const s of SCENARIOS) {
      const call = (req: RunReq) =>
        page.evaluate(
          (r) => (window as never as { __gate: { run(r: RunReq): Promise<RunRes> } }).__gate.run(r),
          req,
        )
      const req = { fixture: s.fixture, uniform: s.uniform, value: s.value }
      const partial = await call({ ...req, forceAll: false })
      const forced = await call({ ...req, forceAll: true })
      results.set(s.name, { partial, forced })
      console.log(
        `  ${s.name}\n    partial draws f1/f2 = ${partial.drawsFrame1}/${partial.drawsFrame2}` +
        `, forced = ${forced.drawsFrame1}/${forced.drawsFrame2}`,
      )
    }
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e)
  } finally {
    await browser?.close()
    await server?.close()
  }

  test('the harness ran at all', () => {
    assert(!setupError, `setup failed: ${setupError}`)
    // A run that silently skips every scenario reads green. It is a FAILURE.
    assert(results.size === SCENARIOS.length,
      `expected ${SCENARIOS.length} scenarios, got ${results.size}`)
  })

  test('each fixture has the slot layout the scenario reasons about', () => {
    for (const s of SCENARIOS) {
      const { partial } = results.get(s.name)!
      assert(partial.ok, `${s.name}: run failed: ${partial.error}`)
      assert(JSON.stringify(partial.targetSlots) === JSON.stringify(s.expectSlots),
        `${s.name}: expected slots ${JSON.stringify(s.expectSlots)}, got ${JSON.stringify(partial.targetSlots)}`)
      assert(partial.passCount === s.expectSlots.length,
        `${s.name}: expected ${s.expectSlots.length} passes, got ${partial.passCount}`)
      const writers = new Map<number, number>()
      for (let i = 0; i < partial.targetSlots.length - 1; i++) {
        const slot = partial.targetSlots[i]
        if (slot === null || slot < 0) continue
        writers.set(slot, (writers.get(slot) ?? 0) + 1)
      }
      const shared = [...writers.values()].some((n) => n > 1)
      // The chain fixture must really share a slot (or scenarios A and B test
      // nothing); the branch fixture must really NOT (or C's surviving skip
      // says nothing about the narrowed rule).
      if (s.fixture === 'chain') {
        assert(shared, `${s.name}: no slot has two writers — nothing to get wrong`)
        assert(partial.slotCount !== null && partial.slotCount < partial.passCount - 1,
          `${s.name}: expected reuse, got ${partial.slotCount} slots for ${partial.passCount - 1} intermediates`)
      } else {
        assert(!shared, `${s.name}: expected every slot to have one writer, got ${JSON.stringify([...writers])}`)
      }
    }
  })

  for (const s of SCENARIOS) {
    test(`${s.name} — the uniform change moved the image`, () => {
      const { forced } = results.get(s.name)!
      assert(forced.ok, `run failed: ${forced.error}`)
      assert(sha256(forced.b64First) !== sha256(forced.b64),
        `changing ${s.uniform} produced a byte-identical frame — the two-frame ` +
        `comparison below would pass no matter what the skip rule did`)
    })

    test(`${s.name} — partial dirty renders what a full render renders`, () => {
      const { partial, forced } = results.get(s.name)!
      assert(partial.ok, `partial run failed: ${partial.error}`)
      assert(forced.ok, `forced run failed: ${forced.error}`)
      assert(partial.width === forced.width && partial.height === forced.height,
        `capture sizes differ: ${partial.width}x${partial.height} vs ${forced.width}x${forced.height}`)
      assert(partial.width === SIZE && partial.height === SIZE,
        `expected a ${SIZE}x${SIZE} capture, got ${partial.width}x${partial.height}`)
      const a = sha256(partial.b64)
      const b = sha256(forced.b64)
      assert(a === b,
        `frame 2 differs from a full re-render (${s.why}).\n` +
        `      partial sha256 ${a}\n      forced  sha256 ${b}`)
    })

    test(`${s.name} — exactly the intended passes re-render`, () => {
      const { partial, forced } = results.get(s.name)!
      assert(partial.ok && forced.ok, 'run failed')
      // Frame 1 renders everything, which fixes one draw call per pass.
      assert(partial.drawsFrame1 === partial.passCount,
        `frame 1 should draw every pass once, got ${partial.drawsFrame1} for ${partial.passCount} passes`)
      assert(forced.drawsFrame2 === forced.passCount,
        `the forced reference should draw every pass, got ${forced.drawsFrame2}`)
      // Exact, not a bound: a rule that renders more than intended is a silent
      // loss of the optimisation, and one that renders less is the bug back.
      assert(partial.drawsFrame2 === s.expectPartialDraws,
        `expected ${s.expectPartialDraws} draws in the partial frame 2 (${s.why}), ` +
        `got ${partial.drawsFrame2} of ${partial.passCount} passes`)
    })
  }

  await run('dirty-pass skip vs shared texture slots (WebGL2)')
}

main()
