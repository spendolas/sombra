/**
 * The Wired Param Row (Option D "Live indicator", Figma 998:6114 / 999:6115)
 * driven through its sandbox harness in headless Chrome: real component, real
 * DOM, real pointer and keyboard input. No GPU needed.
 *
 * Every check pairs the outcome with proof the mechanism ran, because a row that
 * never re-renders, or a part that is never mounted, would otherwise "pass" by
 * staying in its starting state:
 *  - height: the wired row's box equals the unwired DS row it replaces, measured
 *    in the same node (slider row for float/colour/opacity, labelled-port row
 *    for mask) — and the reference row really holds a slider track, and the
 *    handle sits on the row's vertical centre in both.
 *  - constant: the exact formatted number; editing the value prop changes the
 *    text and moves the tick to the matching fraction of the param range;
 *    swapping formatValue reformats it.
 *  - animated: the number changes over real time, the sparkline has > 1 points
 *    and its geometry changes, and the "now" dot sits on the line's last point.
 *  - varies: "varies" with no range bar when min/max are unknown; with min/max,
 *    the range text, a spoken "varies, …" label, and a bar placed at min..max.
 *  - no interactive control: no input/select/button/textarea/slider/link inside
 *    any fixture's row; the only tab stop is the row itself (the tooltip
 *    trigger). The query is proven live by finding the harness's own inputs.
 *  - hover: role=tooltip with the exact text, aria-describedby linked, the hover
 *    tint applied; gone on leave. Keyboard focus shows it too.
 *  - colour: the swatch's fill is the colour at its alpha, value reads the hex;
 *    decoded screenshot pixels show the checkerboard through a translucent
 *    colour (two distinct composites) and a uniform swatch when opaque.
 *  - reduced motion: the sparkline is marked frozen and its geometry stops
 *    changing while the number keeps ticking (so the feed is still running);
 *    back to no-preference, it moves again.
 *
 * Run: npm run verify:wired-param-row-ui        (needs Chrome)
 *      npm run verify:wired-param-row-ui -- --shots <dir>   also writes a PNG per fixture
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const shotsIdx = process.argv.indexOf('--shots')
const SHOTS = shotsIdx > 0 ? resolve(process.argv[shotsIdx + 1]) : null

let page: Page

const ROW = '[data-testid=stage] [data-wired]'
const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FIXTURES = ['constant', 'animated', 'variesRange', 'varies', 'colorConstant', 'colorVaries', 'opacity', 'mask', 'transform', 'hover', 'long']

async function fixture(key: string) {
  await page.click(`[data-fixture="${key}"]`)
  await page.mouse.move(1200, 880) // park the pointer away from the stage
  await realWait(60)
}

interface RowView {
  kind: string | null
  mode: string | null
  height: number
  rowMidY: number
  handleMidY: number | null
  value: string | null
  valueAria: string | null
  tick: number | null // tick centre as a fraction of the indicator width
  range: { left: number; width: number } | null // fractions of the track
  rangeEnds: number
  sparkPoints: number
  sparkGeom: string | null
  sparkFrozen: boolean
  now: { x: number; y: number } | null
  lastPoint: { x: number; y: number } | null
  swatchFill: string | null
  swatchBg: string | null
  palette: number
  tooltip: { id: string; text: string[] } | null
  describedBy: string | null
  bg: string
  interactive: string[]
  tabStops: number
}

async function view(): Promise<RowView> {
  return page.evaluate((ROW) => {
    const row = document.querySelector(ROW) as HTMLElement
    const r = row.getBoundingClientRect()
    const mid = (el: Element | null) => (el ? el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 : null)
    const ind = row.querySelector('[data-part=indicator]') as HTMLElement | null
    const ir = ind?.getBoundingClientRect()
    const centreFrac = (el: Element | null) => {
      if (!el || !ir) return null
      const b = el.getBoundingClientRect()
      return (b.left + b.width / 2 - ir.left) / ir.width
    }
    const rangeEl = row.querySelector('[data-part=range]') as HTMLElement | null
    const trackBox = rangeEl?.parentElement?.getBoundingClientRect()
    const svg = row.querySelector('[data-part=sparkline]') as SVGSVGElement | null
    const poly = svg?.querySelector('polyline')
    const pts = (poly?.getAttribute('points') ?? '').trim().split(/\s+/).filter(Boolean)
    let lastPoint: { x: number; y: number } | null = null
    if (svg && pts.length) {
      const [px, py] = pts[pts.length - 1].split(',').map(Number)
      const sb = svg.getBoundingClientRect()
      lastPoint = { x: sb.left + (px / 100) * sb.width, y: sb.top + (py / 16) * sb.height }
    }
    const nowEl = row.querySelector('[data-part=now]')
    const nb = nowEl?.getBoundingClientRect()
    const tip = row.querySelector('[role=tooltip]')
    const valueEl = row.querySelector('[data-part=value]')
    const fill = row.querySelector('[data-part=swatch-fill]')
    const swatch = row.querySelector('[data-part=swatch]')
    const tabbables = [row, ...row.querySelectorAll('*')].filter((el) => (el as HTMLElement).tabIndex >= 0 && !(el as HTMLElement).hidden)
    return {
      kind: row.getAttribute('data-wired'),
      mode: row.getAttribute('data-mode'),
      height: r.height,
      rowMidY: r.top + r.height / 2,
      handleMidY: mid(row.querySelector('[data-handle]')),
      value: valueEl ? valueEl.textContent : null,
      valueAria: valueEl ? valueEl.getAttribute('aria-label') : null,
      tick: centreFrac(row.querySelector('[data-part=tick]')),
      range: rangeEl && trackBox ? {
        left: (rangeEl.getBoundingClientRect().left - trackBox.left) / trackBox.width,
        width: rangeEl.getBoundingClientRect().width / trackBox.width,
      } : null,
      rangeEnds: row.querySelectorAll('[data-part=range-min],[data-part=range-max]').length,
      sparkPoints: pts.length,
      sparkGeom: poly ? poly.getAttribute('points') : null,
      sparkFrozen: svg?.getAttribute('data-frozen') === 'true',
      now: nb ? { x: nb.left + nb.width / 2, y: nb.top + nb.height / 2 } : null,
      lastPoint,
      swatchFill: fill ? getComputedStyle(fill).backgroundColor : null,
      swatchBg: swatch ? getComputedStyle(swatch).backgroundImage : null,
      palette: row.querySelectorAll('[data-part=sample]').length,
      tooltip: tip ? { id: tip.id, text: [...tip.children].map((c) => c.textContent ?? '') } : null,
      describedBy: row.getAttribute('aria-describedby'),
      bg: getComputedStyle(row).backgroundColor,
      interactive: [...row.querySelectorAll('input,select,textarea,button,a[href],[role=slider],[role=button],[role=spinbutton],[contenteditable=true]')]
        .map((e) => e.tagName.toLowerCase() + (e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : '')),
      tabStops: tabbables.length,
    }
  }, ROW)
}

/** Box height of the unwired reference row of the given kind in the stage. */
async function refHeight(kind: 'float' | 'mask'): Promise<{ height: number; hasTrack: boolean; handleOff: number }> {
  return page.evaluate((kind) => {
    const el = document.querySelector(`[data-testid=stage] [data-ref-row=${kind}]`) as HTMLElement
    const r = el.getBoundingClientRect()
    const h = el.querySelector('[data-handle]')!.getBoundingClientRect()
    return {
      height: r.height,
      // the reference is a real slider row: SombraSlider's track is the cursor-ew-resize bar
      hasTrack: kind === 'mask' ? true : !!el.querySelector('.cursor-ew-resize.rounded-full'),
      handleOff: h.top + h.height / 2 - (r.top + r.height / 2),
    }
  }, kind)
}

// ── Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chrome writes) ──
function decodePng(buf: Buffer): { w: number; h: number; px: (x: number, y: number) => [number, number, number] } {
  let o = 8, w = 0, h = 0, ct = 0
  const idat: Buffer[] = []
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8)
    const data = buf.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG') }
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  const bpp = ct === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? out[y * stride + x - bpp] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0
      let v = cur
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      out[y * stride + x] = v & 255
    }
  }
  return { w, h, px: (x, y) => { const i = y * stride + x * bpp; return [out[i], out[i + 1], out[i + 2]] } }
}

/** Distinct colours inside the swatch (border excluded), from a real screenshot. */
async function swatchColours(): Promise<string[]> {
  const el = page.locator(`${ROW} [data-part=swatch]`)
  const png = decodePng(await el.screenshot())
  const seen = new Set<string>()
  const inset = 4 // device px: past the 1px (2 device px) border and its anti-aliasing
  for (let y = inset; y < png.h - inset; y++) {
    for (let x = inset; x < png.w - inset; x++) seen.add(png.px(x, y).join(','))
  }
  return [...seen]
}

// ── height: same as the unwired row, handle stays put ────────────────────────
test('height: every wired row equals the unwired row it replaces; handle on the row centre', async () => {
  for (const key of FIXTURES) {
    await fixture(key)
    const v = await view()
    const refKind = v.kind === 'mask' ? 'mask' : 'float'
    const ref = await refHeight(refKind)
    assert(ref.hasTrack, `${key}: the ${refKind} reference row has no slider track — it is not the real unwired row`)
    assert(ref.height > 0 && v.height > 0, `${key}: zero-height box (ref ${ref.height}, wired ${v.height})`)
    assertClose(v.height, ref.height, 0.5, `${key}: wired row height vs unwired ${refKind} row`)
    assert(v.handleMidY !== null, `${key}: handle slot not rendered`)
    assertClose(v.handleMidY! - v.rowMidY, ref.handleOff, 0.5, `${key}: handle offset from row centre (wired vs unwired)`)
  }
})

// ── constant ─────────────────────────────────────────────────────────────────
test('constant: the exact formatted number and a tick at the right place; props drive both', async () => {
  await fixture('constant')
  const a = await view()
  assert(a.kind === 'float' && a.mode === 'constant', `constant fixture renders kind=${a.kind} mode=${a.mode}`)
  assert(a.value === '1.50', `constant value should read "1.50", got ${JSON.stringify(a.value)}`)
  assert(a.tick !== null, 'constant row has no tick')
  assertClose(a.tick!, (1.5 - 0.1) / (4 - 0.1), 0.01, 'tick position (fraction of 0.1..4)')
  assert(a.sparkPoints === 0 && a.range === null, 'constant row also shows a sparkline or a range')

  await page.fill('[data-control="constant"]', '3.217')
  await realWait(40)
  const b = await view()
  assert(b.value === '3.22', `after setting 3.217 the value should read "3.22", got ${JSON.stringify(b.value)}`)
  assertClose(b.tick!, (3.217 - 0.1) / (4 - 0.1), 0.01, 'tick moved with the value')

  await page.selectOption('[data-control="format"]', 'int')
  await realWait(40)
  const c = await view()
  assert(c.value === '3', `formatValue=int should read "3", got ${JSON.stringify(c.value)}`)
})

// ── animated ─────────────────────────────────────────────────────────────────
test('animated: the number changes over time; sparkline with > 1 points that moves; now dot at its end', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await fixture('animated')
  const a = await view()
  assert(a.mode === 'animated', `animated fixture renders mode=${a.mode}`)
  assert(a.sparkPoints > 1, `sparkline should have > 1 points, has ${a.sparkPoints}`)
  assert(!a.sparkFrozen, 'sparkline frozen without reduced motion')
  await realWait(700)
  const b = await view()
  assert(a.value !== null && b.value !== null && a.value !== b.value, `value did not change over 700 ms (${a.value} → ${b.value})`)
  assert(b.sparkGeom !== a.sparkGeom, 'sparkline geometry did not change over 700 ms')
  assert(b.now && b.lastPoint, 'no "now" dot on the sparkline')
  assertClose(b.now!.x, b.lastPoint!.x, 1.5, 'now dot x vs last point')
  assertClose(b.now!.y, b.lastPoint!.y, 1.5, 'now dot y vs last point')
  assert(b.tick === null, 'animated row shows a constant tick')
})

// ── varies ───────────────────────────────────────────────────────────────────
test('varies: "varies" without a range; with min/max the range text and a bar at min..max', async () => {
  await fixture('varies')
  const a = await view()
  assert(a.mode === 'varies', `varies fixture mode=${a.mode}`)
  assert(a.value === 'varies', `unknown range should read "varies", got ${JSON.stringify(a.value)}`)
  assert(a.range === null && a.rangeEnds === 0, 'a range bar is drawn although min/max are unknown')

  await fixture('variesRange')
  const b = await view()
  assert(b.value === '0.12–0.88', `range text should be "0.12–0.88", got ${JSON.stringify(b.value)}`)
  assert(b.valueAria === 'varies, 0.12–0.88', `value should be spoken as "varies, 0.12–0.88", got ${JSON.stringify(b.valueAria)}`)
  assert(b.range !== null && b.rangeEnds === 2, `range bar/ends missing (bar=${!!b.range}, ends=${b.rangeEnds})`)
  assertClose(b.range!.left, 0.12, 0.01, 'range bar left')
  assertClose(b.range!.width, 0.76, 0.01, 'range bar width')

  // Live: dropping max removes the bar and goes back to "varies".
  await page.uncheck('[data-control="use-max"]')
  await realWait(40)
  const c = await view()
  assert(c.value === 'varies' && c.range === null, `with max unknown: value=${c.value} bar=${!!c.range}`)

  await fixture('mask')
  const m = await view()
  assert(m.kind === 'mask' && m.range !== null, 'mask row has no range bar for a known min/max')
  assertClose(m.range!.left, 0.1, 0.02, 'mask range left')
  assertClose(m.range!.width, 0.72, 0.02, 'mask range width')
})

// ── no editable control ──────────────────────────────────────────────────────
test('no interactive control in any wired row; the row is the only tab stop', async () => {
  const pageInputs = await page.locator('[data-testid=controls] input').count()
  assert(pageInputs > 3, `the interactive-element query found only ${pageInputs} harness inputs — it is not looking`)
  for (const key of FIXTURES) {
    await fixture(key)
    const v = await view()
    assert(v.interactive.length === 0, `${key}: interactive elements inside the wired row: ${v.interactive.join(', ')}`)
    assert(v.tabStops === 1, `${key}: ${v.tabStops} tab stops in the row (expected only the row itself)`)
  }
})

// ── hover tooltip ────────────────────────────────────────────────────────────
test('hover: tooltip "Driven by Number.value. / Disconnect to edit." and the tint; gone on leave', async () => {
  await fixture('constant')
  const idle = await view()
  assert(idle.tooltip === null && idle.describedBy === null, 'tooltip visible before hover')
  await page.hover(ROW)
  await realWait(250) // let the colour transition settle
  const v = await view()
  assert(v.tooltip !== null, 'no role=tooltip after hovering the row')
  assert(JSON.stringify(v.tooltip!.text) === JSON.stringify(['Driven by Number.value.', 'Disconnect to edit.']), `tooltip text ${JSON.stringify(v.tooltip!.text)}`)
  assert(v.describedBy === v.tooltip!.id, `aria-describedby=${v.describedBy} does not point at the tooltip ${v.tooltip!.id}`)
  assert(v.bg !== idle.bg && /rgba\(255, 255, 255, 0\.06\)/.test(v.bg), `hover tint should be interactive/hover, got ${v.bg} (idle ${idle.bg})`)
  await page.mouse.move(1200, 880)
  await realWait(60)
  const after = await view()
  assert(after.tooltip === null && after.describedBy === null, 'tooltip did not go away when the pointer left')

  // The source name in the message follows the prop.
  await fixture('long')
  await page.hover(ROW)
  await realWait(60)
  const long = await view()
  assert(long.tooltip?.text[0] === 'Driven by Brightness / Contrast (luminance remap).value.', `long-source tooltip: ${JSON.stringify(long.tooltip?.text)}`)
})

test('keyboard: Tab onto the row shows the tooltip; Tab away hides it', async () => {
  await fixture('constant')
  await page.focus('[data-fixture="long"]')
  let focused = false
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press('Tab')
    focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), ROW)
  }
  assert(focused, 'could not Tab onto the wired row')
  await realWait(40)
  const v = await view()
  assert(v.tooltip !== null && v.describedBy === v.tooltip.id, 'keyboard focus did not show the tooltip')
  await page.keyboard.press('Tab')
  await realWait(40)
  assert((await view()).tooltip === null, 'tooltip stayed after focus left the row')
})

// ── colour ───────────────────────────────────────────────────────────────────
test('colour: swatch shows the colour at its alpha over the checker; opaque is uniform', async () => {
  await fixture('colorConstant')
  const a = await view()
  assert(a.kind === 'color', `colour fixture kind=${a.kind}`)
  assert(a.value === '#FBBF2480', `hex should be "#FBBF2480", got ${JSON.stringify(a.value)}`)
  assert(a.swatchFill === 'rgba(251, 191, 36, 0.5)', `swatch fill ${a.swatchFill}`)
  assert(!!a.swatchBg && /linear-gradient/.test(a.swatchBg), `swatch has no checkerboard under the colour (${a.swatchBg})`)
  const translucent = await swatchColours()
  // Two checker cells under a 50% colour → (at least) two distinct composites,
  // each pulled toward yellow (R > B) but not the pure colour.
  const parsed = translucent.map((s) => s.split(',').map(Number))
  assert(parsed.length >= 2, `translucent swatch shows ${parsed.length} colour(s); the checker is not showing through`)
  assert(parsed.every(([r, , b]) => r > b + 40), `translucent swatch pixels are not tinted by the colour: ${translucent.slice(0, 4).join(' | ')}`)
  assert(parsed.every(([r, g, b]) => !(r > 245 && g > 185 && b < 45)), 'a translucent swatch pixel is the pure opaque colour')

  await page.fill('[data-control="color-a"]', '1')
  await realWait(60)
  const b = await view()
  assert(b.value === '#FBBF24', `opaque hex should be "#FBBF24", got ${JSON.stringify(b.value)}`)
  const opaque = (await swatchColours()).map((s) => s.split(',').map(Number))
  assert(opaque.every(([r, g, bl]) => Math.abs(r - 251) <= 2 && Math.abs(g - 191) <= 2 && Math.abs(bl - 36) <= 2), `opaque swatch is not uniformly #FBBF24: ${opaque.slice(0, 4).map((p) => p.join(',')).join(' | ')}`)

  await fixture('colorVaries')
  const c = await view()
  assert(c.value === 'varies' && c.palette === 6, `per-pixel colour: value=${c.value} palette samples=${c.palette}`)
})

// ── reduced motion ───────────────────────────────────────────────────────────
test('reduced motion: sparkline frozen while the number keeps ticking; moves again after', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixture('animated')
  await realWait(100)
  const a = await view()
  assert(a.sparkFrozen, 'sparkline not marked frozen under reduced motion')
  await realWait(700)
  const b = await view()
  assert(a.value !== b.value, `the feed stopped (value ${a.value} → ${b.value}), so a still sparkline proves nothing`)
  assert(a.sparkGeom === b.sparkGeom, 'sparkline geometry changed under reduced motion')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await realWait(100)
  const c = await view()
  await realWait(500)
  const d = await view()
  assert(!c.sparkFrozen && c.sparkGeom !== d.sparkGeom, 'sparkline did not resume after reduced motion was turned off')
})

// ── optional screenshots for eyeballing ──────────────────────────────────────
test('screenshots (only with --shots)', async () => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const key of FIXTURES) {
    await fixture(key)
    if (key === 'hover') await page.hover(ROW)
    await realWait(120)
    await page.locator('[data-testid=stage]').screenshot({ path: resolve(SHOTS, `${key}.png`) })
  }
})

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', server: { port: 0, host: '127.0.0.1' } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    // tsx compiles with keepNames, which wraps the inner helpers of page.evaluate
    // callbacks in __name(); the page has no such global.
    await page.addInitScript('window.__name = (f) => f')
    await page.goto(new URL('sandbox.html?c=wired-param-row&solo=1', url).href)
    await page.waitForSelector(ROW, { timeout: 30000 })
    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join('\n')))
    await run('wired param row UI')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
