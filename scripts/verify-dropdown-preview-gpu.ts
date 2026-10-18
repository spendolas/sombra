/**
 * Dropdown preview, in the LIVE editor with a real mouse and keyboard: while a
 * node dropdown is open, the highlighted option is shown in the viewport but
 * NOT applied. Only a click (or Enter) applies it, as one undo step; Escape,
 * or the pointer leaving the list, puts the applied value back on screen.
 *
 * "Not applied" is checked where it would leak: the stored param, the undo
 * history, and the node's own thumbnail (compiled from the graph, not the
 * viewport). "Shown" is checked twice: the viewport's pixel, and the selected
 * mode's helper in the compiled shader — a pixel alone would pass if the
 * preview were skipped and the fixture happened to look the same.
 *
 * Fixture A (Stack blend): red bottom, blue top, both opaque. Normal → blue,
 * Multiply → near black, Screen → magenta.
 * Fixture B (a generic node dropdown): Noise's Type, through the ordinary
 * EnumSelect every node uses.
 *
 * Run: npm run verify:dropdown-preview:gpu   (needs Chrome)
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { resolve } from 'node:path'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { BLEND_MODES } from '../src/nodes/shared/blend-modes'

const ROOT = resolve(import.meta.dirname, '..')
const RED: [number, number, number, number] = [0.9, 0.1, 0.1, 1]
const BLUE: [number, number, number, number] = [0.1, 0.1, 0.9, 1]

interface Snap {
  pixel: number[]
  thumb: number[]
  blend: string
  noiseType: string
  past: number
  shader: string
  open: boolean
  errors: string[]
}

async function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, string> & { __sombra: any } // eslint-disable-line @typescript-eslint/no-explicit-any
    const s = w.__sombra
    const st = s.stores.graph.getState()
    const px = (cv: HTMLCanvasElement | null) => {
      if (!cv) return []
      const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(cv, 0, 0)
      return [...ctx.getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data]
    }
    // Render and read back in the same task (WebGPU presents and clears).
    s.renderer.markAllDirty?.()
    s.renderer.render()
    const pixel = px(s.renderer.canvas as HTMLCanvasElement)
    const stk = st.nodes.find((n: { id: string }) => n.id === w.__stk)
    const nz = st.nodes.find((n: { id: string }) => n.id === w.__nz)
    const c = s.stores.compiler.getState()
    return {
      pixel,
      thumb: px(document.querySelector(`.react-flow__node[data-id="${w.__stk}"] canvas`)),
      blend: stk?.data.params.layers.at(-1).blendMode ?? '',
      noiseType: nz?.data.params.noiseType ?? '(default)',
      past: st._past.length,
      shader: (c.wgslShader ?? '') + (c.fragmentShader ?? ''),
      open: !!document.querySelector('[role="listbox"]'),
      errors: c.errors.map((x: { message: string }) => x.message),
    }
  })
}

const settle = (page: Page) => page.waitForTimeout(900)
const isBlue = (p: number[]) => p[2] > 180 && p[0] < 60
const isDark = (p: number[]) => p[0] < 60 && p[1] < 60 && p[2] < 60
const isMagenta = (p: number[]) => p[0] > 180 && p[2] > 180 && p[1] < 120

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
    await page.waitForFunction(() => !!(window as unknown as { __sombra?: { renderer?: unknown } }).__sombra?.renderer, null, { timeout: 30000 })

    // ---- A · Stack blend ----------------------------------------------------
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
    await page.waitForTimeout(2500) // thumbnails too
    const base = await snap(page)
    test('fixture: blue on top, Normal, no errors', () => {
      assert(isBlue(base.pixel), `viewport ${base.pixel}, expected blue`)
      assert(isBlue(base.thumb), `thumbnail ${base.thumb}, expected blue`)
      assert(base.blend === 'normal', `top layer blend ${base.blend}`)
      assert(!base.shader.includes('sombra_blend_multiply'), 'fixture: the multiply helper is already in the shader, so its presence proves nothing')
      assert(base.errors.length === 0, base.errors.join(' | '))
    })

    const trigger = page.getByRole('combobox', { name: 'Layer 2 blend mode' })
    const option = (label: string) => page.getByRole('option', { name: label, exact: true })

    // Hover Multiply: shown, not applied.
    await trigger.click()
    await option('Multiply').hover()
    await settle(page)
    const hovered = await snap(page)
    test('hovering Multiply shows it in the viewport — and only there', () => {
      assert(hovered.open, 'the menu closed on hover')
      assert(hovered.shader.includes('sombra_blend_multiply'), 'the compiled shader has no multiply helper — the preview never reached the compiler')
      assert(isDark(hovered.pixel), `viewport ${hovered.pixel}, expected multiply(red, blue) ≈ black`)
      assert(hovered.blend === 'normal', `the stored blend became ${hovered.blend} on hover`)
      assert(hovered.past === base.past, `undo history grew on hover: ${base.past} → ${hovered.past}`)
      assert(isBlue(hovered.thumb), `the node thumbnail shows ${hovered.thumb} — it must keep the applied mode`)
    })

    // Arrow keys preview too.
    const nextMode = BLEND_MODES[BLEND_MODES.findIndex((m) => m.id === 'multiply') + 1].id
    await page.keyboard.press('ArrowDown')
    await settle(page)
    const keyed = await snap(page)
    test(`ArrowDown previews the next mode (${nextMode})`, () => {
      assert(keyed.shader.includes(`sombra_blend_${nextMode}`), `no sombra_blend_${nextMode} in the shader after ArrowDown`)
      assert(!keyed.shader.includes('sombra_blend_multiply'), 'multiply is still compiled after moving off it')
      assert(keyed.blend === 'normal' && keyed.past === base.past, `applied on a key move: blend ${keyed.blend}, history ${keyed.past}`)
    })

    // Escape: back to what was applied.
    await page.keyboard.press('Escape')
    await settle(page)
    const escaped = await snap(page)
    test('Escape closes and restores the applied mode', () => {
      assert(!escaped.open, 'menu still open')
      assert(isBlue(escaped.pixel), `viewport ${escaped.pixel}, expected blue again`)
      assert(escaped.shader === base.shader, `after Escape the shader is not the original: ${[...new Set(escaped.shader.match(/sombra_blend_\w+/g) ?? [])]} vs ${[...new Set(base.shader.match(/sombra_blend_\w+/g) ?? [])]}`)
      assert(escaped.blend === 'normal' && escaped.past === base.past, `Escape applied something: ${escaped.blend}, history ${escaped.past}`)
    })

    // Pointer leaves the list while open: restored, menu stays open.
    await trigger.click()
    await option('Multiply').hover()
    await settle(page)
    await page.mouse.move(1270, 890, { steps: 6 })
    await settle(page)
    const left = await snap(page)
    await page.keyboard.press('Escape')
    test('moving the pointer off the list restores the applied mode', () => {
      assert(left.open, 'fixture: the menu closed, so this tested Escape/close, not leaving the list')
      assert(isBlue(left.pixel), `viewport ${left.pixel} with the pointer off the list, expected blue`)
      assert(!left.shader.includes('sombra_blend_multiply'), 'multiply still compiled with nothing highlighted')
    })

    // Click: applied, one undo step.
    await settle(page)
    await trigger.click()
    await option('Screen').hover()
    await option('Screen').click()
    await settle(page)
    const picked = await snap(page)
    test('clicking Screen applies it, as one undo step', () => {
      assert(!picked.open, 'menu still open after the pick')
      assert(picked.blend === 'screen', `stored blend ${picked.blend}`)
      assert(picked.past === base.past + 1, `history ${base.past} → ${picked.past}, expected exactly one entry`)
      assert(isMagenta(picked.pixel), `viewport ${picked.pixel}, expected screen(red, blue) ≈ magenta`)
    })
    await page.evaluate(() => (window as unknown as { __sombra: any }).__sombra.stores.graph.getState().undo()) // eslint-disable-line @typescript-eslint/no-explicit-any
    await settle(page)
    const undone = await snap(page)
    test('one undo returns to Normal', () => {
      assert(undone.blend === 'normal' && isBlue(undone.pixel), `after undo: ${undone.blend}, ${undone.pixel}`)
    })

    // ---- B · an ordinary node dropdown (Noise › Type) ----------------------
    await page.evaluate(() => {
      const s = (window as unknown as { __sombra: any }).__sombra // eslint-disable-line @typescript-eslint/no-explicit-any
      s.clearGraph()
      const out = s.createNode('fragment_output', { x: 500, y: 0 })
      const nz = s.createNode('noise', { x: 120, y: 0 })
      s.connect(nz, out, 'value', 'color')
      ;(window as unknown as { __nz: string }).__nz = nz
    })
    await settle(page)
    const nBase = await snap(page)
    const nzId = await page.evaluate(() => (window as unknown as { __nz: string }).__nz)
    await page.locator(`.react-flow__node[data-id="${nzId}"] [role="combobox"]`).first().click()
    await option('Box').hover()
    await settle(page)
    const nHover = await snap(page)
    await page.keyboard.press('Escape')
    await settle(page)
    const nEsc = await snap(page)
    test('a node\'s own dropdown previews the same way (Noise › Type)', () => {
      assert(nBase.noiseType === '(default)' || nBase.noiseType === 'simplex', `fixture: noise type ${nBase.noiseType}`)
      assert(nHover.open, 'menu closed on hover')
      assert(nHover.shader !== nBase.shader, 'the shader did not change while hovering Box — no preview')
      assert(nHover.noiseType === nBase.noiseType && nHover.past === nBase.past, `applied on hover: ${nHover.noiseType}, history ${nBase.past} → ${nHover.past}`)
      assert(nEsc.shader === nBase.shader, 'after Escape the shader is not the original one')
    })

    test('no page errors', () => assert(pageErrors.length === 0, pageErrors.join(' | ')))
    await run('dropdown-preview-gpu')
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
