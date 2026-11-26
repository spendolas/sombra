/**
 * The Wired Param Row, plugged into the LIVE editor (step one: direct constant sources).
 *
 * Real graph in headless Chrome on a Dots node:
 *  - Number → Gap X, Random → Softness, Color → Color A, Number → Transform scale:
 *    each param shows the Wired Param Row with the value the wire actually delivers
 *    (the exact number, the Random node's own readout, the hex), the source "← Node.output",
 *    the param's own React Flow handle inside the row, and no slider / input on the row.
 *  - Honesty controls: Time → Aspect (no single value) and a Random whose Min is wired
 *    into Gap Y (not constant) keep the plain "← Source" header — no row, no invented number.
 *  - Mechanism: changing the Number node's value changes the row's text. Heights are CSS px
 *    (divided by the canvas zoom): every slider row, wired or not, body or Transform, is Figma's
 *    fixed 50 px Connectable Param Row (106:303), so wiring a param never moves the rows below.
 *
 * Run: npm run verify:wired-row-editor-ui   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' })
    await page.goto(url)
    await page.waitForFunction(() => !!(window as Any).__sombra?.renderer, null, { timeout: 30000 })
    await page.waitForTimeout(500)

    // Fixture: unwired first, so the unwired row heights can be measured.
    const ids = await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 900, y: 0 })
      const dots = s.createNode('dots', { x: 420, y: 0 })
      s.connect(dots, out, 'color', 'color')
      const num = s.createNode('float_constant', { x: 0, y: 0 }, { value: 37 })
      const num2 = s.createNode('float_constant', { x: 0, y: 150 }, { value: 1.5 })
      const rnd = s.createNode('random', { x: 0, y: 300 }, { min: 0, max: 0.5, decimals: 2, seed: 0.37 })
      const col = s.createNode('color_constant', { x: 0, y: 460 }, { color: [1, 0, 0, 0.5] })
      const time = s.createNode('time', { x: 0, y: 620 })
      const minSrc = s.createNode('float_constant', { x: 0, y: 760 }, { value: 2 })
      const rnd2 = s.createNode('random', { x: 0, y: 900 }, { seed: 0.5 })
      return { out, dots, num, num2, rnd, col, time, minSrc, rnd2 }
    })
    await page.waitForTimeout(1200)

    const rowHeights = () => page.evaluate((dots) => {
      const n = document.querySelector(`.react-flow__node[data-id="${dots}"]`)! as HTMLElement
      const zoom = n.getBoundingClientRect().width / n.offsetWidth
      const handles = [...n.querySelectorAll('.react-flow__handle.target')]
      const h: Record<string, number> = {}
      for (const el of handles) {
        const id = el.getAttribute('data-handleid')!
        let row = el.closest('[data-wired]') as HTMLElement | null
        // Unwired: the handle's parent is the DS param row.
        if (!row) row = el.parentElement
        if (!row) continue
        h[id] = row.getBoundingClientRect().height / zoom
      }
      return h
    }, ids.dots)
    // Open the Transform section if it is collapsed, so its rows are mounted (before AND after wiring).
    await page.evaluate((dots) => {
      const n = document.querySelector(`.react-flow__node[data-id="${dots}"]`)!
      const b = n.querySelector('button[aria-expanded="false"]') as HTMLElement | null
      b?.click()
    }, ids.dots)
    await page.waitForTimeout(500)

    const before = await rowHeights()

    await page.evaluate((i) => {
      const s = (window as Any).__sombra
      s.connect(i.num, i.dots, 'value', 'gapX')
      s.connect(i.rnd, i.dots, 'value', 'softness')
      s.connect(i.col, i.dots, 'color', 'colorA')
      s.connect(i.num2, i.dots, 'value', 'srt_scale')
      s.connect(i.time, i.dots, 'time', 'aspect')
      s.connect(i.minSrc, i.rnd2, 'value', 'min')
      s.connect(i.rnd2, i.dots, 'value', 'gapY')
    }, ids)
    await page.waitForTimeout(1200)

    const rowOf = (param: string) => page.evaluate(({ dots, param }) => {
      const n = document.querySelector(`.react-flow__node[data-id="${dots}"]`)! as HTMLElement
      const zoom = n.getBoundingClientRect().width / n.offsetWidth
      const handle = n.querySelector(`.react-flow__handle.target[data-handleid="${param}"]`)
      const row = handle?.closest('[data-wired]') as HTMLElement | null
      const rowBox = (row ?? handle?.parentElement) as HTMLElement | undefined
      return {
        hasHandle: !!handle,
        isRow: !!row,
        mode: row?.getAttribute('data-mode') ?? null,
        kind: row?.getAttribute('data-wired') ?? null,
        text: row?.innerText.replace(/\s+/g, ' ').trim() ?? (rowBox?.innerText.replace(/\s+/g, ' ').trim() ?? ''),
        value: row?.querySelector('[data-part=value]')?.textContent ?? null,
        aria: row?.getAttribute('aria-label') ?? null,
        editable: row ? row.querySelectorAll('input, [role=slider], button').length : null,
        height: rowBox ? rowBox.getBoundingClientRect().height / zoom : null,
      }
    }, { dots: ids.dots, param })

    const randomReadout = () => page.evaluate((rnd) => {
      const n = document.querySelector(`.react-flow__node[data-id="${rnd}"]`)!
      const m = n.innerText.match(/-?\d+\.\d+/)
      return m ? m[0] : null
    }, ids.rnd)

    const gap = await rowOf('gapX')
    const soft = await rowOf('softness')
    const colr = await rowOf('colorA')
    const scale = await rowOf('srt_scale')
    const time = await rowOf('aspect')
    const rnd2 = await rowOf('gapY')
    const readout = await randomReadout()

    test('Number → Gap X: a constant row with the exact number, the source, and its own handle', () => {
      assert(gap.isRow && gap.mode === 'constant' && gap.kind === 'float', `not a constant float row: ${JSON.stringify(gap)}`)
      assert(gap.value === '37', `value ${gap.value}`)
      assert(/← Number\.value/.test(gap.text), `source text missing: ${gap.text}`)
      assert(gap.hasHandle, 'the param handle is not inside the row')
      assert(gap.editable === 0, `row has ${gap.editable} editable controls`)
    })
    test("Random → Softness: the row shows the Random node's own readout", () => {
      assert(soft.isRow && soft.mode === 'constant', `not a constant row: ${JSON.stringify(soft)}`)
      assert(readout !== null, 'could not read the Random node readout (control)')
      assert(soft.value === readout, `row ${soft.value} vs Random readout ${readout}`)
    })
    test('Color → Color A: swatch + hex with alpha', () => {
      assert(colr.isRow && colr.kind === 'color' && colr.mode === 'constant', `not a constant colour row: ${JSON.stringify(colr)}`)
      assert(colr.value === '#FF000080', `hex ${colr.value}`)
    })
    test('Number → Transform scale: the same row inside the Transform section', () => {
      assert(scale.isRow && scale.value === '1.50', `scale row: ${JSON.stringify(scale)}`)
    })
    test('honesty: Time → Aspect keeps the plain "← Source" header, no row, no invented value', () => {
      assert(time.hasHandle, 'Aspect handle missing')
      assert(!time.isRow, 'a wired row appeared for a time-driven source')
      assert(/← Time/.test(time.text), `header missing: ${time.text}`)
    })
    test('honesty: a Random with a wired Min is not constant → plain header', () => {
      assert(rnd2.hasHandle && !rnd2.isRow, `unexpected: ${JSON.stringify(rnd2)}`)
      assert(/← Random/.test(rnd2.text), `header missing: ${rnd2.text}`)
    })
    test('heights (CSS px): every slider row is 50, wired or not — wiring moves nothing', () => {
      const near = (a: number | null | undefined, b: number, m: string) => assert(a != null && Math.abs(a - b) <= 1, `${m}: ${a} vs ${b}`)
      near(before.srt_scale, 50, 'unwired Transform row')
      near(scale.height, 50, 'wired Transform row')
      near(before.gapX, 50, 'unwired body row')
      near(gap.height, 50, 'wired body row')
      near(soft.height, 50, 'wired body row (Softness)')
    })

    // Mechanism: the row follows the source node's value.
    await page.evaluate((i) => (window as Any).__sombra.setParams(i.num, { value: 12 }), ids)
    await page.waitForTimeout(500)
    const gap2 = await rowOf('gapX')
    test('mechanism: editing the Number node changes the row (and only then)', () => {
      assert(gap.value === '37' && gap2.value === '12', `row went ${gap.value} → ${gap2.value}`)
    })

    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join(' | ')))
    await run('wired-row-editor-ui')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
