/**
 * verify-embed-forward-compat — does the DEPLOYED player faithfully reproduce a
 * scene exported by the CURRENT editor?
 *
 * The existing smoke test only asserts "non-blank pixels" and "set() doesn't
 * throw", which cannot answer that: a player that silently ignored a new uniform,
 * or fell back to WebGL2 because the WGSL failed to compile, would still pass it.
 *
 * This does three things the smoke test does not:
 *   1. Exports a scene through the real `publishScene()` in the running editor, so
 *      the artifact is exactly what a user would publish today.
 *   2. Asserts the exported shader actually contains this session's codegen
 *      (reedPcg / rg_swm / rg_ms_ / vec3 reedLens), i.e. the export really is new.
 *   3. Mounts that artifact in the player fetched from the LIVE Pages deploy and
 *      checks the new uniforms are honoured — by driving each one and requiring the
 *      rendered pixels to change. A no-op uniform is the exact failure mode that
 *      "renders something" cannot detect.
 *
 * Prereq: a dev server. Defaults to the one this session started on 49950.
 * Run: npx tsx scripts/verify-embed-forward-compat.ts
 */

import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { decodePng } from './blur-bakeoff/lib/png'

const EDITOR = process.env.EDITOR_URL ?? 'http://localhost:49950/sombra/'
const PLAYER = process.env.PLAYER_URL
  ?? 'https://spendolas.github.io/sombra/embed/sombra-player.0.1.0.umd.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`) }
  else { failed++; console.error(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`) }
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
})

try {
  // ---- 1. export a scene from the live editor ------------------------------
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('console', (m) => { if (m.type() === 'error') console.error('    editor console:', m.text()) })
  // NOT networkidle: Vite's HMR websocket stays open, so it never fires.
  await page.goto(EDITOR, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __sombra?: unknown }).__sombra !== undefined, { timeout: 20000 })

  const exported = await page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const s: any = (window as any).__sombra
    s.stores.graph.getState().clear()
    await new Promise((r) => setTimeout(r, 250))

    // Deliberately STATIC and deterministic: no Time node (frames would differ
    // between the two captures) and no Random node (the player re-seeds those on
    // every mount by design, via randomizeOnLoad).
    const out = s.createNode('fragment_output', { x: 300, y: 0 })
    const chk = s.createNode('checkerboard', { x: -300, y: 0 })
    s.setParams(chk, { size: 90 })
    const rg = s.createNode('reeded_glass', { x: 0, y: 0 })
    s.setParams(rg, {
      ribWidth: 160, ior: 1.5, curvature: 0.8,
      bow: 1, grain: 0, frost: 0.4,
    })
    s.connect(chk, rg, 'color', 'source')
    s.connect(rg, out, 'color', 'color')
    await s.compile()
    await new Promise((r) => setTimeout(r, 500))

    const g = s.stores.graph.getState()
    const pub: any = await import('/sombra/src/embed/publish.ts')
    const res = pub.publishScene(g.nodes, g.edges)
    const art: any = await import('/sombra/src/embed/artifact.ts')
    const decoded = art.decodeArtifact(res.sceneB64)
    const plan = decoded.plan
    const wgsl = plan.wgsl
    return {
      rgNode: rg,
      sceneB64: res.sceneB64 as string,
      glsl: plan.passes.map((p: any) => p.fragmentShader).join('\n'),
      wgsl: wgsl ? wgsl.passes.map((p: any) => p.shaderCode).join('\n') : '',
      hasWgsl: !!wgsl,
      passCount: plan.passes.length,
      manifest: decoded.manifest.map((k: any) => k.key),
    }
  })

  console.log(`\n  exported: ${exported.passCount} passes, wgsl=${exported.hasWgsl}, ` +
    `artifact ${Math.round(exported.sceneB64.length / 1024)} KB b64`)

  // ---- 2. is the export actually carrying this session's codegen? ----------
  check('export contains reedPcg (frost rewrite)', exported.glsl.includes('reedPcg'))
  check('export contains rg_swm (seam sub-samples)', exported.glsl.includes('rg_swm'))
  check('export contains rg_ms_ (minification supersample)', exported.glsl.includes('rg_ms_'))
  check('reedLens returns vec3', /vec3 reedLens\(/.test(exported.glsl))
  check('WGSL half present', exported.hasWgsl && exported.wgsl.length > 0)
  check('WGSL uses textureSampleLevel (uniformity-safe)', exported.wgsl.includes('textureSampleLevel('))
  const bowKey = exported.manifest.find((k) => k.endsWith('bow') || k.includes('bow'))
  const grainKey = exported.manifest.find((k) => k.endsWith('grain') || k.includes('grain'))
  check('bow exposed as a knob', !!bowKey, bowKey ?? 'MISSING')
  check('grain exposed as a knob', !!grainKey, grainKey ?? 'MISSING')

  // ---- 3. mount it in the DEPLOYED player ---------------------------------
  const playerSrc = await (await fetch(PLAYER)).text()
  check('deployed player fetched', playerSrc.length > 10000, `${Math.round(playerSrc.length / 1024)} KB`)

  const tmp = path.join(os.tmpdir(), `sombra-fwd-${process.pid}`)
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'player.js'), playerSrc)
  fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;background:#000}#host{width:640px;height:480px}</style>
<div id="host"></div>
<script src="./player.js"></script>
<script>
  window.__err = [];
  window.onerror = (m) => window.__err.push(String(m));
  window.__ready = false;
  Sombra.mount(document.getElementById('host'), {
    scene: ${JSON.stringify(exported.sceneB64)},
    onLoad: (h) => { window.__handle = h; window.__ready = true; },
  });
</script>`)

  const pp = await browser.newPage({ viewport: { width: 800, height: 600 } })
  const pErrors: string[] = []
  pp.on('console', (m) => { if (m.type() === 'error') pErrors.push(m.text()) })
  pp.on('pageerror', (e) => pErrors.push(String(e)))
  await pp.goto('file://' + path.join(tmp, 'index.html'))
  const ready = await pp.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true,
    { timeout: 20000 }).then(() => true).catch(() => false)
  check('player mounted the new artifact', ready)

  if (ready) {
    // Reading a WebGPU canvas back in-page does NOT work: the surface texture is
    // consumed on present, so drawImage/toDataURL yield zeros even inside rAF (I
    // verified that on the editor canvas earlier). Playwright's element screenshot
    // captures the COMPOSITED frame instead, which is backend-agnostic and is what
    // a viewer actually sees.
    const sample = async (): Promise<{ mean: number[]; w: number; h: number }> => {
      const el = await pp.$('canvas')
      if (!el) throw new Error('no canvas in the player page')
      await pp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
      const img = decodePng(new Uint8Array(await el.screenshot({ type: 'png' })))
      let r = 0, g = 0, b = 0
      const n = img.width * img.height
      for (let i = 0; i < n; i++) { r += img.data[i * 4]; g += img.data[i * 4 + 1]; b += img.data[i * 4 + 2] }
      return { mean: [r / n, g / n, b / n], w: img.width, h: img.height }
    }

    const base = await sample()
    check('player rendered non-blank', base.mean[0] + base.mean[1] + base.mean[2] > 1,
      `mean rgb ${base.mean.map((v) => v.toFixed(1)).join(',')} @ ${base.w}x${base.h}`)

    const drive = async (key: string, a: number, b: number, label: string): Promise<void> => {
      await pp.evaluate(([k, v]: [string, number]) => (window as any).__handle.set(k, v), [key, a] as [string, number])
      const s1 = await sample()
      await pp.evaluate(([k, v]: [string, number]) => (window as any).__handle.set(k, v), [key, b] as [string, number])
      const s2 = await sample()
      const delta = Math.abs(s1.mean[0] - s2.mean[0]) + Math.abs(s1.mean[1] - s2.mean[1])
        + Math.abs(s1.mean[2] - s2.mean[2])
      check(`player honours ${label}`, delta > 0.05, `mean-rgb delta ${delta.toFixed(3)} across ${a} -> ${b}`)
    }

    if (bowKey) await drive(bowKey, 0, 1, 'bow (new param)')
    if (grainKey) await drive(grainKey, 0, 16, 'grain (new param)')
  }

  check('no player console/page errors', pErrors.length === 0,
    pErrors.length ? pErrors.slice(0, 2).join(' | ') : 'clean')

  fs.rmSync(tmp, { recursive: true, force: true })
} finally {
  await browser.close()
}

console.log('\n' + '='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
process.exit(failed ? 1 : 0)
