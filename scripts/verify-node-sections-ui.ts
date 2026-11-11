/**
 * The Transform section header and the node title rename, wired into the LIVE
 * editor — real mouse and keyboard in headless Chrome, on a real graph.
 *
 *  1. Wires gather: Scale ← Number and Rotate ← Time on a Stripes node, section
 *     collapsed — both edges still exist AND are drawn, each path ending on the
 *     header's gather dot (≤ 2px); badge "· 2". Expanded: each edge ends on its
 *     own row's handle again. Handle ids equal the param ids in both states.
 *  2. Hovering the dot shows a popover listing exactly those two params and
 *     their sources. Clicking the dot opens the section and does NOT start a
 *     click-connection from the stacked handles.
 *  3. Open on drag: a real connection drag from an output onto the collapsed
 *     header lights it as a drop target, opens it after the dwell, and the
 *     drop on a row's handle creates the edge on that exact param id.
 *  4. The collapse state persists (reload → localStorage; .sombra package
 *     export → import), is untouched by undo, and a toggle posts ZERO compile
 *     or thumbnail requests to the workers (positive control: an edit does).
 *  5. Rename via the pencil: Enter saves, one undo reverts, no compile and no
 *     thumbnail request; duplicate names warn on both nodes and clearing one
 *     clears both; click-away saves; Escape cancels; Backspace in the field
 *     does not delete the node.
 *
 * Worker traffic is counted by wrapping Worker.prototype.postMessage before
 * the app loads: the live compiler posts `{id, nodes, edges}`, the thumbnail
 * scheduler `{type: 'preview' | 'preview-ir', targetNodeId}` — so "no
 * recompile" and "no thumbnail re-render" are counted at the mechanism, and
 * each zero is paired with an edit that does post.
 *
 * Screenshots: NODE_SECTIONS_SHOTS=<dir> npm run verify:node-sections-ui
 * Run: npm run verify:node-sections-ui   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS = process.env.NODE_SECTIONS_SHOTS
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const COUNTER = `
  window.__wc = { compile: 0, preview: [] };
  const orig = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (msg, ...rest) {
    try {
      if (msg && typeof msg === 'object') {
        if (msg.type === 'preview' || msg.type === 'preview-ir') window.__wc.preview.push(msg.targetNodeId);
        else if (!msg.type && Array.isArray(msg.nodes) && Array.isArray(msg.edges)) window.__wc.compile++;
      }
    } catch {}
    return orig.call(this, msg, ...rest);
  };
  globalThis.__name = globalThis.__name || ((f) => f);
`

interface Ids { st: string; num: string; time: string; num2: string; out: string; nz: string }

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: SHOTS ? 2 : 1 })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.addInitScript({ content: COUNTER })

    const boot = async () => {
      await page.waitForFunction(() => !!(window as Any).__sombra?.renderer, null, { timeout: 30000 })
      await page.waitForTimeout(500)
    }
    await page.goto(url)
    await boot()

    // ── Fixture ──────────────────────────────────────────────────────────────
    const ids: Ids = await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 620, y: 0 })
      const st = s.createNode('stripes', { x: 330, y: 0 })
      const num = s.createNode('float_constant', { x: 0, y: 0 }, { value: 1.5 })
      const time = s.createNode('time', { x: 0, y: 170 })
      const num2 = s.createNode('float_constant', { x: 0, y: 340 }, { value: 40 })
      const nz = s.createNode('noise', { x: 0, y: 520 })
      s.connect(st, out, 'color', 'color')
      s.connect(num, st, 'value', 'srt_scale')
      s.connect(time, st, 'time', 'srt_rotate')
      return { st, num, time, num2, out, nz }
    })
    await page.waitForTimeout(1500)
    // Fit: zoom/pan until every node is on screen right of the palette.
    await page.evaluate(async () => {
      const pane = document.querySelector('.react-flow__pane')!
      const all = () => [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect())
      const flow = (document.querySelector('.react-flow') as HTMLElement).getBoundingClientRect()
      for (let i = 0; i < 100; i++) {
        const rs = all()
        const top = Math.min(...rs.map((r) => r.top)) - 100, bottom = Math.max(...rs.map((r) => r.bottom))
        const left = Math.min(...rs.map((r) => r.left)), right = Math.max(...rs.map((r) => r.right))
        const fits = top > flow.top + 10 && bottom < flow.bottom - 160 && left > flow.left + 20 && right < flow.right - 20
        if (fits) break
        const tooBig = bottom - top > flow.height - 200 || right - left > flow.width - 60
        if (tooBig) pane.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, ctrlKey: true, clientX: (left + right) / 2, clientY: (top + bottom) / 2, bubbles: true, cancelable: true }))
        else pane.dispatchEvent(new WheelEvent('wheel', { deltaX: left < flow.left + 20 ? -(flow.left + 40 - left) : (right > flow.right - 20 ? right - flow.right + 40 : 0), deltaY: top < flow.top + 10 ? -(flow.top + 30 - top) : (bottom > flow.bottom - 160 ? bottom - flow.bottom + 180 : 0), clientX: flow.left + flow.width / 2, clientY: flow.top + flow.height / 2, bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 40))
      }
    })
    await page.waitForTimeout(400)

    const nodeSel = (id: string) => `.react-flow__node[data-id="${id}"]`
    const headerState = () => page.evaluate((sel) => {
      const n = document.querySelector(sel)!
      const btn = n.querySelector('button[aria-expanded]') as HTMLElement | null
      return {
        open: btn?.getAttribute('aria-expanded') === 'true',
        count: n.querySelector('[data-count]')?.getAttribute('data-count') ?? null,
        countText: n.querySelector('[data-count]')?.textContent ?? null,
        gatherIds: [...n.querySelectorAll('[data-gather] .react-flow__handle')].map((h) => h.getAttribute('data-handleid')),
        dropActive: !!n.querySelector('[data-drop-active="true"]'),
        handleIds: [...n.querySelectorAll('.react-flow__handle.target')].map((h) => h.getAttribute('data-handleid')),
      }
    }, nodeSel(ids.st))

    /** Per edge into Stripes: drawn end point vs the gather dot / its own handle, in flow px. */
    const wires = () => page.evaluate(({ st }) => {
      const s = (window as Any).__sombra
      const vp = document.querySelector('.react-flow__viewport') as HTMLElement
      const m = new DOMMatrix(getComputedStyle(vp).transform)
      const paneRect = (document.querySelector('.react-flow') as HTMLElement).getBoundingClientRect()
      const toFlow = (r: DOMRect) => ({
        l: (r.left - paneRect.left - m.e) / m.a, r: (r.right - paneRect.left - m.e) / m.a,
        t: (r.top - paneRect.top - m.f) / m.a, b: (r.bottom - paneRect.top - m.f) / m.a,
      })
      const dist = (p: { x: number; y: number }, b: { l: number; r: number; t: number; b: number }) =>
        Math.hypot(Math.max(b.l - p.x, 0, p.x - b.r), Math.max(b.t - p.y, 0, p.y - b.b))
      const node = document.querySelector(`.react-flow__node[data-id="${st}"]`)!
      const dot = node.querySelector('[data-gather]')
      const out: Array<{ handle: string; drawn: boolean; toDot: number; toOwn: number; ownInGather: boolean }> = []
      for (const e of s.stores.graph.getState().edges.filter((x: Any) => x.target === st)) {
        const path = document.querySelector(`.react-flow__edge[data-id="${e.id}"] path`)
        const nums = (path?.getAttribute('d') ?? '').match(/-?[\d.]+(?:e-?\d+)?/g)?.map(Number) ?? []
        const end = nums.length >= 2 ? { x: nums[nums.length - 2], y: nums[nums.length - 1] } : null
        const own = node.querySelector(`.react-flow__handle[data-handleid="${e.targetHandle}"]`)
        out.push({
          handle: e.targetHandle,
          drawn: !!end,
          toDot: end && dot ? dist(end, toFlow(dot.getBoundingClientRect())) : Infinity,
          toOwn: end && own ? dist(end, toFlow(own.getBoundingClientRect())) : Infinity,
          ownInGather: !!own?.closest('[data-gather]'),
        })
      }
      return out.sort((a, b) => a.handle.localeCompare(b.handle))
    }, { st: ids.st })

    const centre = (sel: string) => page.evaluate((q) => {
      const el = document.querySelector(q)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    }, sel)
    const counts = () => page.evaluate(() => ({ compile: (window as Any).__wc.compile as number, preview: [...(window as Any).__wc.preview] as string[] }))
    const graph = () => page.evaluate(() => {
      const st = (window as Any).__sombra.stores.graph.getState()
      return { past: st._past.length as number, edges: st.edges.map((e: Any) => `${e.source}>${e.targetHandle}`) as string[], nodes: st.nodes.map((n: Any) => ({ id: n.id, label: n.data.label, ui: n.data.ui })) as Array<{ id: string; label?: string; ui?: Any }> }
    })
    const shot = async (name: string, ids_: string[], pad = 16, extraBelow = 0) => {
      if (!SHOTS) return
      const box = await page.evaluate(({ ids_, pad, extraBelow }) => {
        const rs = ids_.map((id) => document.querySelector(`.react-flow__node[data-id="${id}"]`)!.getBoundingClientRect())
        const x = Math.min(...rs.map((r) => r.left)) - pad, y = Math.min(...rs.map((r) => r.top)) - pad
        return { x, y, width: Math.max(...rs.map((r) => r.right)) + pad - x, height: Math.max(...rs.map((r) => r.bottom)) + pad + extraBelow - y }
      }, { ids_, pad, extraBelow })
      await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: box })
    }

    // ── 1. Collapsed: wires gather on the dot ────────────────────────────────
    const collapsed = await headerState()
    const collapsedWires = await wires()
    const g1 = await graph()
    await shot('collapsed-2-wires', [ids.st, ids.num, ids.time])
    test('collapsed: both edges exist, are drawn, and end on the gather dot (≤2px); badge = 2', () => {
      assert(!collapsed.open, 'fixture: the section is not collapsed by default')
      assert(g1.edges.includes(`${ids.num}>srt_scale`) && g1.edges.includes(`${ids.time}>srt_rotate`), `edges ${g1.edges}`)
      assert(JSON.stringify(collapsed.gatherIds.sort()) === '["srt_rotate","srt_scale"]', `gathered handle ids ${JSON.stringify(collapsed.gatherIds)} — must equal the param ids`)
      const srt = collapsedWires.filter((w) => w.handle.startsWith('srt_'))
      assert(srt.length === 2, `${srt.length} Transform edges measured`)
      for (const w of srt) {
        assert(w.drawn, `the wire into ${w.handle} is not drawn`)
        assert(w.toDot <= 2, `the wire into ${w.handle} ends ${w.toDot.toFixed(1)} flow-px from the gather dot`)
      }
      assert(collapsed.count === '2' && collapsed.countText === '· 2', `badge ${collapsed.count} / "${collapsed.countText}"`)
    })

    // ── 2. Popover on the dot ────────────────────────────────────────────────
    const dot = await centre(`${nodeSel(ids.st)} [data-gather]`)
    if (dot) await page.mouse.move(dot.x, dot.y, { steps: 4 })
    await page.waitForTimeout(250)
    const pop = await page.evaluate((sel) => {
      const t = document.querySelector(`${sel} [role="tooltip"]`)
      if (!t) return null
      // Row = param span + source span; join the spans as the eye reads them.
      return [...t.children].map((r) => (r.children.length ? [...r.children].map((c) => c.textContent ?? '').join(' ') : r.textContent ?? '').replace(/\s+/g, ' ').trim())
    }, nodeSel(ids.st))
    await shot('popover', [ids.st], 16, 70)
    test('hovering the dot: the popover lists exactly the two wired params and their sources', () => {
      assert(dot, 'no gather dot')
      assert(pop, 'no popover on dot hover')
      const rows = pop!.filter((r) => r.startsWith('→'))
      assert(JSON.stringify(rows) === JSON.stringify(['→ Scale from Number.value', '→ Rotate from Time.time']), `popover rows ${JSON.stringify(rows)}`)
    })

    // Clicking the dot opens the section and starts no click-connection: a
    // following click on an output handle must not create an edge.
    const before2 = await graph()
    if (dot) await page.mouse.click(dot.x, dot.y)
    await page.waitForTimeout(300)
    const afterDot = await headerState()
    const n2out = await centre(`${nodeSel(ids.num2)} .react-flow__handle.source[data-handleid="value"]`)
    if (n2out) { await page.mouse.click(n2out.x, n2out.y); await page.waitForTimeout(200); await page.mouse.click(n2out.x, n2out.y) }
    await page.waitForTimeout(300)
    const after2 = await graph()
    test('clicking the dot opens the section and does not start a click-connection', () => {
      assert(afterDot.open, 'clicking the gather dot did not open the section')
      assert(after2.edges.length === before2.edges.length, `a click-connection from the dot created an edge: ${after2.edges.filter((e) => !before2.edges.includes(e))}`)
    })

    // ── 1b. Expanded: wires back on their rows ───────────────────────────────
    await page.mouse.move(5, 5)
    await page.waitForTimeout(300)
    const expanded = await headerState()
    const expandedWires = await wires()
    test('expanded: no dot / count; each wire ends on its own row handle (≤2px)', () => {
      assert(expanded.open, 'fixture: not expanded')
      assert(expanded.count === null && expanded.gatherIds.length === 0, `dot/count still shown: ${JSON.stringify(expanded)}`)
      for (const id of ['srt_scale', 'srt_rotate']) assert(expanded.handleIds.filter((h) => h === id).length === 1, `${id} mounted ${expanded.handleIds.filter((h) => h === id).length}×`)
      for (const w of expandedWires.filter((x) => x.handle.startsWith('srt_'))) {
        assert(!w.ownInGather, `${w.handle}'s handle is still in the gather slot`)
        assert(w.toOwn <= 2, `the wire into ${w.handle} ends ${w.toOwn.toFixed(1)} flow-px from its row handle`)
      }
    })

    // ── 3. Open on drag ──────────────────────────────────────────────────────
    const toggleBtn = `${nodeSel(ids.st)} button[aria-expanded]`
    const tb = await centre(toggleBtn)
    if (tb) await page.mouse.click(tb.x, tb.y)       // collapse again (real click)
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    const reCollapsed = await headerState()
    const src = await centre(`${nodeSel(ids.num2)} .react-flow__handle.source[data-handleid="value"]`)
    const hdr = await centre(`${nodeSel(ids.st)} [data-state]`)
    let dragOverEarly = { open: true, dropActive: false }
    let dragOpened = { open: false, dropActive: false }
    if (src && hdr) {
      await page.mouse.move(src.x, src.y)
      await page.mouse.down()
      await page.mouse.move((src.x + hdr.x) / 2, (src.y + hdr.y) / 2, { steps: 6 })
      await page.mouse.move(hdr.x, hdr.y, { steps: 6 })
      await page.waitForTimeout(150)
      dragOverEarly = await headerState()
      await page.waitForTimeout(500)
      dragOpened = await headerState()
      const row = await centre(`${nodeSel(ids.st)} .react-flow__handle.target[data-handleid="srt_translateX"]`)
      if (row) await page.mouse.move(row.x, row.y, { steps: 6 })
      await page.mouse.up()
    } else await page.mouse.up()
    await page.waitForTimeout(700)
    const g3 = await graph()
    test('drag a wire over the collapsed header: lights up, opens after the dwell, drop lands on the row param', () => {
      assert(!reCollapsed.open, 'fixture: the header click did not collapse the section')
      assert(src && hdr, 'source handle or header not found')
      assert(!dragOverEarly.open && dragOverEarly.dropActive, `150 ms over the header: open=${dragOverEarly.open} dropActive=${dragOverEarly.dropActive} — expected a lit, still-closed drop target`)
      assert(dragOpened.open, 'the section did not open after the dwell')
      assert(g3.edges.includes(`${ids.num2}>srt_translateX`), `no edge onto srt_translateX: ${g3.edges}`)
    })

    // Same with a TOUCH drag. A touch is implicitly captured by the element it
    // started on, so the header never sees pointerenter — only the node's own
    // hit-test of the drag position can light it up.
    const tbT = await centre(toggleBtn)
    if (tbT) await page.mouse.click(tbT.x, tbT.y)
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    const touchCollapsed = (await headerState()).open === false
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', p?: { x: number; y: number }) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] : [] })
    const tsrc = await centre(`${nodeSel(ids.nz)} .react-flow__handle.source[data-handleid="value"]`)
    const thdr = await centre(`${nodeSel(ids.st)} [data-state]`)
    let touchEarly = { open: true, dropActive: false }
    let touchOpened = { open: false }
    if (tsrc && thdr) {
      await touch('touchStart', tsrc)
      for (let i = 1; i <= 12; i++) {
        await touch('touchMove', { x: tsrc.x + (thdr.x - tsrc.x) * i / 12, y: tsrc.y + (thdr.y - tsrc.y) * i / 12 })
        await page.waitForTimeout(16)
      }
      await page.waitForTimeout(150)
      touchEarly = await headerState()
      await page.waitForTimeout(500)
      touchOpened = await headerState()
      const row = await centre(`${nodeSel(ids.st)} .react-flow__handle.target[data-handleid="srt_translateY"]`)
      if (row) {
        for (let i = 1; i <= 6; i++) {
          await touch('touchMove', { x: thdr.x + (row.x - thdr.x) * i / 6, y: thdr.y + (row.y - thdr.y) * i / 6 })
          await page.waitForTimeout(16)
        }
      }
      await touch('touchEnd')
    }
    await page.waitForTimeout(700)
    const gT = await graph()
    test('touch drag over the collapsed header: lights up (hit-test, no pointerenter), opens, drop lands on the row param', () => {
      assert(touchCollapsed, 'fixture: the section did not collapse before the touch drag')
      assert(tsrc && thdr, 'noise output or header not found')
      assert(!touchEarly.open && touchEarly.dropActive, `150 ms of touch over the header: open=${touchEarly.open} dropActive=${touchEarly.dropActive}`)
      assert(touchOpened.open, 'the section did not open after the dwell under touch')
      assert(gT.edges.includes(`${ids.nz}>srt_translateY`), `no edge onto srt_translateY after the touch drop: ${gT.edges}`)
    })

    // ── 4. Persistence, undo, zero recompiles ────────────────────────────────
    await page.waitForTimeout(1200)
    const c0 = await counts()
    const pastBefore = (await graph()).past
    // Toggle twice through the real header (open → collapsed → open).
    for (let i = 0; i < 2; i++) {
      const b = await centre(toggleBtn)
      if (b) await page.mouse.click(b.x, b.y)
      await page.waitForTimeout(150)
    }
    await page.mouse.move(5, 5)
    await page.waitForTimeout(1200)               // > the compile debounce
    const c1 = await counts()
    const g4 = await graph()
    const openNow = (await headerState()).open
    // Positive control: a real param edit on the same node posts both kinds.
    await page.evaluate((st) => (window as Any).__sombra.setParams(st, { srt_rotate: 30 }), ids.st)
    await page.evaluate((num) => (window as Any).__sombra.setParams(num, { value: 2.5 }), ids.num)
    await page.evaluate((nz) => (window as Any).__sombra.setParams(nz, { noiseType: 'value' }), ids.nz)
    await page.waitForTimeout(1200)
    const c2 = await counts()
    test('toggling the section: no history entry, zero compile and zero thumbnail requests (an edit does post)', () => {
      assert(openNow, 'fixture: two clicks should leave the section open')
      assert(g4.past === pastBefore, `a toggle pushed ${g4.past - pastBefore} history entr(y/ies)`)
      assert(c1.compile === c0.compile, `${c1.compile - c0.compile} recompile(s) posted by toggling`)
      assert(c1.preview.length === c0.preview.length, `${c1.preview.length - c0.preview.length} thumbnail request(s) posted by toggling: ${c1.preview.slice(c0.preview.length)}`)
      assert(c2.compile > c1.compile, 'control: a recompile-mode edit posted no compile — the counter is not wired')
      assert(c2.preview.length > c1.preview.length, 'control: a param edit posted no thumbnail request — the counter is not wired')
    })

    // Undo of an unrelated edit leaves the section alone.
    await page.evaluate(() => (window as Any).__sombra.stores.graph.getState().undo())
    await page.waitForTimeout(300)
    const afterUndo = await headerState()
    const undoneParam = await page.evaluate((nz) => (window as Any).__sombra.stores.graph.getState().nodes.find((n: Any) => n.id === nz).data.params.noiseType, ids.nz)
    test('undo of an unrelated edit does not toggle the section', () => {
      assert(undoneParam !== 'value', 'fixture: the undo did not revert the noise edit — proves nothing')
      assert(afterUndo.open, 'undo collapsed the section')
    })

    // Reload: localStorage keeps the (non-default) open state.
    await page.reload()
    await boot()
    await page.waitForTimeout(800)
    const reloadedOpen = await headerState()
    const otherNodes = (await graph()).nodes.filter((n) => n.id !== ids.st)
    // Then collapse, reload again: collapsed.
    const tb2 = await centre(toggleBtn)
    if (tb2) await page.mouse.click(tb2.x, tb2.y)
    await page.waitForTimeout(300)
    await page.reload()
    await boot()
    await page.waitForTimeout(800)
    const reloadedCollapsed = await headerState()
    const stUi = (await graph()).nodes.find((n) => n.id === ids.st)?.ui
    test('reload: open stays open, collapsed stays collapsed; untouched nodes carry no ui', () => {
      assert(reloadedOpen.open, 'the open section came back collapsed after a reload (localStorage dropped it)')
      assert(!reloadedCollapsed.open, 'the collapsed section came back open after a reload')
      assert(stUi === undefined, `collapsed = default, yet ui is stored: ${JSON.stringify(stUi)}`)
      assert(otherNodes.every((n) => n.ui === undefined), `untouched nodes gained ui: ${JSON.stringify(otherNodes.filter((n) => n.ui))}`)
    })

    // .sombra package: open it, export → encode → decode → import into a cleared graph.
    const tb3 = await centre(toggleBtn)
    if (tb3) await page.mouse.click(tb3.x, tb3.y)
    await page.waitForTimeout(300)
    const fileOpen = await page.evaluate(async (st) => {
      const s = (window as Any).__sombra
      const f = await import('/src/utils/sombra-file.ts' as string)
      const bytes = f.encodeSombraPackage(s.exportGraph())
      s.clearGraph()
      await new Promise((r) => setTimeout(r, 300))
      const gone = !document.querySelector(`.react-flow__node[data-id="${st}"]`)
      s.importGraph(f.decodeSombraPackage(bytes))
      await new Promise((r) => setTimeout(r, 600))
      const btn = document.querySelector(`.react-flow__node[data-id="${st}"] button[aria-expanded]`)
      return { gone, open: btn?.getAttribute('aria-expanded') === 'true', bytes: bytes.length }
    }, ids.st)
    test('.sombra export → import: the open section is still open', () => {
      assert(fileOpen.gone, 'fixture: clearGraph did not remove the node — import proves nothing')
      assert(fileOpen.open, 'the section came back collapsed from the .sombra file')
    })

    // ── 5. Rename ────────────────────────────────────────────────────────────
    await page.waitForTimeout(1200)
    const titleSel = (id: string) => `${nodeSel(id)} [data-slot="node-title"]`
    const pencilSel = (id: string) => `${nodeSel(id)} [data-slot="node-title-pencil"]`
    const renameVia = async (id: string, text: string, how: 'enter' | 'away' | 'escape') => {
      const t = await centre(titleSel(id))
      if (!t) return false
      await page.mouse.move(t.x, t.y, { steps: 3 })
      await page.waitForTimeout(250)
      const p = await centre(pencilSel(id))
      if (!p) return false
      await page.mouse.click(p.x, p.y)
      await page.waitForTimeout(100)
      await page.keyboard.type(text)
      if (how === 'enter') await page.keyboard.press('Enter')
      else if (how === 'escape') await page.keyboard.press('Escape')
      else {
        const pane = await page.evaluate(() => { const r = document.querySelector('.react-flow')!.getBoundingClientRect(); return { x: r.right - 40, y: r.bottom - 200 } })
        await page.mouse.click(pane.x, pane.y)
      }
      await page.waitForTimeout(200)
      return true
    }
    const label = async (id: string) => (await graph()).nodes.find((n) => n.id === id)?.label
    const warned = (id: string) => page.evaluate((sel) => !!document.querySelector(`${sel} [data-slot="node-title-warning"]`), nodeSel(id))

    const r0 = await counts(), p0 = (await graph()).past
    // Hover → pencil visible (screenshot), then edit.
    const tt = await centre(titleSel(ids.num))
    if (tt) await page.mouse.move(tt.x, tt.y, { steps: 3 })
    await page.waitForTimeout(600)              // the pencil fades in (CSS transition)
    const pencilOpacity = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? Number(getComputedStyle(el).opacity) : -1 }, pencilSel(ids.num))
    const okEnter = await renameVia(ids.num, 'site.balance', 'enter')
    await page.waitForTimeout(1200)
    const r1 = await counts(), p1 = (await graph()).past
    const named = await label(ids.num)
    const header = await page.evaluate((sel) => { const h = document.querySelector(`${sel} header`)!.getBoundingClientRect(); return h.height }, nodeSel(ids.num))
    const zoom = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform).a)
    const tt2 = await centre(titleSel(ids.num))
    if (tt2) await page.mouse.move(tt2.x, tt2.y, { steps: 3 })
    await page.waitForTimeout(600)
    await shot('renamed-pencil-hover', [ids.num])
    await page.evaluate(() => (window as Any).__sombra.stores.graph.getState().undo())
    await page.waitForTimeout(300)
    const undone = await label(ids.num), pU = (await graph()).past
    test('rename via pencil + Enter: saved; one undo reverts; header stays 32; no compile, no thumbnail', () => {
      assert(pencilOpacity === 1, `pencil opacity on title hover = ${pencilOpacity}`)
      assert(okEnter, 'title / pencil not found')
      assert(named === 'site.balance', `stored label ${JSON.stringify(named)}`)
      assert(p1 === p0 + 1, `the rename made ${p1 - p0} history entries`)
      assert(undone === undefined && pU === p0, `one undo left label ${JSON.stringify(undone)} (history ${pU} vs ${p0})`)
      assert(Math.abs(header / zoom - 32) < 0.5, `header is ${(header / zoom).toFixed(1)} high`)
      assert(r1.compile === r0.compile, `the rename posted ${r1.compile - r0.compile} recompile(s)`)
      assert(r1.preview.length === r0.preview.length, `the rename posted ${r1.preview.length - r0.preview.length} thumbnail request(s): ${r1.preview.slice(r0.preview.length)}`)
    })

    // Duplicates: two nodes whose names share a knob-key slug.
    await renameVia(ids.num, 'site.balance', 'enter')
    await renameVia(ids.num2, 'Site Balance', 'enter')
    await page.waitForTimeout(200)
    const dupBoth = [await warned(ids.num), await warned(ids.num2), await warned(ids.time)]
    await page.mouse.move(5, 5)
    await page.waitForTimeout(500)               // let the pencil fade out
    await shot('duplicate-pair', [ids.num, ids.num2])
    await page.evaluate((id) => (window as Any).__sombra.renameNode(id, ''), ids.num2)
    await page.waitForTimeout(200)
    const dupCleared = [await warned(ids.num), await warned(ids.num2)]
    test('duplicate names: both nodes warn; clearing one clears both', () => {
      assert(dupBoth[0] && dupBoth[1], `warnings ${dupBoth.slice(0, 2)} — expected both`)
      assert(!dupBoth[2], 'an unnamed node warned')
      assert(!dupCleared[0] && !dupCleared[1], `after clearing one: ${dupCleared}`)
    })

    // Click-away saves, Escape cancels.
    await renameVia(ids.time, 'site.clock', 'away')
    const away = await label(ids.time)
    await renameVia(ids.time, 'nope', 'escape')
    const esc = await label(ids.time)
    test('click-away saves; Escape cancels', () => {
      assert(away === 'site.clock', `click-away stored ${JSON.stringify(away)}`)
      assert(esc === 'site.clock', `Escape stored ${JSON.stringify(esc)}`)
    })

    // Backspace in the field does not delete the node (control: outside it does).
    const t3 = await centre(titleSel(ids.nz))
    if (t3) { await page.mouse.move(t3.x, t3.y, { steps: 3 }); await page.waitForTimeout(250) }
    const p3 = await centre(pencilSel(ids.nz))
    if (p3) await page.mouse.click(p3.x, p3.y)
    await page.waitForTimeout(100)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const nzAlive = (await graph()).nodes.some((n) => n.id === ids.nz)
    // Control: select the node by clicking its title, Backspace outside any field deletes it.
    const t4 = await centre(`${nodeSel(ids.nz)} [data-slot="node-title-name"]`)
    if (t4) await page.mouse.click(t4.x, t4.y)
    await page.waitForTimeout(150)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(300)
    const nzDeleted = !(await graph()).nodes.some((n) => n.id === ids.nz)
    test('Backspace / Delete in the field do not delete the node (outside it, Backspace does)', () => {
      assert(p3, 'pencil not found')
      assert(nzAlive, 'Backspace/Delete in the rename field deleted the node')
      assert(nzDeleted, 'control: Backspace on the selected node did not delete it — the check above proves nothing')
    })

    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join(' | ')))
    await run('node-sections-ui')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
