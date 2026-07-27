/**
 * Guards a WGSL uniformity trap: a texture fetch inside a branch on a CONNECTABLE
 * param. Wired, the condition becomes data-dependent and `textureSample` is illegal
 * ("must only be called from uniform control flow"). The failure is silent — the
 * renderer reports compile success, then the invalid pipeline drops the whole frame.
 *
 * Reeded Glass's frost was the only node affected; this keeps it that way by
 * GPU-compiling every textureInput node with each connectable float wired.
 *
 * Run: npx tsx scripts/verify-wired-texture-branch.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { chromium } from 'playwright-core'
import http from 'node:http'
import type { Node, Edge } from '@xyflow/react'

initializeNodeLibrary()
const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

interface Case { label: string; code: string }
const cases: Case[] = []

for (const def of nodeRegistry.getAll()) {
  const type = def.type
  const texPort = def.inputs.find((i) => i.textureInput)
  if (!texPort || !def.ir) continue
  const floats = (def.params ?? []).filter((p) => p.connectable && p.type === 'float')
  for (const p of floats) {
    // The driver MUST be fragment-dependent. A float_constant rides as a uniform,
    // so the branch condition stays uniform and Tint accepts textureSample — the
    // bug only appears when the value varies per fragment, e.g. noise.
    const nodes = [n('src', 'checkerboard'), n('fx', type), n('out', 'fragment_output'), n('nz', 'noise')]
    const edges = [
      e('e1', 'src', 'color', 'fx', texPort.id),
      e('e2', 'fx', def.outputs[0].id, 'out', 'color'),
      e('e3', 'nz', 'value', 'fx', p.id),
    ]
    const ir = compileGraphIR(nodes as never, edges as never)
    for (const [i, pass] of (ir?.passes ?? []).entries()) {
      cases.push({ label: `${type}.${p.id} wired [pass ${i}]`, code: pass.shaderCode })
    }
  }
}

async function main() {
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>t</title>') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  const results = await page.evaluate(async (list: Case[]) => {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu
    if (!gpu) return { supported: false, out: [] as Array<{ label: string; errors: string[] }> }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { supported: false, out: [] as Array<{ label: string; errors: string[] }> }
    const device = await adapter.requestDevice()
    const out: Array<{ label: string; errors: string[] }> = []
    for (const c of list) {
      const info = await device.createShaderModule({ code: c.code }).getCompilationInfo()
      out.push({ label: c.label, errors: info.messages.filter((m) => m.type === 'error').map((m) => m.message) })
    }
    device.destroy()
    return { supported: true, out }
  }, cases)
  await browser.close(); server.close()

  if (!results.supported) { console.log('WebGPU unavailable — skipped'); return }
  for (const r of results.out) {
    test(r.label, () => assert(r.errors.length === 0, r.errors.slice(0, 2).join(' ; ')))
  }
  await run(`wired-texture-branch (${results.out.length} shaders)`)
}
main()
