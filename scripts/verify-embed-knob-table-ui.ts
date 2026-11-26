/**
 * The knob table wired into the REAL Embed modal: the live editor, graphs built
 * through window.__sombra, the modal opened by a real click on the toolbar's
 * "Embed on a website" button, and every check read from the modal's DOM
 * against an oracle computed independently in the page (publishScene on the
 * store's current graph — the same function the modal publishes with).
 *
 * Scenes:
 *   site      the site-base fixture (scripts/lib/site-base-fixture.ts): 28
 *             knobs, named ones interleaved with auto-named ones in graph
 *             order, so the named-first sort has work to do; more than eleven
 *             rows, so the table body scrolls.
 *   renamed   the same graph after renaming site.balance → site.weight: rows
 *             must follow the graph (a manifest kept from the previous open
 *             would still say site-balance-value).
 *   clash     two Numbers both labelled "site.balance": the notice names the
 *             clash and the numbered key, the mark sits on that row only.
 *   labelled  one Color labelled "hero.tint" at alpha 0.5 plus an unlabelled
 *             Noise: named first, and the swatch shows α 0.50.
 *   empty     Resolution → Split → Fragment Output colour + alpha: no knob at
 *             all (precondition: the manifest is empty).
 *
 * For each: rows equal the manifest keys (named first; Fragment Output's knobs
 * ride with the named ones, as on the board), defaults and ranges equal an
 * independent formatter, notice/marks only where a clash exists, and the table
 * sits inside the "Control it from JavaScript" section, after the hint line and
 * before the Inline option. On the site scene also: a real click copies exactly
 * the key (navigator.clipboard), the snippet button shares the clipboard path,
 * the body scrolls under a header that stays put, the modal scrolls to its last
 * option, nothing overflows sideways at the real modal width and at a narrow
 * window. No console errors anywhere.
 *
 * EMBED_KNOB_SHOTS=<dir> also writes one screenshot per state (taller window,
 * so the whole modal fits) for comparison with the Figma board.
 *
 * Run: npm run verify:embed-knob-table-ui   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS = process.env.EMBED_KNOB_SHOTS ? resolve(process.env.EMBED_KNOB_SHOTS) : null
const EMPTY_TEXT = 'This scene has no knobs: hosts can show it, but there is nothing to drive.'
const CLASH_NOTICE = 'Two nodes are named “site.balance”. The second one publishes as site-balance-2-value. ' +
  'Rename one of them so each key stays the one you meant.'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Row { key: string; named: boolean; type: string; def: string; range: string; swatch: string | null; clash: boolean; clashHint: string }
interface Snapshot {
  manifestKeys: string[]
  expectedKeys: string[]
  expectedNamed: Record<string, boolean>
  expectedDef: Record<string, string>
  expectedRange: Record<string, string>
  expectedType: Record<string, string>
  clashNodeKeys: string[]
  rows: Row[]
  title: string
  copyHint: boolean
  divider: boolean
  notice: string | null
  empty: string | null
  header: boolean
  footnote: string | null
  /** DOM ancestry */
  inSection: boolean
  sectionHasControlSnippet: boolean
  afterHint: boolean
  beforeInline: boolean
  tableCount: number
}

/** Everything the checks read, gathered in one page task. */
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const s = (window as Any).__sombra
    const { publishScene } = await import(/* @vite-ignore */ String('/src/embed/publish.ts'))
    const { nodes, edges } = s.stores.graph.getState()
    const r = publishScene(nodes, edges)
    // --- the oracle (independent of KnobTable's own formatting code) ---------
    const MINUS = '−'
    const num = (n: number) => {
      const t = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)))
      return t === '-0' ? '0' : t.replace(/^-/, MINUS)
    }
    const hex2 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0').toUpperCase()
    const def = (k: Any) => k.type === 'color'
      ? `#${hex2(k.default[0])}${hex2(k.default[1])}${hex2(k.default[2])} α ${(k.default.length > 3 ? Math.min(1, Math.max(0, k.default[3])) : 1).toFixed(2)}`
      : Array.isArray(k.default) ? k.default.map(num).join(', ') : num(k.default)
    const isNamed = (k: Any) => k.named === true || k.nodeType === 'fragment_output'
    const manifest = r.manifest as Any[]
    const clashIds = new Set((r.clashes as Any[]).map((c) => c.nodeId))
    const expected = [...manifest.filter(isNamed), ...manifest.filter((k) => !isNamed(k))]
    // --- the modal -----------------------------------------------------------
    const table = document.querySelector('[data-part="knob-table"]')
    const rows: Row[] = [...document.querySelectorAll('[data-knob-key]')].map((el) => {
      const sw = el.querySelector('[data-part="swatch-color"]') as HTMLElement | null
      return {
        key: el.getAttribute('data-knob-key')!,
        named: el.getAttribute('data-named') === 'true',
        type: el.querySelector('[data-part="type"]')?.textContent ?? '',
        def: el.querySelector('[data-part="default"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        range: el.querySelector('[data-part="range"]')?.textContent ?? '',
        swatch: sw ? getComputedStyle(sw).backgroundColor : null,
        clash: !!el.querySelector('[data-part="clash-icon"]'),
        clashHint: el.querySelector('[data-part="clash-hint"]')?.textContent ?? '',
      }
    })
    const section = table?.closest('[data-section="control"]') ?? null
    const hint = [...(section?.querySelectorAll('div') ?? [])].find((d) => d.textContent?.startsWith('List controllable params at runtime')) ?? null
    const inline = [...document.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent?.startsWith('Inline')) ?? null
    const follows = (a: Node | null, b: Node | null) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    return {
      manifestKeys: manifest.map((k) => k.key),
      expectedKeys: expected.map((k) => k.key),
      expectedNamed: Object.fromEntries(manifest.map((k) => [k.key, isNamed(k)])),
      expectedDef: Object.fromEntries(manifest.map((k) => [k.key, def(k)])),
      expectedRange: Object.fromEntries(manifest.map((k) => [k.key, k.min != null && k.max != null ? `${num(k.min)} – ${num(k.max)}` : '—'])),
      expectedType: Object.fromEntries(manifest.map((k) => [k.key, k.type])),
      clashNodeKeys: manifest.filter((k) => clashIds.has(k.nodeId)).map((k) => k.key),
      rows,
      title: table?.querySelector('[data-part="title"]')?.textContent ?? '',
      copyHint: !!table && [...table.querySelectorAll('span')].some((x) => x.textContent === 'Click a name to edit it · click a key to copy it'),
      divider: !!table?.querySelector('[data-part="divider"]'),
      notice: table?.querySelector('[data-part="notice"]')?.textContent ?? null,
      empty: table?.querySelector('[data-part="empty"]')?.textContent ?? null,
      header: !!table?.querySelector('[data-part="header"]'),
      footnote: [...(table?.querySelectorAll('p') ?? [])].find((p) => p.textContent?.startsWith('Named nodes come first'))?.textContent ?? null,
      inSection: !!section,
      sectionHasControlSnippet: !!section?.querySelector('[aria-label="Copy control snippet"]'),
      afterHint: follows(hint, table),
      beforeInline: follows(table, inline),
      tableCount: document.querySelectorAll('[data-part="knob-table"]').length,
    }
  })
}

/** Checks every scene gets: rows = manifest (named first), formatting, placement. */
function commonChecks(name: string, v: Snapshot, opts: { clash: boolean }) {
  test(`${name}: exactly one knob table, inside the JavaScript section, after the hint, before Inline`, () => {
    assert(v.tableCount === 1, `${v.tableCount} knob tables in the page`)
    assert(v.inSection, 'the knob table is not inside [data-section="control"]')
    assert(v.sectionHasControlSnippet, 'the section holding the table has no control snippet — wrong section')
    assert(v.afterHint, 'the table does not come after the shader.nodes() hint line')
    assert(v.beforeInline, 'the table does not come before the Inline option')
  })
  test(`${name}: rows are the manifest keys, named first, then the rest, each in graph order`, () => {
    const keys = v.rows.map((r) => r.key)
    assert(JSON.stringify(keys) === JSON.stringify(v.expectedKeys), `rows ${JSON.stringify(keys)}\n  expected ${JSON.stringify(v.expectedKeys)}`)
    assert(new Set(keys).size === v.manifestKeys.length && v.manifestKeys.every((k) => keys.includes(k)), 'rows and manifest are not the same set')
    assert(v.title === `Knobs · ${v.manifestKeys.length}`, `title "${v.title}"`)
    for (const r of v.rows) assert(r.named === v.expectedNamed[r.key], `${r.key}: named ${r.named}, manifest says ${v.expectedNamed[r.key]}`)
    const groups = new Set(Object.values(v.expectedNamed))
    assert(v.divider === (groups.size === 2), `divider ${v.divider} with ${groups.size} group(s)`)
  })
  test(`${name}: type, default (colours as #RRGGBB α) and range match the manifest`, () => {
    for (const r of v.rows) {
      assert(r.type === v.expectedType[r.key], `${r.key}: type "${r.type}" vs "${v.expectedType[r.key]}"`)
      assert(r.def === v.expectedDef[r.key], `${r.key}: default "${r.def}" vs "${v.expectedDef[r.key]}"`)
      assert(r.range === v.expectedRange[r.key], `${r.key}: range "${r.range}" vs "${v.expectedRange[r.key]}"`)
      assert((r.swatch !== null) === (v.expectedType[r.key] === 'color'), `${r.key}: swatch ${r.swatch} on a ${v.expectedType[r.key]}`)
    }
  })
  if (!opts.clash) {
    test(`${name}: no clash notice and no clash mark`, () => {
      assert(v.notice === null, `notice shown: "${v.notice}"`)
      assert(!v.rows.some((r) => r.clash), `clash mark on ${v.rows.filter((r) => r.clash).map((r) => r.key)}`)
      assert(v.clashNodeKeys.length === 0, `fixture: publishScene reports clashes ${v.clashNodeKeys}`)
    })
  }
}

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.replace(/\/$/, '') })
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.goto(url)
    await page.waitForFunction(() => !!(window as Any).__sombra?.renderer, null, { timeout: 30000 })
    // The error listener really listens: a probe must land in it (then is dropped).
    await page.evaluate(() => console.error('__probe__'))
    await page.waitForTimeout(50)
    const probeHeard = errors.some((e) => e.includes('__probe__'))
    errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('__probe__')))

    const click = async (sel: string) => {
      await page.locator(sel).first().scrollIntoViewIfNeeded()
      const b = await page.locator(sel).first().boundingBox()
      if (!b) throw new Error(`${sel}: not on screen`)
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 })
      await page.mouse.down(); await page.mouse.up()
    }
    const openModal = async () => {
      await click('button[title="Embed on a website"]')
      await page.waitForSelector('[data-part="knob-table"]', { timeout: 10000 })
      await page.waitForTimeout(300)
    }
    const closeModal = async () => {
      await click('button:has-text("✕")')
      await page.waitForSelector('[data-part="knob-table"]', { state: 'detached', timeout: 5000 })
    }
    const settle = () => page.waitForTimeout(700)

    // ---- site ----------------------------------------------------------------
    await page.evaluate(async () => {
      const s = (window as Any).__sombra
      const { buildSiteBase } = await import(/* @vite-ignore */ String('/scripts/lib/site-base-fixture.ts'))
      s.importGraph(buildSiteBase())
    })
    await settle()
    await openModal()
    const site = await snapshot(page)
    commonChecks('site', site, { clash: false })
    test('site: fixture engages the mechanism — a named key follows an auto key in graph order, and >11 rows', () => {
      const firstAuto = site.manifestKeys.findIndex((k) => !site.expectedNamed[k])
      const lastNamed = site.manifestKeys.map((k) => site.expectedNamed[k]).lastIndexOf(true)
      assert(firstAuto >= 0 && lastNamed > firstAuto, `manifest order ${JSON.stringify(site.manifestKeys)} needs no sort`)
      assert(site.rows.length > 11, `${site.rows.length} rows — the body would not scroll`)
      for (const k of ['site-clock-speed', 'site-balance-value', 'site-palette-stop-1', 'fragment-output-alpha']) {
        assert(site.rows.find((r) => r.key === k)?.named === true, `${k} is not in the named group`)
      }
      assert(site.rows.find((r) => r.key === 'site-palette-stop-1')?.def === '#FF4F5E α 1.00', 'stop 1 default is not #FF4F5E α 1.00')
      assert(site.copyHint && site.header && site.footnote !== null && site.empty === null, 'header line / column header / footnote missing, or the empty line shown')
    })

    // Copy: real clicks; the clipboard must hold exactly the key.
    const clip = (t: string) => page.evaluate((x) => navigator.clipboard.writeText(x), t)
    const readClip = () => page.evaluate(() => navigator.clipboard.readText())
    await clip('sentinel')
    await page.locator('[data-knob-key="site-balance-value"]').scrollIntoViewIfNeeded()
    await click('[data-knob-key="site-balance-value"] [data-part="key"]')
    await page.waitForTimeout(150)
    const copiedNamed = await readClip()
    const copiedShown = await page.locator('[data-knob-key="site-balance-value"] [data-part="copied"]').count()
    await clip('sentinel')
    // Click on the DEFAULT cell of an auto row: nothing is copied (only the key cell copies)...
    await page.locator('[data-knob-key="fbm-octaves"]').scrollIntoViewIfNeeded()
    await click('[data-knob-key="fbm-octaves"] [data-part="default"]')
    await page.waitForTimeout(150)
    const copiedFromDefault = await readClip()
    // ...and a click on its key copies exactly the key.
    await click('[data-knob-key="fbm-octaves"] [data-part="key"]')
    await page.waitForTimeout(150)
    const copiedAuto = await readClip()
    await clip('sentinel')
    await page.locator('[aria-label="Copy control snippet"]').scrollIntoViewIfNeeded()
    await click('[aria-label="Copy control snippet"]')
    await page.waitForTimeout(150)
    const copiedSnippet = await readClip()
    const controlText = await page.locator('[data-section="control"] pre').first().textContent()
    test('site: a click copies exactly the key to the system clipboard, and shows "Copied"', () => {
      assert(copiedNamed === 'site-balance-value', `clipboard holds ${JSON.stringify(copiedNamed)} after clicking site-balance-value`)
      assert(copiedShown === 1, '"Copied" not shown on the clicked row')
      assert(copiedFromDefault === 'sentinel', `a click on fbm-octaves' default cell copied ${JSON.stringify(copiedFromDefault)}`)
      assert(copiedAuto === 'fbm-octaves', `clipboard holds ${JSON.stringify(copiedAuto)} after clicking fbm-octaves' key`)
      assert(copiedSnippet === controlText, 'the control snippet button no longer copies its snippet (shared clipboard path)')
    })

    // Rename + hide through the real modal: the store takes the override, the
    // modal re-publishes, and the oracle (publishScene on the store) agrees.
    const nameSel = '[data-knob-key="site-balance-value"] [data-part="name"]'
    await click(nameSel)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.type('Amount')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-knob-key="site-balance-amount"]', { timeout: 5000 }).catch(() => {})
    await click('[data-knob-key="site-seed-value"] [data-part="visibility"]')
    await page.waitForSelector('[data-knob-key="site-seed-value"][data-hidden="true"]', { timeout: 5000 }).catch(() => {})
    const edited = await page.evaluate(async () => {
      const s = (window as Any).__sombra
      const { publishScene } = await import(/* @vite-ignore */ String('/src/embed/publish.ts'))
      const g = s.stores.graph.getState()
      const r = publishScene(g.nodes, g.edges)
      return {
        overrides: g.nodes.filter((n: Any) => n.data.knobs).map((n: Any) => n.data.knobs),
        past: g._past.length,
        oracle: (r.manifest as Any[]).map((k) => k.key),
        rows: [...document.querySelectorAll('[data-knob-key]')].map((e) => e.getAttribute('data-knob-key')),
        hiddenRows: [...document.querySelectorAll('[data-knob-key][data-hidden="true"]')].map((e) => e.getAttribute('data-knob-key')),
        footer: document.querySelector('[data-part="count"]')?.textContent ?? null,
      }
    })
    await page.evaluate(() => { const g = (window as Any).__sombra.stores.graph.getState(); g.undo(); g.undo() })
    await page.waitForSelector('[data-knob-key="site-balance-value"]', { timeout: 5000 }).catch(() => {})
    const undone = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-knob-key]')].map((e) => e.getAttribute('data-knob-key')),
      footer: !!document.querySelector('[data-part="footer"]'),
    }))
    test('site: renaming a knob in the modal stores it and the published key follows', () => {
      assert(edited.overrides.some((o: Any) => Object.values(o).some((v: Any) => v.name === 'Amount')), `store overrides: ${JSON.stringify(edited.overrides)}`)
      assert(edited.oracle.includes('site-balance-amount') && !edited.oracle.includes('site-balance-value'), 'publishScene does not carry the renamed key')
      assert(edited.rows.includes('site-balance-amount'), 'the modal row did not take the renamed key')
    })
    test('site: hiding a knob drops it from the published manifest, keeps the row, counts it', () => {
      assert(!edited.oracle.includes('site-seed-value'), 'the hidden knob is still published')
      assert(JSON.stringify(edited.hiddenRows) === '["site-seed-value"]', `hidden rows: ${JSON.stringify(edited.hiddenRows)}`)
      assert(edited.footer === `${edited.oracle.length} published · 1 hidden`, `footer: ${edited.footer} (published ${edited.oracle.length})`)
    })
    test('site: each edit is one undo step, and undo restores the table', () => {
      assert(undone.rows.includes('site-balance-value') && !undone.rows.includes('site-balance-amount'), 'undo did not restore the key')
      assert(!undone.footer, 'undo left a hidden knob')
    })

    // Geometry at the real modal width.
    const geo = async () => page.evaluate(() => {
      const table = document.querySelector('[data-part="knob-table"]') as HTMLElement
      let modal: HTMLElement | null = table.parentElement
      while (modal && !/(auto|scroll)/.test(getComputedStyle(modal).overflowY)) modal = modal.parentElement
      const body = table.querySelector('[data-part="body"]') as HTMLElement
      const header = table.querySelector('[data-part="header"]') as HTMLElement
      const tb = table.getBoundingClientRect()
      const rows = [...table.querySelectorAll('[data-knob-key]')] as HTMLElement[]
      const clipped = rows.flatMap((r) => [...r.children].slice(0, 4).map((c, i) => {
        const cr = c.getBoundingClientRect()
        // a fixed column (type/default/range) must sit wholly inside the row; the key may truncate
        return i > 0 && (cr.right > r.getBoundingClientRect().right + 0.5 || cr.width < 1) ? `${r.dataset.knobKey}#${i}` : ''
      })).filter(Boolean)
      const keyW = Math.min(...rows.map((r) => (r.querySelector('[data-part="key-cell"]') as HTMLElement).getBoundingClientRect().width))
      return {
        modalW: modal!.clientWidth, tableW: tb.width,
        modalOverflowX: modal!.scrollWidth - modal!.clientWidth,
        tableOverflowX: Math.max(table.scrollWidth - table.clientWidth, body.scrollWidth - body.clientWidth),
        modalScrolls: modal!.scrollHeight > modal!.clientHeight,
        bodyScrolls: body.scrollHeight > body.clientHeight,
        headerOutsideBody: !body.contains(header),
        clipped, keyW,
        /** Width the body reserves for its scrollbar (scrollbar-gutter: stable); 0 with overlay scrollbars. */
        gutter: body.offsetWidth - body.clientWidth,
      }
    })
    const g = await geo()
    test(`site: at the real modal width (table ${g.tableW}px in a ${g.modalW}px modal) nothing overflows sideways or clips`, () => {
      assert(g.modalOverflowX <= 0, `the modal scrolls sideways by ${g.modalOverflowX}px`)
      assert(g.tableOverflowX <= 0, `the table scrolls sideways by ${g.tableOverflowX}px`)
      assert(g.clipped.length === 0, `clipped cells: ${g.clipped.slice(0, 6).join(', ')}`)
      assert(g.keyW >= 200, `key column only ${g.keyW}px wide`)
      assert(g.modalScrolls && g.bodyScrolls && g.headerOutsideBody, `modal scrolls ${g.modalScrolls}, body scrolls ${g.bodyScrolls}, header outside body ${g.headerOutsideBody}`)
    })

    // Wheel over the table body: the body scrolls, the header stays painted where it was.
    const bodyBox = async () => page.evaluate(() => {
      const t = document.querySelector('[data-part="knob-table"]')!
      const b = t.querySelector('[data-part="body"]') as HTMLElement
      const h = t.querySelector('[data-part="header"]') as HTMLElement
      const hr = h.getBoundingClientRect(), br = b.getBoundingClientRect()
      const hit = document.elementFromPoint(hr.left + 20, hr.top + hr.height / 2)
      const last = b.lastElementChild!.getBoundingClientRect()
      return { scrollTop: b.scrollTop, headerTop: hr.top, bodyTop: br.top, headerHit: !!hit && h.contains(hit), max: b.scrollHeight - b.clientHeight, lastIn: last.bottom <= br.bottom + 0.5, x: br.left + br.width / 2, y: br.top + br.height / 2 }
    })
    await page.locator('[data-part="knob-table"] [data-part="body"]').scrollIntoViewIfNeeded()
    const b0 = await bodyBox()
    await page.mouse.move(b0.x, b0.y)
    for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(30) }
    await page.waitForTimeout(200)
    const b1 = await bodyBox()
    test('site: the table body scrolls under a header that stays put, down to its last row', () => {
      assert(b1.scrollTop > 0, 'wheel over the body did not scroll it')
      assert(Math.abs(b1.scrollTop - b1.max) <= 1 && b1.lastIn, `body stopped at ${b1.scrollTop}/${b1.max}; last row inside: ${b1.lastIn}`)
      assert(Math.abs((b1.headerTop - b1.bodyTop) - (b0.headerTop - b0.bodyTop)) < 0.5, 'the header moved relative to the body')
      assert(b0.headerHit && b1.headerHit, `header painted at its own position: before ${b0.headerHit}, after ${b1.headerHit}`)
    })

    // The modal itself scrolls to its last option without clipping it.
    const modalEnd = await page.evaluate(async () => {
      const table = document.querySelector('[data-part="knob-table"]') as HTMLElement
      let modal: HTMLElement | null = table.parentElement
      while (modal && !/(auto|scroll)/.test(getComputedStyle(modal).overflowY)) modal = modal.parentElement
      const m = modal!
      const head = m.querySelector('h2')!.getBoundingClientRect()
      return { x: head.left + 40, y: head.bottom + 4 }
    })
    await page.mouse.move(modalEnd.x, modalEnd.y)
    for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(30) }
    await page.waitForTimeout(300)
    const atEnd = await page.evaluate(() => {
      const table = document.querySelector('[data-part="knob-table"]') as HTMLElement
      let modal: HTMLElement | null = table.parentElement
      while (modal && !/(auto|scroll)/.test(getComputedStyle(modal).overflowY)) modal = modal.parentElement
      const m = modal!
      const last = [...m.querySelectorAll('details')].at(-1)!.querySelector('summary')!.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      return { scrolled: m.scrollTop, end: m.scrollHeight - m.clientHeight, lastIn: last.bottom <= mr.bottom && last.top >= mr.top }
    })
    test('site: the modal scrolls to its last option (Advanced) and shows it whole', () => {
      assert(atEnd.scrolled > 0 && Math.abs(atEnd.scrolled - atEnd.end) <= 1, `modal scrollTop ${atEnd.scrolled} of ${atEnd.end}`)
      assert(atEnd.lastIn, 'the Advanced summary is clipped at the bottom of the modal')
    })

    // Narrow window: 92vw cap.
    await page.setViewportSize({ width: 640, height: 900 })
    await page.waitForTimeout(300)
    const narrow = await geo()
    // Report only: where the fixed columns (type/default/range + reserved) stop fitting.
    await page.setViewportSize({ width: 480, height: 900 })
    await page.waitForTimeout(300)
    const tiny = await geo()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.waitForTimeout(200)
    test(`site: in a 640px window (table ${narrow.tableW}px) the fixed columns still fit and the key truncates`, () => {
      assert(narrow.modalOverflowX <= 0 && narrow.tableOverflowX <= 0, `sideways overflow: modal ${narrow.modalOverflowX}, table ${narrow.tableOverflowX}`)
      assert(narrow.clipped.length === 0, `clipped cells: ${narrow.clipped.slice(0, 6).join(', ')}`)
      assert(narrow.keyW >= 60, `key column only ${narrow.keyW}px wide`)
    })
    console.log(`  (window 1280: modal ${g.modalW}px, table ${g.tableW}px, key column ${g.keyW.toFixed(0)}px, scrollbar gutter ${g.gutter}px · window 640: table ${narrow.tableW.toFixed(0)}px, key column ${narrow.keyW.toFixed(0)}px` +
      ` · window 480 (report only): table ${tiny.tableW.toFixed(0)}px, key column ${tiny.keyW.toFixed(0)}px, clipped cells ${tiny.clipped.length})`)

    // ---- renamed: the rows follow the graph between opens ---------------------
    await closeModal()
    await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.renameNode('site-balance', 'site.weight')
    })
    await settle()
    await openModal()
    const renamed = await snapshot(page)
    commonChecks('renamed', renamed, { clash: false })
    test('renamed: reopening after a rename shows the new key, not the old one', () => {
      const keys = renamed.rows.map((r) => r.key)
      assert(keys.includes('site-weight-value'), `no site-weight-value row: ${JSON.stringify(keys)}`)
      assert(!keys.includes('site-balance-value'), 'site-balance-value is still listed — rows from a stale manifest')
    })
    await closeModal()

    // ---- clash ---------------------------------------------------------------
    await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 900, y: 0 })
      const a = s.createNode('float_constant', { x: 0, y: 0 }, { value: 0.25 })
      const b = s.createNode('float_constant', { x: 0, y: 200 }, { value: 0.5 })
      const n = s.createNode('noise', { x: 0, y: 400 })
      const add1 = s.createNode('arithmetic', { x: 300, y: 0 }, { operation: 'add' })
      const add2 = s.createNode('arithmetic', { x: 600, y: 0 }, { operation: 'add' })
      s.connect(n, add1, 'value', 'in_0'); s.connect(a, add1, 'value', 'in_1')
      s.connect(add1, add2, 'result', 'in_0'); s.connect(b, add2, 'value', 'in_1')
      s.connect(add2, out, 'result', 'color')
      s.renameNode(a, 'site.balance'); s.renameNode(b, 'site.balance')
    })
    await settle()
    await openModal()
    const clash = await snapshot(page)
    commonChecks('clash', clash, { clash: true })
    test('clash: the notice names the label and the numbered key; only that row is marked', () => {
      assert(JSON.stringify(clash.clashNodeKeys) === '["site-balance-2-value"]', `fixture: publishScene clash keys ${JSON.stringify(clash.clashNodeKeys)}`)
      assert(clash.notice === CLASH_NOTICE, `notice ${JSON.stringify(clash.notice)}`)
      const marked = clash.rows.filter((r) => r.clash).map((r) => r.key)
      assert(JSON.stringify(marked) === '["site-balance-2-value"]', `marked rows ${JSON.stringify(marked)}`)
      assert(clash.rows.find((r) => r.clash)?.clashHint === 'name clash, numbered', 'clash hint text')
    })
    await closeModal()

    // ---- labelled ------------------------------------------------------------
    await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 600, y: 0 })
      const n = s.createNode('noise', { x: 0, y: 300 })
      const tint = s.createNode('color_constant', { x: 0, y: 0 }, { color: [0.2, 0.6, 1, 0.5] })
      s.connect(n, out, 'value', 'alpha')
      s.connect(tint, out, 'color', 'color')
      s.renameNode(tint, 'hero.tint')
    })
    await settle()
    await openModal()
    const labelled = await snapshot(page)
    commonChecks('labelled', labelled, { clash: false })
    test('labelled: the named colour comes first and its swatch carries alpha 0.5', () => {
      assert(labelled.rows[0]?.key === 'hero-tint-color' && labelled.rows[0].named, `first row ${JSON.stringify(labelled.rows[0])}`)
      assert(labelled.manifestKeys[0] !== 'hero-tint-color', `fixture: the manifest already lists hero-tint-color first (${labelled.manifestKeys[0]}) — the sort is not exercised`)
      assert(labelled.rows[0].def === '#3399FF α 0.50', `default "${labelled.rows[0].def}"`)
      assert(labelled.rows[0].swatch === 'rgba(51, 153, 255, 0.5)', `swatch background ${labelled.rows[0].swatch}`)
      assert(labelled.rows.slice(1).every((r) => !r.named), 'an unlabelled Noise knob is in the named group')
    })
    await closeModal()

    // ---- empty ---------------------------------------------------------------
    await page.evaluate(() => {
      const s = (window as Any).__sombra
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 600, y: 0 })
      const res = s.createNode('resolution', { x: 0, y: 0 })
      const sp = s.createNode('split_vec2', { x: 300, y: 0 })
      s.connect(res, sp, 'resolution', 'vector')
      s.connect(sp, out, 'x', 'color')
      s.connect(sp, out, 'y', 'alpha')
    })
    await settle()
    await openModal()
    const empty = await snapshot(page)
    commonChecks('empty', empty, { clash: false })
    test('empty: one calm line instead of the table, still in the JavaScript section', () => {
      assert(empty.manifestKeys.length === 0, `fixture: the manifest has ${empty.manifestKeys.length} knobs`)
      assert(empty.empty === EMPTY_TEXT, `empty line ${JSON.stringify(empty.empty)}`)
      assert(!empty.header && empty.rows.length === 0 && !empty.copyHint && empty.footnote === null, 'table parts shown on an empty scene')
      assert(empty.title === 'Knobs · 0', `title "${empty.title}"`)
    })
    await closeModal()

    // ---- screenshots (optional) ----------------------------------------------
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true })
      await page.setViewportSize({ width: 1280, height: 1600 })
      const shoot = async (name: string, build: () => Promise<void>, after?: () => Promise<void>) => {
        await build(); await settle(); await openModal()
        await page.waitForTimeout(800)
        if (after) await after()
        const panel = page.locator('[data-part="knob-table"]').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]')
        await panel.screenshot({ path: `${SHOTS}/embed-knobs-${name}.png` })
        await closeModal()
      }
      const site = async () => { await page.evaluate(async () => { const { buildSiteBase } = await import(/* @vite-ignore */ String('/scripts/lib/site-base-fixture.ts')); (window as Any).__sombra.importGraph(buildSiteBase()) }) }
      await shoot('site', site)
      await shoot('copied', site, async () => {
        const b = await page.locator('[data-knob-key="site-seed-value"]').boundingBox()
        await page.mouse.move(b!.x + 60, b!.y + b!.height / 2); await page.mouse.down(); await page.mouse.up()
        await page.waitForTimeout(100)
      })
      await shoot('clash', async () => { await page.evaluate(async () => {
        const s = (window as Any).__sombra
        const { buildSiteBase } = await import(/* @vite-ignore */ String('/scripts/lib/site-base-fixture.ts'))
        // The board's clash: a second Number labelled site.balance, summed into the balance Add.
        s.importGraph(buildSiteBase())
        s.setParams('add', { inputCount: 3 })
        const extra = s.createNode('float_constant', { x: 260, y: 600 }, { value: 0.25 })
        s.renameNode(extra, 'site.balance')
        s.connect(extra, 'add', 'value', 'in_2')
      }) })
      await shoot('empty', async () => { await page.evaluate(() => {
        const s = (window as Any).__sombra
        s.clearGraph()
        const out = s.createNode('fragment_output', { x: 600, y: 0 })
        const res = s.createNode('resolution', { x: 0, y: 0 })
        const sp = s.createNode('split_vec2', { x: 300, y: 0 })
        s.connect(res, sp, 'resolution', 'vector'); s.connect(sp, out, 'x', 'color'); s.connect(sp, out, 'y', 'alpha')
      }) })
      console.log(`  screenshots → ${SHOTS}`)
    }

    test('no console errors or page errors (and the listener heard a probe error)', () => {
      assert(probeHeard, 'the console listener did not hear console.error — this check would pass blind')
      assert(errors.length === 0, errors.slice(0, 5).join(' | '))
    })
    await run('embed-knob-table-ui')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
