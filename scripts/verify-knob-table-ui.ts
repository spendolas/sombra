/**
 * The knob table, driven through its real sandbox harness with a real mouse.
 *
 * The table is what an embed author reads to learn which keys `shader.set()`
 * takes, so each behaviour the Figma board (993:3778) settles is checked by
 * the mechanism that produces it, not by a picture that would look the same if
 * the mechanism were skipped:
 *
 *   order    rows come back named-first, then a divider, then the auto-named
 *            rest — and the fixture interleaves them in graph order, so the
 *            sort has work to do (proved by the "nothing named" fixture, which
 *            must keep graph order).
 *   swatch   the swatch's colour layer carries the knob's rgba, AND the pixels
 *            of a translucent swatch differ between checker squares while an
 *            opaque one's do not (the checker really shows through alpha).
 *   hover    the copy icon is absent (display:none) until the pointer is on
 *            the row, then sits after the key; the row takes the hover fill.
 *   copy     a click on the KEY hands onCopy exactly the key, and a click on
 *            the default next to it copies nothing (since rename + hide, only
 *            the key cell copies); "Copied" + check appear, are still there half way
 *            through the hold, and are gone after it. A refused copy shows no
 *            "Copied". The default path really reaches the system clipboard.
 *   scroll   60 rows: the body scrolls, the header does not, the header is not
 *            inside the scroll box, and after a wheel scroll the header is still
 *            what is painted at its own position while the first row has gone
 *            under it.
 *   clash    the notice names the label and the numbered key, is neutral (grey
 *            text on the raised surface, amber only on the icon), and only the
 *            numbered row carries the mark.
 *   empty    one calm line, no table.
 *   rename   typing in a Name field updates the key beside it live; Enter
 *            reports exactly (id, name) once and the key follows; Esc reports
 *            nothing and restores the key; the focused field has the indigo
 *            border.
 *   hide     the eye reports (id, true), the row dims to half opacity, the
 *            eye turns to eye-off (aria-pressed), and the footer counts
 *            published / hidden; a fixture with no hidden knob has no footer.
 *
 * Run: npm run verify:knob-table-ui   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { decodePng } from './blur-bakeoff/lib/png'

const ROOT = resolve(import.meta.dirname, '..')
const HOLD_MS = 400 // the harness's "copied for" — short so the revert is quick to observe

const SITE_ORDER = [
  'site-clock-speed', 'site-seed-value', 'site-balance-value', 'site-dots-pixel-size',
  'site-palette-stop-0', 'site-palette-stop-1', 'site-palette-stop-2', 'site-palette-stop-3',
  'fragment-output-alpha',
  'pixelate-pixel-size', 'fbm-octaves', 'fbm-lacunarity', 'fbm-gain',
]
const NAMED_COUNT = 9

let base = ''
let ctx: BrowserContext
let page: Page
let opens = 0
let loads = 0

declare global {
  interface Window { __knobCopies?: string[]; __knobEdits?: string[] }
}

async function open(query: string) {
  opens++
  await page.goto(`${base}knob-table-sandbox.html?${query}`)
  await page.waitForSelector('[data-part="knob-table"]')
}

/** A CSS custom property resolved to the computed `color` string the browser reports. */
async function token(name: string): Promise<string> {
  return page.evaluate((n) => {
    const s = document.createElement('span')
    s.style.color = `var(${n})`
    document.body.appendChild(s)
    const c = getComputedStyle(s).color
    s.remove()
    return c
  }, name)
}

const row = (key: string) => `[data-knob-key="${key}"]`

async function center(sel: string) {
  const b = await page.locator(sel).boundingBox()
  if (!b) throw new Error(`${sel} has no box`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b }
}

/** Mean |Δ| per channel between two pixels of an element screenshot. */
async function swatchQuadrantDelta(key: string): Promise<{ delta: number; tl: number[]; tr: number[] }> {
  const img = decodePng(new Uint8Array(await page.locator(`${row(key)} [data-part="swatch"]`).screenshot({ type: 'png' })))
  // 12 css px at dpr 2 → 24 px; 1 px border → inner 20, two 10-px checker squares per row.
  const px = (x: number, y: number) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]] }
  const q = Math.round(img.width / 4)
  const tl = px(q + 1, q + 1)
  const tr = px(img.width - q - 2, q + 1)
  return { delta: (Math.abs(tl[0] - tr[0]) + Math.abs(tl[1] - tr[1]) + Math.abs(tl[2] - tr[2])) / 3, tl, tr }
}

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    base = server.resolvedUrls?.local[0] ?? ''
    if (!base) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 })
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') })
    page = await ctx.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    page.on('load', () => { loads++ })
    // Warm Vite's dependency optimiser first: a cold optimise reloads the page
    // mid-test, which would reset the harness state under the assertions.
    await open('fixture=site')
    await page.waitForTimeout(800)
    await open('fixture=site')

    // ── order ──────────────────────────────────────────────────────────────
    await open('fixture=allAuto')
    const graphOrder = await page.$$eval('[data-knob-key]', (els) => els.map((e) => e.getAttribute('data-knob-key')))
    await open('fixture=site&copy=log')
    const body = await page.$$eval('[data-part="body"] > *', (els) =>
      els.map((e) => e.getAttribute('data-knob-key') ?? (e.getAttribute('data-part') === 'divider' ? '—divider—' : '?')))
    const keyColours = await page.$$eval('[data-knob-key] [data-part="key"]', (els) => els.map((e) => getComputedStyle(e).color))
    const [fgDim, fgSubtle] = [await token('--fg-dim'), await token('--fg-subtle')]

    test('order: named knobs first, one divider, then the auto-named rest', () => {
      const expected = [...SITE_ORDER.slice(0, NAMED_COUNT), '—divider—', ...SITE_ORDER.slice(NAMED_COUNT)]
      assert(JSON.stringify(body) === JSON.stringify(expected), `body reads\n    ${body.join(', ')}\n  expected\n    ${expected.join(', ')}`)
    })
    test('order: the fixture is interleaved, so the sort did real work', () => {
      // With nothing named the table keeps graph order — which must differ from
      // the sorted order, or the order check above proves nothing.
      assert(graphOrder.length === SITE_ORDER.length, `allAuto rendered ${graphOrder.length} rows`)
      assert(JSON.stringify(graphOrder) !== JSON.stringify(SITE_ORDER), 'graph order already equals named-first order')
      assert(graphOrder[1] === 'pixelate-pixel-size', `graph order starts ${graphOrder.slice(0, 3)} — expected an auto knob at index 1`)
    })
    test('order: auto-named keys are a step dimmer than named ones', () => {
      // Since rename + hide the Name column carries fg; keys sit one step below it.
      assert(fgSubtle !== fgDim, `tokens fg-dim and fg-subtle resolve the same (${fgDim})`)
      keyColours.slice(0, NAMED_COUNT).forEach((c, i) => assert(c === fgDim, `${SITE_ORDER[i]} key is ${c}, expected fg-dim ${fgDim}`))
      keyColours.slice(NAMED_COUNT).forEach((c, i) => assert(c === fgSubtle, `${SITE_ORDER[NAMED_COUNT + i]} key is ${c}, expected fg-subtle ${fgSubtle}`))
    })

    // ── swatch ─────────────────────────────────────────────────────────────
    const solidBg = await page.$eval(`${row('site-palette-stop-1')} [data-part="swatch-color"]`, (e) => getComputedStyle(e).backgroundColor)
    const solidText = await page.$eval(row('site-palette-stop-1'), (e) => e.textContent ?? '')
    const solidPixels = await swatchQuadrantDelta('site-palette-stop-1')
    await open('fixture=translucent&copy=log')
    const halfBg = await page.$eval(`${row('site-tint')} [data-part="swatch-color"]`, (e) => getComputedStyle(e).backgroundColor)
    const halfPixels = await swatchQuadrantDelta('site-tint')
    const clearPixels = await swatchQuadrantDelta('gradient-stop-1')
    const halfText = await page.$eval(row('site-tint'), (e) => e.textContent ?? '')

    test('swatch: the colour layer carries the knob default (#F2B33D, alpha 1)', () => {
      assert(solidBg === 'rgb(242, 179, 61)', `swatch colour is ${solidBg}`)
      assert(solidText.includes('#F2B33D') && solidText.includes('α 1.00'), `row text: ${solidText}`)
    })
    test('swatch: alpha 0.5 reaches the colour layer and the label', () => {
      assert(halfBg === 'rgba(232, 99, 143, 0.5)', `swatch colour is ${halfBg}`)
      assert(halfText.includes('#E8638F') && halfText.includes('α 0.50'), `row text: ${halfText}`)
    })
    test('swatch: the checkerboard shows through alpha < 1 and not through alpha 1 (pixels)', () => {
      assert(solidPixels.delta < 3, `opaque swatch differs across checker squares by ${solidPixels.delta.toFixed(1)} (${solidPixels.tl} vs ${solidPixels.tr})`)
      assert(halfPixels.delta > 8, `half-alpha swatch is flat across checker squares (Δ ${halfPixels.delta.toFixed(1)}: ${halfPixels.tl} vs ${halfPixels.tr})`)
      assert(clearPixels.delta > halfPixels.delta, `alpha 0 (Δ ${clearPixels.delta.toFixed(1)}) should show more checker than alpha 0.5 (Δ ${halfPixels.delta.toFixed(1)})`)
    })

    // ── hover ──────────────────────────────────────────────────────────────
    await open(`fixture=site&copy=log&copiedMs=${HOLD_MS}`)
    await page.mouse.move(5, 5)
    const iconBefore = await page.locator(`${row('site-balance-value')} [data-part="copy-icon"]`).boundingBox()
    const bgBefore = await page.$eval(row('site-balance-value'), (e) => getComputedStyle(e).backgroundColor)
    const target = await center(row('site-balance-value'))
    await page.mouse.move(target.x, target.y)
    await page.waitForTimeout(250) // transition-colors
    const iconAfter = await page.locator(`${row('site-balance-value')} [data-part="copy-icon"]`).boundingBox()
    const keyBox = await page.locator(`${row('site-balance-value')} [data-part="key"]`).boundingBox()
    const otherIcon = await page.locator(`${row('site-seed-value')} [data-part="copy-icon"]`).boundingBox()
    const bgAfter = await page.$eval(row('site-balance-value'), (e) => getComputedStyle(e).backgroundColor)
    const cursor = await page.$eval(`${row('site-balance-value')} [data-part="key-cell"]`, (e) => getComputedStyle(e).cursor)
    const hoverFill = await page.evaluate(() => {
      const s = document.createElement('span'); s.style.backgroundColor = 'var(--hover)'; document.body.appendChild(s)
      const c = getComputedStyle(s).backgroundColor; s.remove(); return c
    })

    test('hover: copy icon appears only on the hovered row, right after the key', () => {
      assert(iconBefore === null, 'copy icon is laid out before hover')
      assert(iconAfter !== null, 'copy icon did not appear on hover')
      assert(keyBox !== null && iconAfter!.x >= keyBox.x + keyBox.width, `icon at x=${iconAfter?.x}, key ends at ${keyBox && keyBox.x + keyBox.width}`)
      assert(iconAfter!.x - (keyBox!.x + keyBox!.width) < 10, 'icon is not next to the key')
      assert(otherIcon === null, 'a row the pointer is not on shows its copy icon')
    })
    test('hover: the row lifts with the hover fill; the key has a pointer cursor', () => {
      assert(bgBefore !== bgAfter, `row background did not change on hover (${bgBefore})`)
      assert(bgAfter === hoverFill, `hovered row is ${bgAfter}, hover token is ${hoverFill}`)
      assert(cursor === 'pointer', `cursor is ${cursor}`)
    })

    // ── copy ───────────────────────────────────────────────────────────────
    // A click in the DEFAULT cell copies nothing (only the key cell copies)...
    const defaultCell = await center(`${row('site-palette-stop-2')} [data-part="swatch"]`)
    await page.mouse.click(defaultCell.x, defaultCell.y)
    await page.waitForTimeout(150)
    const copiesFromDefault = await page.evaluate(() => window.__knobCopies ?? [])
    // ...and a click on the key copies exactly the key.
    const keyCell = await center(`${row('site-palette-stop-2')} [data-part="key"]`)
    await page.mouse.move(keyCell.x, keyCell.y)
    // Time the "Copied" label in the page itself (performance.now on each DOM
    // change), so a slow test runner cannot fake or break the hold.
    await page.evaluate((sel) => {
      const w = window as unknown as { __copiedLog: Array<{ on: boolean; t: number }>; __clickT: number }
      w.__copiedLog = []
      document.addEventListener('click', () => { w.__clickT = performance.now() }, { capture: true, once: true })
      new MutationObserver(() => {
        const on = !!document.querySelector(sel)
        const last = w.__copiedLog[w.__copiedLog.length - 1]
        if (!last || last.on !== on) w.__copiedLog.push({ on, t: performance.now() })
      }).observe(document.body, { subtree: true, childList: true })
    }, `${row('site-palette-stop-2')} [data-part="copied"]`)
    await page.mouse.click(keyCell.x, keyCell.y)
    await page.waitForSelector(`${row('site-palette-stop-2')} [data-part="copied"]`, { timeout: 300 }).catch(() => {})
    const copies = await page.evaluate(() => window.__knobCopies ?? [])
    const copiedNow = await page.locator(`${row('site-palette-stop-2')} [data-part="copied"]`).textContent().catch(() => null)
    const checkNow = await page.locator(`${row('site-palette-stop-2')} [data-part="check"]`).count()
    const copiedColour = copiedNow ? await page.$eval(`${row('site-palette-stop-2')} [data-part="copied"]`, (e) => getComputedStyle(e).color) : ''
    const success = await token('--success')
    const otherCopied = await page.locator('[data-part="copied"]').count()
    await page.waitForTimeout(HOLD_MS + 500)
    const copiedAfter = await page.locator(`${row('site-palette-stop-2')} [data-part="copied"]`).count()
    const timeline = await page.evaluate(() => {
      const w = window as unknown as { __copiedLog: Array<{ on: boolean; t: number }>; __clickT: number }
      return { log: w.__copiedLog.map((e) => ({ on: e.on, t: e.t - w.__clickT })) }
    })
    const iconBack = await page.locator(`${row('site-palette-stop-2')} [data-part="copy-icon"]`).boundingBox()

    test('copy: a click on the key hands onCopy exactly the key; a click on the default copies nothing', () => {
      assert(copiesFromDefault.length === 0, `a default-cell click copied ${JSON.stringify(copiesFromDefault)}`)
      assert(JSON.stringify(copies) === JSON.stringify(['site-palette-stop-2']), `onCopy received ${JSON.stringify(copies)}`)
    })
    test('copy: check + "Copied" in green, on that row only', () => {
      assert(copiedNow === 'Copied', `copied label is ${JSON.stringify(copiedNow)}`)
      assert(checkNow === 1, 'no check icon')
      assert(copiedColour === success, `"Copied" is ${copiedColour}, success is ${success}`)
      assert(otherCopied === 1, `${otherCopied} rows show "Copied"`)
    })
    test(`copy: "Copied" holds for the configured time (${HOLD_MS} ms) and then reverts`, () => {
      // Leading "off" entries are unrelated DOM changes before the label exists.
      const l = timeline.log.slice(Math.max(0, timeline.log.findIndex((e) => e.on)))
      const fmt = JSON.stringify(l.map((e) => `${e.on ? 'on' : 'off'}@${e.t.toFixed(0)}`))
      assert(l.length === 2 && l[0].on && !l[1].on, `"Copied" timeline ${fmt} — expected one on, one off`)
      assert(l[0].t < 150, `"Copied" appeared ${l[0].t.toFixed(0)} ms after the click`)
      const held = l[1].t - l[0].t
      assert(held >= HOLD_MS - 30 && held <= HOLD_MS + 250, `"Copied" held ${held.toFixed(0)} ms, configured ${HOLD_MS}`)
      assert(copiedAfter === 0, '"Copied" never reverted')
      assert(iconBack !== null, 'the hover copy icon did not come back after the revert')
    })

    await open('fixture=site&copy=fail')
    const failRow = await center(`${row('site-clock-speed')} [data-part="key"]`)
    await page.mouse.click(failRow.x, failRow.y)
    await page.waitForTimeout(200)
    const failCopied = await page.locator('[data-part="copied"]').count()
    test('copy: a refused copy shows no "Copied"', () => {
      assert(failCopied === 0, '"Copied" shown though the copy was refused')
    })

    await open('fixture=site&copy=clipboard')
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
    const clipRow = await center(`${row('fbm-octaves')} [data-part="key"]`)
    await page.mouse.click(clipRow.x, clipRow.y)
    await page.waitForSelector(`${row('fbm-octaves')} [data-part="copied"]`, { timeout: 1000 }).catch(() => {})
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    test('copy: the default path writes the key to the system clipboard', () => {
      assert(clip === 'fbm-octaves', `clipboard holds ${JSON.stringify(clip)}`)
    })

    // ── rename ─────────────────────────────────────────────────────────────
    await open('fixture=site&copy=log')
    const nameSel = `${row('site-balance-value')} [data-part="name"]`
    await page.click(nameSel)
    await page.waitForTimeout(250) // transition-colors
    const focusBorder = await page.$eval(nameSel, (e) => getComputedStyle(e).borderColor)
    const activeTok = await page.evaluate(() => {
      const s = document.createElement('span'); s.style.color = 'var(--active)'; document.body.appendChild(s)
      const c = getComputedStyle(s).color; s.remove(); return c
    })
    await page.keyboard.type('Amount')
    const liveKey = await page.$eval(`${row('site-balance-value')} [data-part="key"]`, (e) => e.textContent)
    const editsBeforeEnter = await page.evaluate(() => window.__knobEdits ?? [])
    await page.keyboard.press('Enter')
    await page.waitForSelector(row('site-balance-amount'), { timeout: 1000 }).catch(() => {})
    const editsAfterEnter = await page.evaluate(() => window.__knobEdits ?? [])
    const committedKey = await page.locator(row('site-balance-amount')).count()
    // Esc: type into another field, cancel — nothing reported, key restored.
    const seedSel = `${row('site-seed-value')} [data-part="name"]`
    await page.click(seedSel)
    await page.keyboard.type('Nope')
    const seedLive = await page.$eval(`${row('site-seed-value')} [data-part="key"]`, (e) => e.textContent)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    const seedAfter = await page.$eval(`${row('site-seed-value')} [data-part="key"]`, (e) => e.textContent)
    const seedValue = await page.$eval(seedSel, (e) => (e as HTMLInputElement).value)
    const editsAfterEsc = await page.evaluate(() => window.__knobEdits ?? [])

    test('rename: the focused Name field has the indigo border', () => {
      assert(focusBorder === activeTok, `focused field border ${focusBorder}, active token ${activeTok}`)
    })
    test('rename: the key follows the draft live, and Enter commits exactly once', () => {
      assert(liveKey === 'site-balance-amount', `live key while typing: ${liveKey}`)
      assert(editsBeforeEnter.length === 0, `edits reported before Enter: ${JSON.stringify(editsBeforeEnter)}`)
      assert(JSON.stringify(editsAfterEnter) === JSON.stringify(['rename site-balance-value → Amount']), `edits: ${JSON.stringify(editsAfterEnter)}`)
      assert(committedKey === 1, 'the row did not take the new key')
    })
    test('rename: Esc reports nothing and restores the name and key', () => {
      assert(seedLive === 'site-seed-nope', `live key ${seedLive} — the preview is not engaged, so this check would prove nothing`)
      assert(seedAfter === 'site-seed-value' && seedValue === 'Value', `after Esc: key ${seedAfter}, name ${seedValue}`)
      assert(editsAfterEsc.length === editsAfterEnter.length, `Esc reported an edit: ${JSON.stringify(editsAfterEsc)}`)
    })

    // ── hide ───────────────────────────────────────────────────────────────
    const footerBefore = await page.locator('[data-part="footer"]').count()
    await page.click(`${row('fbm-gain')} [data-part="visibility"]`)
    await page.waitForSelector(`${row('fbm-gain')}[data-hidden="true"]`, { timeout: 1000 }).catch(() => {})
    const hidden = await page.evaluate(() => {
      const r = document.querySelector('[data-knob-key="fbm-gain"]') as HTMLElement
      const key = r.querySelector('[data-part="key-cell"]') as HTMLElement
      const eye = r.querySelector('[data-part="visibility"]') as HTMLElement
      const other = document.querySelector('[data-knob-key="fbm-octaves"] [data-part="key-cell"]') as HTMLElement
      return {
        flag: r.getAttribute('data-hidden'), keyOpacity: getComputedStyle(key).opacity, eyeOpacity: getComputedStyle(eye).opacity,
        otherOpacity: getComputedStyle(other).opacity, pressed: eye.getAttribute('aria-pressed'),
        count: document.querySelector('[data-part="count"]')?.textContent ?? null,
      }
    })
    const editsAfterHide = await page.evaluate(() => window.__knobEdits ?? [])
    test('hide: the eye reports the knob once, the row dims, the eye stays full strength', () => {
      assert(editsAfterHide[editsAfterHide.length - 1] === 'hide fbm-gain', `edits: ${JSON.stringify(editsAfterHide)}`)
      assert(hidden.flag === 'true' && hidden.pressed === 'true', `row ${hidden.flag}, aria-pressed ${hidden.pressed}`)
      assert(hidden.keyOpacity === '0.5', `hidden key cell opacity ${hidden.keyOpacity}`)
      assert(hidden.eyeOpacity === '1' && hidden.otherOpacity === '1', `eye ${hidden.eyeOpacity}, a shown row ${hidden.otherOpacity}`)
    })
    test('hide: the footer appears only with a hidden knob and counts both', () => {
      assert(footerBefore === 0, 'a footer showed with nothing hidden')
      assert(hidden.count === '12 published · 1 hidden', `footer: ${hidden.count}`)
    })

    // ── scroll ─────────────────────────────────────────────────────────────
    await open('fixture=sixty&copy=log')
    const geom = () => page.evaluate(() => {
      const body = document.querySelector('[data-part="body"]') as HTMLElement
      const header = document.querySelector('[data-part="header"]') as HTMLElement
      const first = body.querySelector('[data-knob-key]') as HTMLElement
      const h = header.getBoundingClientRect()
      const keyCol = header.firstElementChild!.getBoundingClientRect()
      const hit = document.elementFromPoint(keyCol.left + 4, h.top + h.height / 2)
      return {
        rows: body.querySelectorAll('[data-knob-key]').length,
        scrollTop: body.scrollTop,
        bodyScrollable: body.scrollHeight > body.clientHeight + 50,
        bodyClient: body.clientHeight,
        headerScrollable: header.scrollHeight > header.clientHeight,
        headerInsideBody: body.contains(header),
        headerTop: h.top,
        headerBottom: h.bottom,
        firstTop: first.getBoundingClientRect().top,
        headerPainted: !!hit && header.contains(hit),
      }
    })
    const g0 = await geom()
    const bodyC = await center('[data-part="body"]')
    await page.mouse.move(bodyC.x, bodyC.y)
    await page.mouse.wheel(0, 700)
    await page.waitForFunction(() => (document.querySelector('[data-part="body"]') as HTMLElement).scrollTop > 200, null, { timeout: 2000 }).catch(() => {})
    const g1 = await geom()

    test('scroll: 60 rows — the body scrolls, the header does not and is outside the scroll box', () => {
      assert(g0.rows === 60, `${g0.rows} rows rendered`)
      assert(g0.bodyScrollable, 'the body is not scrollable with 60 rows')
      assert(g0.bodyClient >= 330 && g0.bodyClient <= 370, `body shows ${g0.bodyClient}px — expected about eleven 32px rows`)
      assert(!g0.headerScrollable, 'the header is itself scrollable')
      assert(!g0.headerInsideBody, 'the header sits inside the scroll box, so it scrolls away')
    })
    test('scroll: after a wheel scroll the header is still painted at the top; the rows went under it', () => {
      assert(g1.scrollTop > 200, `wheel scrolled the body by only ${g1.scrollTop}px`)
      assert(Math.abs(g1.headerTop - g0.headerTop) < 0.5, `header moved ${g0.headerTop} → ${g1.headerTop}`)
      assert(g1.headerPainted, 'something other than the header is painted at the header position')
      assert(g0.firstTop >= g0.headerBottom - 0.5, 'first row starts under the header before scrolling')
      assert(g1.firstTop < g1.headerTop, `first row is at ${g1.firstTop}, header top ${g1.headerTop} — it did not scroll under`)
    })

    // ── clash ──────────────────────────────────────────────────────────────
    await open('fixture=clash&copy=log')
    const clash = await page.evaluate(() => {
      const notice = document.querySelector('[data-part="notice"]') as HTMLElement | null
      const header = document.querySelector('[data-part="header"]') as HTMLElement
      const icon = notice?.querySelector('svg')
      const marked = [...document.querySelectorAll('[data-knob-key]')]
        .filter((r) => r.querySelector('[data-part="clash-icon"]'))
        .map((r) => r.getAttribute('data-knob-key'))
      const hint = document.querySelector('[data-part="clash-hint"]')
      const mark = document.querySelector('[data-part="clash-icon"]')
      const cs = notice ? getComputedStyle(notice) : null
      return {
        title: document.querySelector('[data-part="title"]')?.textContent,
        noticeText: notice?.textContent ?? null,
        noticeBg: cs?.backgroundColor, noticeShadow: cs?.boxShadow,
        noticeTextColour: notice ? getComputedStyle(notice.querySelector('p')!).color : null,
        noticeIconColour: icon ? getComputedStyle(icon).color : null,
        noticeAbove: notice ? notice.getBoundingClientRect().bottom <= header.getBoundingClientRect().top : false,
        marked, hint: hint?.textContent, markColour: mark ? getComputedStyle(mark).color : null,
      }
    })
    const surfaceRaised = await page.evaluate(() => {
      const s = document.createElement('span'); s.style.backgroundColor = 'var(--surface-raised)'; document.body.appendChild(s)
      const c = getComputedStyle(s).backgroundColor; s.remove(); return c
    })
    const warning = await token('--warning')
    test('clash: only the numbered row carries the amber mark and the plain-words hint', () => {
      assert(JSON.stringify(clash.marked) === '["site-balance-value-2"]', `marked rows: ${JSON.stringify(clash.marked)}`)
      assert(clash.hint === 'name clash, numbered', `hint: ${clash.hint}`)
      assert(clash.markColour === warning, `mark is ${clash.markColour}, warning is ${warning}`)
      assert(clash.title === 'Knobs · 14', `title: ${clash.title}`)
    })
    test('clash: the notice names the label and the key it produced, above the table, calmly', () => {
      assert(clash.noticeText !== null, 'no notice')
      assert(clash.noticeText!.includes('“site.balance”') && clash.noticeText!.includes('site-balance-value-2'), `notice: ${clash.noticeText}`)
      assert(clash.noticeAbove, 'notice is not above the table header')
      assert(clash.noticeBg === surfaceRaised, `notice background ${clash.noticeBg} — expected the neutral raised surface ${surfaceRaised}`)
      assert(clash.noticeTextColour === fgDim, `notice text ${clash.noticeTextColour} — expected grey fg-dim ${fgDim}`)
      assert(clash.noticeIconColour === warning, `notice icon ${clash.noticeIconColour} — expected amber ${warning}`)
      assert(clash.noticeShadow === 'none', `notice has a shadow/glow: ${clash.noticeShadow}`)
    })

    // ── empty ──────────────────────────────────────────────────────────────
    await open('fixture=empty')
    const empty = await page.evaluate(() => ({
      text: document.querySelector('[data-part="empty"]')?.textContent ?? null,
      header: !!document.querySelector('[data-part="header"]'),
      rows: document.querySelectorAll('[data-knob-key]').length,
      title: document.querySelector('[data-part="title"]')?.textContent,
      hint: document.querySelector('[data-part="knob-table"]')!.textContent!.includes('Click a key'),
    }))
    test('empty: one calm line, no table', () => {
      assert(empty.text === 'This scene has no knobs: hosts can show it, but there is nothing to drive.', `empty text: ${empty.text}`)
      assert(!empty.header && empty.rows === 0, 'a table rendered with no knobs')
      assert(empty.title === 'Knobs · 0', `title: ${empty.title}`)
      assert(!empty.hint, 'the copy hint shows with nothing to copy')
    })

    test('no page errors, and no reload behind the gate\'s back', () => {
      assert(pageErrors.length === 0, pageErrors.join('\n'))
      assert(loads === opens, `${loads} page loads for ${opens} navigations — the page reloaded mid-test`)
    })
  } finally {
    await browser?.close()
    await server?.close()
  }
  await run('knob-table-ui')
}

await main()
