/**
 * PNG sequence sink (fflate zip of straight-alpha PNGs).
 *
 * Each `VideoFrame` is drawn to an `OffscreenCanvas` and encoded natively via
 * `convertToBlob({ type: 'image/png' })` — the canvas keeps straight alpha, and
 * PNG is lossless, so no colour or alpha data is lost. Frames are zipped with
 * `fflate` at `level: 0`: PNG is already deflate-compressed internally, so
 * re-compressing the zip entries would only spend CPU for no size benefit.
 */

import { zip } from 'fflate'
import type { FrameSink, SinkOpts } from '../frame-sink'

export function makePngSequenceSink(): FrameSink {
  let o!: SinkOpts
  let frames: { name: string; data: Uint8Array }[] = []
  let cv!: OffscreenCanvas
  let ctx!: OffscreenCanvasRenderingContext2D
  let n = 0

  return {
    id: 'png-sequence',
    label: 'PNG sequence',
    supportsAlpha: true,
    output: 'zip',
    tier: 'free',
    fileExt: 'zip',

    async isSupported() {
      return typeof OffscreenCanvas !== 'undefined'
    },

    async begin(opts) {
      o = opts
      frames = []
      n = 0
      cv = new OffscreenCanvas(opts.width, opts.height)
      const context = cv.getContext('2d')
      if (!context) throw new Error('[export] png-sequence: OffscreenCanvas 2D context unavailable')
      ctx = context
    },

    async addFrame(vf) {
      ctx.clearRect(0, 0, o.width, o.height)
      ctx.drawImage(vf, 0, 0)
      const blob = await cv.convertToBlob({ type: 'image/png' })
      const buf = new Uint8Array(await blob.arrayBuffer())
      frames.push({ name: `frame_${String(n++).padStart(5, '0')}.png`, data: buf })
    },

    async finish() {
      const files: Record<string, Uint8Array> = {}
      for (const f of frames) files[f.name] = f.data

      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)))
      })
      return new Blob([zipped], { type: 'application/zip' })
    },
  }
}
