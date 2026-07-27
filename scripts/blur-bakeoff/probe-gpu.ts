// Capability probe for the bake-off test machine: what can headless Chrome
// actually do here? Phase 2 needs to know whether rgba16float render targets and
// EXT_color_buffer_float are available before it can prototype a
// higher-precision intermediate path. Run: npx tsx scripts/blur-bakeoff/probe-gpu.ts

import { chromium } from 'playwright-core'
import http from 'node:http'

async function main() {
  const server = http.createServer((_r, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>probe</title>')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/`)
    const report = await page.evaluate(async () => {
      const out: Record<string, unknown> = {}
      const gpu = (navigator as unknown as { gpu?: GPU }).gpu
      out.webgpu = !!gpu
      if (gpu) {
        try {
          const adapter = await gpu.requestAdapter()
          out.adapter = !!adapter
          if (adapter) {
            const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string } }).info
            out.adapterInfo = info ? `${info.vendor ?? '?'}/${info.architecture ?? '?'}` : 'unavailable'
            const device = await adapter.requestDevice()
            out.device = !!device
            for (const format of ['rgba8unorm', 'rgba16float', 'rgba32float'] as const) {
              try {
                const t = device.createTexture({
                  size: [8, 8],
                  format,
                  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
                })
                t.destroy()
                out[`rt_${format}`] = true
              } catch (e) {
                out[`rt_${format}`] = String(e).slice(0, 90)
              }
            }
            device.destroy()
          }
        } catch (e) {
          out.webgpuError = String(e).slice(0, 160)
        }
      }
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      out.webgl2 = !!gl
      if (gl) {
        out.glRenderer = String(gl.getParameter(gl.RENDERER)).slice(0, 70)
        out.glMaxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)
        out.glMaxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
        out.ext_color_buffer_float = !!gl.getExtension('EXT_color_buffer_float')
        out.ext_color_buffer_half_float = !!gl.getExtension('EXT_color_buffer_half_float')
        out.ext_float_blend = !!gl.getExtension('EXT_float_blend')
      }
      return out
    })
    for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(28)} ${String(v)}`)
  } finally {
    await browser.close()
    server.close()
  }
}

main()
