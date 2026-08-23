/**
 * MP4 · H.264 sink (opaque, matte flatten).
 *
 * H.264 (avc) carries no alpha channel, so every incoming frame is flattened
 * onto `opts.matte` (default `#000000`) before being handed to MediaBunny's
 * `VideoSampleSource`.
 */

import {
  Output,
  Mp4OutputFormat,
  BufferTarget,
  VideoSampleSource,
  VideoSample,
  getFirstEncodableVideoCodec,
} from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'
import { qualityFor } from './quality-map'

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
      // Ask MediaBunny whether it can actually encode `avc` on THIS machine —
      // the same code path `begin()` takes below. The old baseline probe
      // (`VideoEncoder.isConfigSupported({codec:'avc1.42001f'})`) is a
      // false-negative on hardware-accelerated Chrome/Mac: the HW encoder
      // reports baseline unsupported yet encodes `avc` (which MediaBunny builds
      // as AVC High, `avc1.6400XX`) just fine. getFirstEncodableVideoCodec picks
      // whatever profile actually encodes, so H.264 becomes a universal fallback.
      try {
        const codec = await getFirstEncodableVideoCodec(['avc'], {
          width: 1920,
          height: 1080,
          bitrate: 8e6,
        })
        return codec !== null
      } catch {
        return false
      }
    },

    async begin(opts) {
      o = opts
      out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
      src = new VideoSampleSource({ codec: 'avc', quality: qualityFor(o.quality, o.width, o.height) })
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
