/**
 * The Section Header (collapsible Transform header, Figma 993:3777) driven
 * through its sandbox harness in headless Chrome: real component, real DOM,
 * real pointer and keyboard input. No GPU needed.
 *
 * Every check pairs the outcome with proof the mechanism ran, because a
 * header that never re-renders, or a popover that is never mounted, would
 * otherwise "pass" by staying in its starting state:
 *  - toggle: aria-expanded AND the chevron's computed rotation flip, AND the
 *    harness logged onToggle(next) — so the flip came from the callback, not
 *    from a fixture reload; aria-controls resolves to the mounted body.
 *  - count: the "· N" badge equals the number of wired-param controls ticked,
 *    and the gathered dot is mounted exactly when N > 0 and the section is shut.
 *  - popover: hovering the gathered dot mounts role=tooltip listing EXACTLY the
 *    wired param labels (and their sources); the button's aria-describedby
 *    points at it; onGatherHoverChange(true) fired. Keyboard focus shows it too.
 *  - drag-over: with the page clock paused, the header is a drop target at once
 *    (computed background is the highlight token), still shut at 390 ms, open at
 *    410 ms with onToggle(true) logged. Pointer path: leaving early cancels.
 *  - reduced motion: the chevron transitions `transform` normally and nothing
 *    under prefers-reduced-motion: reduce.
 *
 * Run: npm run verify:section-header-ui        (needs Chrome)
 *      npm run verify:section-header-ui -- --shots <dir>   also writes a PNG per fixture
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const ROOT = resolve(import.meta.dirname, '..')
const shotsIdx = process.argv.indexOf('--shots')
const SHOTS = shotsIdx > 0 ? resolve(process.argv[shotsIdx + 1]) : null

let page: Page

const HEADER = '[data-testid=stage] [data-state]'
const TOGGLE = `${HEADER} button[aria-expanded]`
const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Pause the PAGE clock a little ahead of the page's own (fake) now. */
const pauseClock = async () => page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100)

async function fixture(key: string) {
  await page.click(`[data-fixture="${key}"]`)
  await page.mouse.move(1200, 880) // park the pointer away from the stage
  await realWait(60)
}

interface HeaderView {
  state: string | null
  expanded: string | null
  dropActive: boolean
  rotate: string
  chevronTransition: string
  rootBg: string
  count: string | null
  gather: boolean
  tooltip: { id: string; params: string[]; sources: string[]; hint: string } | null
  describedBy: string | null
  controls: string | null
  controlsResolves: boolean
  log: string[]
  wiredTicked: number
}

async function view(): Promise<HeaderView> {
  return page.evaluate(({ HEADER, TOGGLE }) => {
    const root = document.querySelector(HEADER) as HTMLElement
    const btn = document.querySelector(TOGGLE) as HTMLButtonElement
    const svg = btn.querySelector('svg') as SVGElement
    const tip = root.querySelector('[role=tooltip]')
    const countEl = btn.querySelector('[data-count]')
    const controls = btn.getAttribute('aria-controls')
    return {
      state: root.getAttribute('data-state'),
      expanded: btn.getAttribute('aria-expanded'),
      dropActive: root.getAttribute('data-drop-active') === 'true',
      rotate: getComputedStyle(svg).rotate,
      chevronTransition: getComputedStyle(svg).transitionProperty,
      rootBg: getComputedStyle(root).backgroundColor,
      count: countEl ? countEl.textContent : null,
      gather: !!root.querySelector('[data-gather]'),
      tooltip: tip ? {
        id: tip.id,
        params: [...tip.querySelectorAll(':scope > div > span:first-child')].map((s) => (s.textContent ?? '').replace(/^→\s*/, '')),
        sources: [...tip.querySelectorAll(':scope > div > span:last-child')].map((s) => (s.textContent ?? '').replace(/^from\s*/, '')),
        hint: tip.querySelector(':scope > span')?.textContent ?? '',
      } : null,
      describedBy: btn.getAttribute('aria-describedby'),
      controls,
      controlsResolves: !!(controls && document.getElementById(controls)),
      log: [...document.querySelectorAll('[data-testid=log] span.text-mono-id')].map((s) => (s.textContent ?? '').replace(/^\S+\s+/, '')),
      wiredTicked: document.querySelectorAll('[data-control^="wire-"]:checked').length,
    }
  }, { HEADER, TOGGLE })
}

const isCollapsedRotation = (r: string) => r === '-90deg' || r === '270deg'
const isOpenRotation = (r: string) => r === 'none' || r === '0deg'

// ── toggle ──────────────────────────────────────────────────────────────────
test('toggle: aria-expanded and chevron flip through onToggle, both ways', async () => {
  await fixture('a2')
  const a = await view()
  assert(a.expanded === 'false' && a.state === 'collapsed', `A2 should start collapsed, got aria-expanded=${a.expanded} state=${a.state}`)
  assert(isCollapsedRotation(a.rotate), `collapsed chevron should be rotated -90deg, got ${a.rotate}`)

  await page.click(TOGGLE)
  await realWait(40)
  const b = await view()
  assert(b.log[0] === 'onToggle(true)', `click did not go through onToggle(true); log head = ${b.log[0]}`)
  assert(b.expanded === 'true' && b.state === 'open', `after click: aria-expanded=${b.expanded} state=${b.state}`)
  assert(isOpenRotation(b.rotate), `open chevron should be unrotated, got ${b.rotate}`)
  assert(b.controlsResolves, `aria-controls="${b.controls}" does not resolve to the mounted section body`)

  await page.click(TOGGLE)
  await realWait(40)
  const c = await view()
  assert(c.log[0] === 'onToggle(false)', `second click did not call onToggle(false); log head = ${c.log[0]}`)
  assert(c.expanded === 'false' && isCollapsedRotation(c.rotate), `after second click: aria-expanded=${c.expanded} rotate=${c.rotate}`)
})

// ── count + gathered dot ────────────────────────────────────────────────────
test('count badge shows N and the gathered dot exists only while shut with wires', async () => {
  const cases: Array<[string, number]> = [['a1', 0], ['one', 1], ['a2', 2], ['all', 4], ['five', 5]]
  for (const [key, n] of cases) {
    await fixture(key)
    const v = await view()
    assert(v.wiredTicked === n, `fixture ${key}: harness has ${v.wiredTicked} wired controls ticked, fixture table expects ${n}`)
    if (n === 0) {
      assert(v.count === null, `${key}: no wires, but a count "${v.count}" is shown`)
      assert(!v.gather, `${key}: no wires, but a gathered dot is mounted`)
    } else {
      assert(v.count === `· ${n}`, `${key}: count should read "· ${n}", got ${JSON.stringify(v.count)}`)
      assert(v.gather, `${key}: ${n} wires but no gathered dot`)
    }
  }
  // Expanded: dot and count go away (A4).
  await fixture('a4')
  const open = await view()
  assert(open.expanded === 'true', 'A4 should be open')
  assert(open.count === null && !open.gather, `A4 expanded must drop dot and count; count=${open.count} gather=${open.gather}`)
  // Live: ticking one more wire control moves the badge.
  await fixture('a2')
  await page.check('[data-control="wire-srt_translateX"]')
  await realWait(40)
  const three = await view()
  assert(three.count === '· 3' && three.wiredTicked === 3, `ticking a third wire should read "· 3", got ${three.count}`)
})

// ── popover ─────────────────────────────────────────────────────────────────
test('hovering the gathered dot shows a tooltip listing exactly the wired params', async () => {
  await fixture('a2')
  const before = await view()
  assert(before.tooltip === null, 'popover visible before any hover')

  await page.hover('[data-testid=gather-dot]')
  await realWait(40)
  const v = await view()
  assert(v.tooltip !== null, 'no role=tooltip after hovering the gathered dot')
  assert(JSON.stringify(v.tooltip!.params) === JSON.stringify(['Scale', 'Rotate']), `tooltip params ${JSON.stringify(v.tooltip!.params)} ≠ ["Scale","Rotate"]`)
  assert(JSON.stringify(v.tooltip!.sources) === JSON.stringify(['Noise.value', 'Time.time']), `tooltip sources ${JSON.stringify(v.tooltip!.sources)}`)
  assert(v.tooltip!.hint === 'Click to open Transform', `hint = "${v.tooltip!.hint}"`)
  assert(v.describedBy === v.tooltip!.id, `button aria-describedby=${v.describedBy} does not point at the tooltip ${v.tooltip!.id}`)
  assert(v.log.includes('onGatherHoverChange(true)'), 'onGatherHoverChange(true) never fired')

  await page.mouse.move(1200, 880)
  await realWait(40)
  const after = await view()
  assert(after.tooltip === null && after.describedBy === null, 'tooltip did not go away when the pointer left the dot')
  assert(after.log[0] === 'onGatherHoverChange(false)', `leaving the dot should log onGatherHoverChange(false); head = ${after.log[0]}`)

  // All five wired: the list is the five labels, in param order.
  await fixture('five')
  await page.hover('[data-testid=gather-dot]')
  await realWait(40)
  const five = await view()
  assert(JSON.stringify(five.tooltip?.params) === JSON.stringify(['Scale X', 'Scale Y', 'Rotate', 'Offset X', 'Offset Y']), `five-wire tooltip lists ${JSON.stringify(five.tooltip?.params)}`)
})

test('clicking the gathered dot opens the section', async () => {
  await fixture('a2')
  await page.click('[data-testid=gather-dot]')
  await realWait(40)
  const v = await view()
  assert(v.log.includes('onToggle(true)'), 'dot click did not call onToggle(true)')
  assert(v.expanded === 'true', `dot click left aria-expanded=${v.expanded}`)
})

test('keyboard focus on the header shows the tooltip; blur hides it', async () => {
  await fixture('a2')
  // Tab from the last fixture button until the header button holds focus.
  await page.focus('[data-fixture="all"]')
  let focused = false
  for (let i = 0; i < 20 && !focused; i++) {
    await page.keyboard.press('Tab')
    focused = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), TOGGLE)
  }
  assert(focused, 'could not Tab onto the header button')
  await realWait(40)
  const v = await view()
  assert(v.tooltip !== null && v.describedBy === v.tooltip.id, 'keyboard focus did not show the tooltip')
  assert(JSON.stringify(v.tooltip!.params) === JSON.stringify(['Scale', 'Rotate']), `focus tooltip params ${JSON.stringify(v.tooltip!.params)}`)
  await page.keyboard.press('Tab')
  await realWait(40)
  const w = await view()
  assert(w.tooltip === null, 'tooltip stayed after focus left the header')
})

// ── drag-over → open after the dwell ─────────────────────────────────────────
test('drag-over: drop target at once, opens at 400 ms not before (paused clock)', async () => {
  await fixture('a1')
  const idle = await view()
  assert(!idle.dropActive && idle.expanded === 'false', 'A1 should be collapsed and idle')
  const idleBg = idle.rootBg

  await pauseClock()
  try {
    await page.click('[data-action="simulate-drag"]')
    // Real time for the 150 ms colour transition (CSS runs on the real clock,
    // not the paused page clock), so the computed background has settled.
    await realWait(300)
    const lit = await view()
    assert(lit.dropActive, 'simulated drag-over did not enter the drop-target state')
    assert(lit.rootBg !== idleBg && /rgba\(99, 102, 241, 0\.15\)/.test(lit.rootBg), `drop target background should be the highlight token, got ${lit.rootBg} (idle ${idleBg})`)

    await page.clock.runFor(390)
    await realWait(40)
    const early = await view()
    assert(early.expanded === 'false' && !early.log.includes('onToggle(true)'), `opened before the 400 ms dwell (at 390 ms): aria-expanded=${early.expanded}`)

    await page.clock.runFor(20)
    await realWait(40)
    const late = await view()
    assert(late.log[0] === 'onToggle(true)', `dwell elapsed but onToggle(true) not called; log head = ${late.log[0]}`)
    assert(late.expanded === 'true' && !late.dropActive, `after 410 ms: aria-expanded=${late.expanded} dropActive=${late.dropActive}`)
  } finally {
    await page.clock.resume()
  }
})

test('drag-over via pointer while connecting: leaving early cancels, staying opens', async () => {
  await fixture('a2')
  await page.check('[data-control="connecting"]')
  const box = (await page.locator(TOGGLE).boundingBox())!
  await pauseClock()
  try {
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2)
    await realWait(40)
    const over = await view()
    assert(over.dropActive, 'pointer over the collapsed header while connecting did not light it up')
    await page.clock.runFor(200)
    await page.mouse.move(1200, 880)
    await realWait(40)
    const left = await view()
    assert(!left.dropActive, 'leaving the header did not clear the drop target')
    await page.clock.runFor(1000)
    await realWait(40)
    const cancelled = await view()
    assert(cancelled.expanded === 'false', 'section opened although the pointer left before the dwell')

    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2)
    await page.clock.runFor(410)
    await realWait(40)
    const opened = await view()
    assert(opened.expanded === 'true' && opened.log[0] === 'onToggle(true)', `staying over the header for 410 ms did not open it (aria-expanded=${opened.expanded})`)
  } finally {
    await page.clock.resume()
  }
})

test('an open header is never a drop target', async () => {
  await fixture('a4')
  await page.selectOption('[data-control="dropActive"]', 'true')
  await realWait(40)
  const v = await view()
  assert(v.expanded === 'true' && !v.dropActive, `open header showed drop-target state (dropActive=${v.dropActive})`)
})

// ── reduced motion ──────────────────────────────────────────────────────────
test('reduced motion: chevron transitions transform normally, nothing when reduced', async () => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await fixture('a2')
  const normal = await view()
  assert(/transform/.test(normal.chevronTransition), `chevron should transition transform, got "${normal.chevronTransition}"`)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await realWait(40)
  const reduced = await view()
  assert(reduced.chevronTransition === 'none', `reduced motion should disable the chevron transition, got "${reduced.chevronTransition}"`)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

// ── optional screenshots for eyeballing ──────────────────────────────────────
test('screenshots (only with --shots)', async () => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const key of ['a1', 'a2', 'a3', 'a4', 'd1a', 'one', 'five', 'long', 'all']) {
    await fixture(key)
    await realWait(80)
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
    await page.clock.install()
    await page.goto(new URL('sandbox.html?c=section-header&solo=1', url).href)
    await page.waitForSelector(TOGGLE, { timeout: 30000 })
    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join('\n')))
    await run('section header UI')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
