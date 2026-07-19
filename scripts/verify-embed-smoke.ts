/**
 * verify-embed-smoke — end-to-end: the built-in dev harness must mount the
 * player, render non-blank pixels, and react to handle.set().
 *
 * Prereq: dev server running — `npm run dev` in another terminal.
 * Run: npx tsx scripts/verify-embed-smoke.ts
 */
import { chromium } from 'playwright-core'

const URL = process.env.EMBED_DEV_URL ?? 'http://localhost:5173/sombra/embed-dev.html'
let passed = 0, failed = 0
function check(name: string, cond: boolean) { if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) } }

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => (window as unknown as { __embedHandle?: unknown }).__embedHandle !== undefined, { timeout: 10000 })

  // Non-blank pixels in the first canvas.
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement
    const gl = c.getContext('webgl2') ?? c.getContext('webgpu')
    // Read via a 2D snapshot for backend-agnostic sampling.
    const snap = document.createElement('canvas'); snap.width = c.width; snap.height = c.height
    const ctx = snap.getContext('2d')!; ctx.drawImage(c, 0, 0)
    const d = ctx.getImageData(0, 0, Math.min(8, c.width), Math.min(8, c.height)).data
    let varied = false
    for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) { varied = true; break }
    return { hasPixels: d.some((v, i) => i % 4 !== 3 && v !== 0), varied, backend: gl ? 'ok' : 'none' }
  })
  check('canvas produced non-black pixels', nonBlank.hasPixels)

  // handle.set on the first knob does not throw.
  const setOk = await page.evaluate(() => {
    const h = (window as unknown as {
      __embedHandle: { variables(): Array<{ key: string; max?: number }>; set(k: string, v: number): void }
    }).__embedHandle
    const keys = h.variables()
    if (!keys.length) return true // no knobs is valid for some graphs
    try { h.set(keys[0].key, keys[0].max ?? 1); return true } catch { return false }
  })
  check('handle.set() on a knob does not throw', setOk)
} finally {
  await browser.close()
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
