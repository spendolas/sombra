/**
 * Inline node rename (NodeTitle) — real mouse and keyboard in headless Chrome,
 * against the node-title sandbox, where the title sits in a real node on a real
 * React Flow canvas.
 *
 * Every check pairs the outcome with proof that the mechanism ran, because an
 * outcome alone passes when the feature is skipped:
 *   - "pencil appears on hover" also asserts it was laid out (24px) while hidden;
 *   - "whole text selected" reads the focused input's selection range;
 *   - "Backspace doesn't reach the delete handler" first proves the key changed
 *     the field AND that the same key outside the field DOES reach the handler;
 *   - "drag in the field doesn't move the node" first proves a drag on the body
 *     DOES move it;
 *   - "blur saves" sends no Enter at all — only a click elsewhere.
 * Each of the four guarded mechanisms (blur-save, select-all, nodrag, key
 * stopPropagation) was removed one at a time and turned this gate red; see
 * .figma/wiki/molecules/node-title.md.
 *
 * Run: npm run verify:node-title-ui   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const LONG = 'site.hero.background.gradient.balance.value.mixed.primary.layer'
const DUP_MSG = 'Another node has this name — exported controls will be numbered'
const C = '[data-testid="canvas"]'
const sel = (slot: string) => `${C} [data-slot="${slot}"]`

let page: Page

interface Log { renames: Array<string | null>; events: string[] }
const log = () => page.evaluate(() => {
  const h = (window as unknown as { __nodeTitleHarness: Log }).__nodeTitleHarness
  return { renames: [...h.renames], events: [...h.events] }
})

/** Load a fixture with a fresh log and the mouse parked off the canvas. */
async function load(key: string) {
  await page.mouse.move(5, 5)
  await page.click(`[data-fixture="${key}"]`)
  await page.waitForTimeout(150)
  // Leave any editing a fixture script started — but only scripted fixtures start one.
  await page.evaluate(() => {
    const h = (window as unknown as { __nodeTitleHarness: Log }).__nodeTitleHarness
    h.renames.length = 0
    h.events.length = 0
  })
}

async function center(selector: string) {
  const b = await page.locator(selector).boundingBox()
  assert(b, `${selector} has no box`)
  return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }
}

async function dblclickName() {
  const p = await center(sel('node-title-name'))
  await page.mouse.dblclick(p.x, p.y)
  await page.waitForSelector(sel('node-title-input'), { timeout: 2000 })
}

interface FieldState { exists: boolean; focused: boolean; value: string; start: number | null; end: number | null; maxLength: number; placeholder: string }
const field = () => page.evaluate((s) => {
  const el = document.querySelector<HTMLInputElement>(s)
  if (!el) return { exists: false, focused: false, value: '', start: null, end: null, maxLength: -1, placeholder: '' }
  return { exists: true, focused: document.activeElement === el, value: el.value, start: el.selectionStart, end: el.selectionEnd, maxLength: el.maxLength, placeholder: el.placeholder }
}, sel('node-title-input')) as Promise<FieldState>

const nameText = () => page.locator(sel('node-title-name')).textContent()
const nodeTransform = () => page.evaluate(() => (document.querySelector('.react-flow__node[data-id="live"]') as HTMLElement | null)?.style.transform ?? 'MISSING')
const opacity = (s: string) => page.evaluate((q) => getComputedStyle(document.querySelector(q)!).opacity, s)

function assertWholeSelection(f: FieldState, expected: string, how: string) {
  assert(f.exists, `${how}: no field appeared`)
  assert(f.focused, `${how}: field is not the focused element`)
  assert(f.value === expected, `${how}: field holds "${f.value}", expected "${expected}"`)
  assert(f.start === 0 && f.end === expected.length, `${how}: selection ${f.start}..${f.end}, expected 0..${expected.length} (whole text)`)
}

// ── Geometry probe: where the title TEXT starts, rest vs editing ────────────
const geometry = () => page.evaluate((C) => {
  const root = document.querySelector(C)!
  const header = root.querySelector('header')!.getBoundingClientRect()
  const node = (root.querySelector('[data-testid="live-node"]') as HTMLElement).getBoundingClientRect()
  const input = root.querySelector<HTMLInputElement>('[data-slot="node-title-input"]')
  if (input) {
    const r = input.getBoundingClientRect(); const cs = getComputedStyle(input)
    return { headerH: header.height, nodeW: node.width, textLeft: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), midY: r.top + r.height / 2, fontSize: cs.fontSize, fontWeight: cs.fontWeight }
  }
  const name = root.querySelector('[data-slot="node-title-name"]') as HTMLElement
  const range = document.createRange(); range.selectNodeContents(name)
  const t = range.getBoundingClientRect(); const r = name.getBoundingClientRect(); const cs = getComputedStyle(name)
  return { headerH: header.height, nodeW: node.width, textLeft: t.left, midY: r.top + r.height / 2, fontSize: cs.fontSize, fontWeight: cs.fontWeight }
}, C)

// ── Tests ───────────────────────────────────────────────────────────────────

test('pencil is hidden at rest and fades in on hover (laid out the whole time)', async () => {
  await load('default')
  await page.waitForTimeout(300)
  const pencil = sel('node-title-pencil')
  const rest = { op: await opacity(pencil), box: await page.locator(pencil).boundingBox() }
  assert(rest.op === '0', `pencil opacity at rest = ${rest.op}, expected 0`)
  assert(rest.box && rest.box.width === 24, `pencil not laid out at rest (box ${JSON.stringify(rest.box)})`)
  const p = await center(sel('node-title-name'))
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(350)
  const hovered = await page.evaluate((s) => document.querySelector(s)!.matches(':hover'), sel('node-title'))
  assert(hovered, 'mechanism: the title region never matched :hover')
  const op = await opacity(pencil)
  assert(op === '1', `pencil opacity on hover = ${op}, expected 1`)
})

test('clicking the pencil enters edit with the whole text selected', async () => {
  await load('default')
  const p = await center(sel('node-title-name'))
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(300)
  const q = await center(sel('node-title-pencil'))
  await page.mouse.click(q.x, q.y)
  await page.waitForSelector(sel('node-title-input'), { timeout: 2000 })
  assertWholeSelection(await field(), 'Number', 'pencil')
  await page.keyboard.press('Escape')
})

test('double-clicking the title enters edit with the whole text selected — no node dblclick, no zoom', async () => {
  await load('custom')
  const vpBefore = await page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)
  await dblclickName()
  assertWholeSelection(await field(), 'site.balance', 'double-click')
  const vpAfter = await page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform)
  assert(vpAfter === vpBefore, `viewport changed on double-click: ${vpBefore} → ${vpAfter}`)
  const { events } = await log()
  assert(!events.some((e) => e.includes('double-click')), `node double-click handler was reached: ${events.join(' | ')}`)
  await page.keyboard.press('Escape')
})

test('Enter saves (typing replaces the selected text), exactly once', async () => {
  await load('custom')
  await dblclickName()
  await page.keyboard.type('site.hue')
  assert((await field()).value === 'site.hue', `typing did not replace the selection: "${(await field()).value}"`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  const { renames } = await log()
  assert(JSON.stringify(renames) === '["site.hue"]', `onRename calls = ${JSON.stringify(renames)}, expected ["site.hue"]`)
  assert(!(await field()).exists, 'field still open after Enter')
  assert((await nameText()) === 'site.hue', `title shows "${await nameText()}"`)
  assert((await page.locator(sel('node-title-type')).textContent()) === 'Number', 'type tag missing after save')
})

test('clicking away (blur, no Enter) saves', async () => {
  await load('custom')
  await dblclickName()
  await page.keyboard.type('site.hue')
  await page.mouse.click(20, 20) // the page heading — anywhere else
  await page.waitForTimeout(100)
  const { renames } = await log()
  assert(JSON.stringify(renames) === '["site.hue"]', `onRename calls after click-away = ${JSON.stringify(renames)}, expected ["site.hue"]`)
  assert(!(await field()).exists, 'field still open after click-away')
  assert((await nameText()) === 'site.hue', `title shows "${await nameText()}"`)
})

test('Escape cancels and restores the old name', async () => {
  await load('custom')
  await dblclickName()
  await page.keyboard.type('site.hue')
  assert((await field()).value === 'site.hue', 'mechanism: the draft never changed, so cancel proves nothing')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  const { renames } = await log()
  assert(renames.length === 0, `Escape called onRename: ${JSON.stringify(renames)}`)
  assert(!(await field()).exists, 'field still open after Escape')
  assert((await nameText()) === 'site.balance', `title shows "${await nameText()}" after Escape`)
})

test('an empty field shows the type faintly and clears the custom name (onRename(undefined))', async () => {
  await load('custom')
  await dblclickName()
  await page.keyboard.press('Backspace') // whole text selected → empties it
  const f = await field()
  assert(f.value === '' && f.placeholder === 'Number', `empty field: value "${f.value}", placeholder "${f.placeholder}"`)
  const ph = await page.evaluate((s) => getComputedStyle(document.querySelector(s)!, '::placeholder').color, sel('node-title-input'))
  assert(ph === 'rgb(90, 90, 110)', `placeholder colour ${ph}, expected fg-muted rgb(90, 90, 110)`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  const { renames } = await log()
  assert(JSON.stringify(renames) === '[null]', `onRename calls = ${JSON.stringify(renames)}, expected [undefined]`)
  assert((await nameText()) === 'Number', `header shows "${await nameText()}", expected the type label`)
  assert((await page.locator(sel('node-title-type')).count()) === 0, 'type tag still shown with no custom name')
})

test('Backspace/Delete in the field never reach the canvas delete handler or delete the node', async () => {
  await load('custom')
  // Control first: the sentinel handler DOES see Backspace when the field is not focused.
  await page.mouse.click(20, 20)
  await page.keyboard.press('Backspace')
  let { events } = await log()
  assert(events.some((e) => e.includes('canvas delete key reached')), 'control failed: the delete sentinel never fires, so this test could not fail')
  await load('custom')
  // Select the node (single click on its body), then edit.
  const body = await page.locator(`${C} .react-flow__node[data-id="live"] label`).boundingBox()
  await page.mouse.click(body!.x + 5, body!.y + body!.height / 2)
  await dblclickName()
  await page.keyboard.press('End')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete')
  const f = await field()
  assert(f.value === 'site.bala', `mechanism: the keys did not edit the field ("${f.value}")`)
  ;({ events } = await log())
  assert(!events.some((e) => e.includes('canvas delete key')), `editing keys leaked: ${events.join(' | ')}`)
  assert(!events.some((e) => e.includes('node deleted')), 'React Flow deleted the node')
  assert((await nodeTransform()) !== 'MISSING', 'node is gone')
  await page.keyboard.press('Escape')
})

test('dragging inside the field or on the pencil does not move the node (nodrag)', async () => {
  await load('custom')
  // Control: a drag on the node body DOES move it.
  const before = await nodeTransform()
  const body = await page.locator(`${C} .react-flow__node[data-id="live"] label`).boundingBox()
  await page.mouse.move(body!.x + 5, body!.y + body!.height / 2)
  await page.mouse.down(); await page.mouse.move(body!.x + 45, body!.y + body!.height / 2, { steps: 8 }); await page.mouse.up()
  const moved = await nodeTransform()
  assert(moved !== before, `control failed: dragging the body did not move the node (${before})`)
  await load('custom') // resets the canvas
  const start = await nodeTransform()
  // Pencil
  const n = await center(sel('node-title-name'))
  await page.mouse.move(n.x, n.y); await page.waitForTimeout(300)
  const pc = await center(sel('node-title-pencil'))
  await page.mouse.move(pc.x, pc.y)
  await page.mouse.down(); await page.mouse.move(pc.x - 50, pc.y + 30, { steps: 8 }); await page.mouse.up()
  assert((await nodeTransform()) === start, `dragging the pencil moved the node: ${start} → ${await nodeTransform()}`)
  // Field (the pencil press may have entered edit; make sure we're editing)
  if (!(await field()).exists) await dblclickName()
  const ic = await center(sel('node-title-input'))
  await page.mouse.move(ic.x, ic.y)
  await page.mouse.down(); await page.mouse.move(ic.x + 60, ic.y + 30, { steps: 8 }); await page.mouse.up()
  assert((await nodeTransform()) === start, `dragging in the field moved the node: ${start} → ${await nodeTransform()}`)
  assert((await field()).focused, 'field lost focus during the drag')
  await page.keyboard.press('Escape')
})

test('header stays 32px and the title text does not move between rest and editing', async () => {
  for (const key of ['default', 'custom']) {
    await load(key)
    const rest = await geometry()
    await dblclickName()
    const edit = await geometry()
    assert(rest.headerH === 32 && edit.headerH === 32, `${key}: header height ${rest.headerH} → ${edit.headerH}, expected 32`)
    assert(rest.nodeW === 212 && edit.nodeW === 212, `${key}: node width ${rest.nodeW} → ${edit.nodeW}, expected 212`)
    assert(Math.abs(edit.textLeft - rest.textLeft) <= 1, `${key}: text x ${rest.textLeft} → ${edit.textLeft} (moved > 1px)`)
    assert(Math.abs(edit.midY - rest.midY) <= 1, `${key}: text centre y ${rest.midY} → ${edit.midY} (moved > 1px)`)
    assert(rest.fontSize === edit.fontSize && rest.fontWeight === edit.fontWeight, `${key}: type changed ${rest.fontSize}/${rest.fontWeight} → ${edit.fontSize}/${edit.fontWeight}`)
    await page.keyboard.press('Escape')
  }
})

test('a 63-character name truncates with an ellipsis, keeps the node 212 wide, full name in the tooltip', async () => {
  await load('long')
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement
    const tag = el.parentElement!.querySelector('[data-slot="node-title-type"]') as HTMLElement
    const node = document.querySelector('[data-testid="live-node"]')!.getBoundingClientRect()
    return { text: el.textContent, title: el.title, sw: el.scrollWidth, cw: el.clientWidth, overflow: getComputedStyle(el).textOverflow, tagFits: tag.scrollWidth <= tag.clientWidth, nodeW: node.width }
  }, sel('node-title-name'))
  assert(r.text === LONG && LONG.length === 63, 'fixture is not the 63-char name')
  assert(r.sw > r.cw, `name does not overflow (scrollWidth ${r.sw} ≤ clientWidth ${r.cw}) — nothing to truncate`)
  assert(r.overflow === 'ellipsis', `text-overflow is ${r.overflow}`)
  assert(r.title === LONG, `title attribute is "${r.title}"`)
  assert(r.tagFits, 'the type tag shrank')
  assert(r.nodeW === 212, `node widened to ${r.nodeW}`)
})

test('duplicate shows the amber warning (with its explanation) before the type tag', async () => {
  await load('custom')
  assert((await page.locator(sel('node-title-warning')).count()) === 0, 'warning shown without duplicate')
  await load('duplicate')
  const w = await page.evaluate((C) => {
    const el = document.querySelector(`${C} [data-slot="node-title-warning"]`) as HTMLElement | null
    if (!el) return null
    const tag = document.querySelector(`${C} [data-slot="node-title-type"]`)!.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    return { title: el.title, svg: !!el.querySelector('svg'), w: b.width, h: b.height, color: getComputedStyle(el).color, before: b.right <= tag.left }
  }, C)
  assert(w, 'no warning icon')
  assert(w!.svg && w!.w === 16 && w!.h === 16, `warning icon box ${w!.w}×${w!.h}, svg ${w!.svg}`)
  assert(w!.title === DUP_MSG, `tooltip "${w!.title}"`)
  assert(w!.color === 'rgb(251, 191, 36)', `warning colour ${w!.color}, expected amber`)
  assert(w!.before, 'warning is not beside (before) the type tag')
})

test('IME: Enter while composing does not save; safety cap is silent', async () => {
  await load('custom')
  await dblclickName()
  await page.keyboard.type('x')
  await page.evaluate((s) => {
    document.querySelector(s)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
  }, sel('node-title-input'))
  await page.waitForTimeout(50)
  assert((await field()).exists && (await log()).renames.length === 0, 'Enter during composition saved the name')
  const f = await field()
  assert(f.maxLength === 120, `maxLength = ${f.maxLength}, expected 120`)
  const headerText = await page.locator(`${C} header`).innerText()
  assert(!/\d+\s*\/\s*\d+/.test(headerText), `a counter is visible: "${headerText}"`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(50)
  assert(JSON.stringify((await log()).renames) === '["x"]', 'plain Enter after composition did not save')
})

async function main() {
  let server: ViteDevServer | undefined
  let browser: Browser | undefined
  try {
    server = await createServer({ configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'error', // No watcher/HMR: a file event mid-run (Dropbox, a perturbation being
    // restored) would reload the page under the test.
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null } })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite gave no local URL')
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    let navigations = 0
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    await page.goto(`${url}node-title-sandbox.html`)
    await page.waitForFunction(() => !!(window as unknown as { __nodeTitleHarness?: unknown }).__nodeTitleHarness && !!document.querySelector('.react-flow__node[data-id="live"]'), null, { timeout: 30000 })
    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join('\n')))
    test('the page never reloaded under the test', () => assert(navigations === 1, `main frame navigated ${navigations}× (expected 1)`))
    await run('node title (inline rename)')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
