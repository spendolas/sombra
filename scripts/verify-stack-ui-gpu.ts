/**
 * The Stack layer list wired into the LIVE editor: drag the visible top layer
 * to the bottom through the real UI, and the stored array, the rendered order
 * and the composite must all agree — and every wire must redraw at its moved
 * handle.
 *
 * The layer list is top-first (Photoshop order); `params.layers` is stored
 * bottom-first. An off-by-one at that boundary is a silent wrong image, so
 * this checks all three views of the order against each other, not one.
 *
 * Fixture: two opaque Normal layers — red (Layer 1, bottom) and blue (Layer 2,
 * top). With opaque Normal layers the composite is exactly the top layer's
 * colour, so the canvas centre says which layer the RENDERER thinks is on top.
 *
 * Wires: a reorder moves handles without changing the node's size, so React
 * Flow keeps stale handle bounds unless `updateNodeInternals` runs. Each
 * Stack edge's drawn end point is compared with its handle's centre.
 *
 * Run: npm run verify:stack-ui:gpu   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const RED: [number, number, number, number] = [0.9, 0.1, 0.1, 1]
const BLUE: [number, number, number, number] = [0.1, 0.1, 0.9, 1]

interface View {
  stored: string[]
  shown: string[]
  pixel: number[]
  edges: string[]
  /** Per Stack edge: |drawn end y − handle centre y| in flow units. */
  wireOffsets: Array<{ handle: string; dy: number }>
  errors: string[]
}

async function view(page: Page): Promise<View> {
  return page.evaluate(async () => {
    const s = (window as unknown as { __sombra: any }).__sombra // eslint-disable-line @typescript-eslint/no-explicit-any
    const st = s.stores.graph.getState()
    const id = (window as unknown as { __stk: string }).__stk
    const node = st.nodes.find((n: { id: string }) => n.id === id)
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)!
    const vp = document.querySelector('.react-flow__viewport') as HTMLElement
    const m = vp.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/)!
    const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const paneRect = (document.querySelector('.react-flow') as HTMLElement).getBoundingClientRect()
    const wireOffsets: Array<{ handle: string; dy: number }> = []
    for (const e of st.edges.filter((x: { target: string }) => x.target === id)) {
      const path = document.querySelector(`.react-flow__edge[data-id="${e.id}"] path`)
      const handle = el.querySelector(`.react-flow__handle[data-handleid="${e.targetHandle}"]`)
      if (!path || !handle) { wireOffsets.push({ handle: e.targetHandle, dy: Infinity }); continue }
      const nums = (path.getAttribute('d') ?? '').match(/-?[\d.]+/g)!.map(Number)
      const endY = nums[nums.length - 1]
      const hr = handle.getBoundingClientRect()
      const centreY = (hr.top + hr.height / 2 - paneRect.top - ty) / k
      wireOffsets.push({ handle: e.targetHandle, dy: Math.abs(endY - centreY) })
    }
    // The composite: render and read back in the same task (WebGPU presents
    // and clears; WebGL2 skips a clean static graph unless marked dirty).
    const r = s.renderer
    r.markAllDirty?.()
    r.render()
    const canvas = r.canvas as HTMLCanvasElement
    const c2 = document.createElement('canvas')
    c2.width = canvas.width; c2.height = canvas.height
    const ctx = c2.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(canvas, 0, 0)
    const px = [...ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data]
    void tx
    return {
      stored: (node.data.params.layers ?? []).map((l: { name: string }) => l.name),
      shown: [...el.querySelectorAll('span[title^="Layer"]')].map((x) => x.textContent ?? ''),
      pixel: px,
      edges: st.edges.filter((x: { target: string }) => x.target === id).map((x: { source: string; targetHandle: string }) => `${x.source}>${x.targetHandle}`).sort(),
      wireOffsets,
      errors: s.stores.compiler.getState().errors.map((x: { message: string }) => x.message),
    }
  })
}

/** Wait until the live compile settles: same plan twice, no pending work. */
async function settle(page: Page) {
  await page.waitForTimeout(900)
}

const isRed = (p: number[]) => p[0] > 180 && p[2] < 60
const isBlue = (p: number[]) => p[2] > 180 && p[0] < 60

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.goto(url)
    await page.waitForFunction(() => {
      const s = (window as unknown as { __sombra?: { renderer?: unknown } }).__sombra
      return !!s?.renderer
    }, null, { timeout: 30000 })

    await page.evaluate(({ RED, BLUE }) => {
      const s = (window as unknown as { __sombra: any }).__sombra // eslint-disable-line @typescript-eslint/no-explicit-any
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 700, y: 0 })
      const red = s.createNode('color_constant', { x: 0, y: 0 }, { color: RED })
      const blue = s.createNode('color_constant', { x: 0, y: 300 }, { color: BLUE })
      const stk = s.createNode('stack', { x: 320, y: 0 })
      s.connect(red, stk, 'color', 'layer_l1')
      s.connect(blue, stk, 'color', 'layer_l2')
      s.connect(stk, out, 'color', 'color')
      ;(window as unknown as { __stk: string }).__stk = stk
    }, { RED, BLUE })
    await settle(page)

    const before = await view(page)
    test('fixture: Layer 2 (blue) on top in every view', () => {
      assert(JSON.stringify(before.stored) === '["Layer 1","Layer 2"]', `stored ${JSON.stringify(before.stored)}`)
      assert(JSON.stringify(before.shown) === '["Layer 2","Layer 1"]', `the list shows ${JSON.stringify(before.shown)} — expected top-first`)
      assert(isBlue(before.pixel), `composite ${before.pixel} — expected blue (Layer 2 on top)`)
      assert(before.errors.length === 0, `compile errors: ${before.errors}`)
      for (const w of before.wireOffsets) assert(w.dy <= 1.5, `wire into ${w.handle} ends ${w.dy.toFixed(1)} from its handle before any edit`)
    })

    // Drag the TOP card's grip below the bottom card, through the real
    // pointer path the list implements (pointerdown on the grip, moves and
    // release on window).
    await page.evaluate(async () => {
      const id = (window as unknown as { __stk: string }).__stk
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`)!
      const grips = [...el.querySelectorAll('[aria-label^="Reorder "]')] as HTMLElement[]
      const g = grips[0]
      const gr = g.getBoundingClientRect()
      // Well below the bottom card: the drop slot is wherever the dragged
      // card's centre has passed every other card's midpoint.
      const last = grips[grips.length - 1].getBoundingClientRect()
      const x = gr.left + gr.width / 2, y0 = gr.top + gr.height / 2, y1 = last.bottom + 150
      const ev = (y: number, buttons: number) => ({ pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true })
      g.dispatchEvent(new PointerEvent('pointerdown', ev(y0, 1)))
      await new Promise((r) => setTimeout(r, 30))
      for (let i = 1; i <= 12; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', ev(y0 + (y1 - y0) * i / 12, 1)))
        await new Promise((r) => setTimeout(r, 16))
      }
      window.dispatchEvent(new PointerEvent('pointerup', ev(y1, 0)))
    })
    await settle(page)
    const after = await view(page)

    test('drag top → bottom: stored order, shown order and composite agree', () => {
      assert(JSON.stringify(after.stored) === '["Layer 2","Layer 1"]',
        `stored bottom-first ${JSON.stringify(after.stored)} — expected Layer 2 now composited FIRST`)
      assert(JSON.stringify(after.shown) === '["Layer 1","Layer 2"]', `the list shows ${JSON.stringify(after.shown)} — expected Layer 1 on top`)
      assert(isRed(after.pixel), `composite ${after.pixel} — expected red: the renderer must agree that Layer 1 is now on top`)
      assert(JSON.stringify(after.edges) === JSON.stringify(before.edges), `wires changed on reorder: ${after.edges} vs ${before.edges}`)
      assert(after.errors.length === 0, `compile errors: ${after.errors}`)
    })

    test('every wire redraws at its moved handle (updateNodeInternals)', () => {
      // The fixture's handles DID move: Layer 1's source handle was below
      // Layer 2's, and now sits above it.
      for (const w of after.wireOffsets) {
        assert(w.dy <= 1.5, `the wire into ${w.handle} ends ${w.dy.toFixed(1)} flow-px from its handle — drawn at the stale position`)
      }
    })

    await page.evaluate(() => (window as unknown as { __sombra: any }).__sombra.stores.graph.getState().undo()) // eslint-disable-line @typescript-eslint/no-explicit-any
    await settle(page)
    const undone = await view(page)
    test('one undo restores the order in every view', () => {
      assert(JSON.stringify(undone.stored) === JSON.stringify(before.stored), `stored ${JSON.stringify(undone.stored)}`)
      assert(JSON.stringify(undone.shown) === JSON.stringify(before.shown), `shown ${JSON.stringify(undone.shown)}`)
      assert(isBlue(undone.pixel), `composite ${undone.pixel} — expected blue again`)
      for (const w of undone.wireOffsets) assert(w.dy <= 1.5, `after undo the wire into ${w.handle} is ${w.dy.toFixed(1)} off`)
    })

    // ---- thumbnail: shown only when a VISIBLE layer has content ----------------
    // An empty Stack, or one with every layer hidden, outputs transparent by
    // construction and shows no thumbnail (Figma 979:4841, column B "Empty").
    // Measured as the preview wrapper's rendered height after its collapse /
    // expand animation, which runs on requestAnimationFrame.
    const SHOTS = process.env.STACK_UI_SHOTS
    const thumbState = async (label: string, edit: () => Promise<void>) => {
      await edit()
      await page.waitForTimeout(2500)
      const { h, op, px } = await page.evaluate(() => {
        const id = (window as unknown as { __stk: string }).__stk
        const cv = document.querySelector(`.react-flow__node[data-id="${id}"] canvas`) as HTMLCanvasElement | null
        if (!cv) return { h: -1, op: 0, px: [] as number[] }
        const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
        const ctx = c.getContext('2d')!; ctx.drawImage(cv, 0, 0)
        const w = cv.parentElement!
        return { h: Math.round(w.getBoundingClientRect().height), op: Number(getComputedStyle(w).opacity), px: [...ctx.getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data] }
      })
      if (SHOTS) {
        const id = await page.evaluate(() => (window as unknown as { __stk: string }).__stk)
        // The thumbnail sits ABOVE the node's box (negative margin), so clip
        // to the union of the node and its preview canvas.
        const box = await page.evaluate((nid) => {
          const el = document.querySelector(`.react-flow__node[data-id="${nid}"]`)!
          const rs = [el.getBoundingClientRect(), el.querySelector('canvas')!.getBoundingClientRect()]
          const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top))
          return { x: x - 8, y: y - 8, width: Math.max(...rs.map((r) => r.right)) - x + 16, height: Math.max(...rs.map((r) => r.bottom)) - y + 16 }
        }, id)
        await page.screenshot({ path: `${SHOTS}/stack-${label}.png`, clip: box })
      }
      return { h, op, px }
    }
    const store = (fn: string) => page.evaluate(fn)
    const oneVisible = await thumbState('one-visible', async () => {
      // Back to the original two layers (undo above), drop the top one: one
      // visible, wired layer remains.
      await store(`(() => { const s = window.__sombra; const G = s.stores.graph.getState(); const id = window.__stk;
        const top = G.nodes.find((n) => n.id === id).data.params.layers.at(-1).id; G.editStackLayers(id, { kind: 'remove', id: top }) })()`)
    })
    const allHidden = await thumbState('all-hidden', async () => {
      await store(`(() => { const s = window.__sombra; const G = s.stores.graph.getState(); const id = window.__stk;
        for (const l of G.nodes.find((n) => n.id === id).data.params.layers) G.editStackLayers(id, { kind: 'toggleVisible', id: l.id }) })()`)
    })
    const hiddenWires = await page.evaluate(() => {
      const s = (window as unknown as { __sombra: any }).__sombra // eslint-disable-line @typescript-eslint/no-explicit-any
      return s.stores.graph.getState().edges.filter((e: { target: string }) => e.target === (window as unknown as { __stk: string }).__stk).length
    })
    const empty = await thumbState('empty', async () => {
      await store(`(() => { const s = window.__sombra; const G = s.stores.graph.getState(); const id = window.__stk;
        for (const l of G.nodes.find((n) => n.id === id).data.params.layers) s.stores.graph.getState().editStackLayers(id, { kind: 'remove', id: l.id }) })()`)
    })
    test('thumbnail: shown with one visible wired layer, hidden when every layer is hidden or the list is empty', () => {
      assert(oneVisible.h > 40, `one visible wired layer: thumbnail height ${oneVisible.h} — it should show`)
      assert(oneVisible.op === 1, `one visible wired layer: thumbnail is open but its opacity is ${oneVisible.op} — invisible`)
      assert(isRed(oneVisible.px), `the thumbnail shows ${oneVisible.px}, expected the red layer`)
      assert(hiddenWires >= 1, 'fixture: the hidden layer lost its wire, so "all hidden" would not test the hidden-port rule')
      assert(allHidden.h === 0, `every layer hidden (wires kept): thumbnail height ${allHidden.h} — it should not show`)
      assert(empty.h === 0, `empty Stack: thumbnail height ${empty.h} — it should not show`)
    })

    const bridge = await page.evaluate(() => {
      const s = (window as unknown as { __sombra: any }).__sombra // eslint-disable-line @typescript-eslint/no-explicit-any
      const src = s.createNode('checkerboard', { x: 0, y: 600 })
      const stk = s.createNode('stack', { x: 320, y: 600 })
      let refused = ''
      try { s.connect(src, stk, 'color', 'backdrop') } catch (e) { refused = String((e as Error).message) }
      let id = ''
      try { id = s.connect(src, stk) } catch (e) { return { refused, defaultHandle: `<threw: ${String((e as Error).message)}>`, intoBackdrop: -1 } }
      const edge = s.stores.graph.getState().edges.find((x: { id: string }) => x.id === id)
      const intoBackdrop = s.stores.graph.getState().edges.filter((x: { target: string; targetHandle: string }) => x.target === stk && x.targetHandle === 'backdrop').length
      return { refused, defaultHandle: edge?.targetHandle, intoBackdrop }
    })
    test('bridge: connect into backdrop throws; the default target is the first USER port', () => {
      assert(/not allowed/.test(bridge.refused), `connect(…, 'backdrop') did not throw: "${bridge.refused}"`)
      assert(bridge.intoBackdrop === 0, `${bridge.intoBackdrop} edge(s) into backdrop exist`)
      assert(bridge.defaultHandle === 'layer_l1', `connect(src, stack) wired ${bridge.defaultHandle}, expected layer_l1 (the bottom layer), never backdrop`)
    })

    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join(' | ')))
    await run('stack-ui-gpu')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
