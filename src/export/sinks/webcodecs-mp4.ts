/**
 * MP4 · H.264 sink (opaque, matte flatten).
 *
 * H.264 (avc) carries no alpha channel, so every incoming frame is flattened
 * onto `opts.matte` (default `#000000`) before being handed to MediaBunny's
 * `VideoSampleSource`.
 */

import { Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, VideoSample, QUALITY_HIGH } from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'

export function makeMp4Sink(): FrameSink {
  let out!: Output<Mp4OutputFormat, BufferTarget>
  let src!: VideoSampleSource
  let matteCanvas!: OffscreenCanvas
  let mctx!: OffscreenCanvasRenderingContext2D
  let o!: SinkOpts

  return {
    id: 'mp4-h264',
    label: 'MP4 · H.264',
    supportsAlpha: false,
    output: 'file',
    tier: 'free',
    fileExt: 'mp4',

    async isSupported() {
      try {
        const result = await VideoEncoder.isConfigSupported({
          codec: 'avc1.42001f',
          width: 1280,
          height: 720,
          bitrate: 8e6,
        })
        return result.supported === true
      } catch {
        return false
      }
    },

    async begin(opts) {
      o = opts
      out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
      src = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_HIGH })
      out.addVideoTrack(src)
      await out.start()

      matteCanvas = new OffscreenCanvas(opts.width, opts.height)
      const ctx = matteCanvas.getContext('2d')
      if (!ctx) throw new Error('[export] mp4-h264: OffscreenCanvas 2D context unavailable')
      mctx = ctx
    },

    async addFrame(vf, ts) {
      // Flatten straight-alpha frame onto the matte — avc has no alpha channel.
      mctx.clearRect(0, 0, o.width, o.height)
      mctx.fillStyle = o.matte || '#000000'
      mctx.fillRect(0, 0, o.width, o.height)
      mctx.drawImage(vf, 0, 0)

      const s = new VideoSample(matteCanvas, { timestamp: ts / 1e6, duration: 1 / o.fps })
      await src.add(s)
      s.close()
    },

    async finish() {
      await out.finalize()
      // `out.target.buffer` is populated once `finalize()` resolves.
      return new Blob([out.target.buffer!], { type: 'video/mp4' })
    },
  }
}
