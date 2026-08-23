/**
 * MP4 · H.265 (HEVC) sink (opaque, matte flatten).
 *
 * HEVC gives noticeably better quality-per-byte than H.264 for the same bitrate
 * (helpful for retaining fine high-frequency detail), but WebCodecs HEVC encode
 * requires a HARDWARE H.265 encoder — present on Apple platforms and
 * hardware-accelerated Chrome, absent on many Linux/older setups. So this sink
 * is capability-gated: `isSupported()` asks MediaBunny whether `hevc` actually
 * encodes on this machine, and the registry only surfaces the format where it
 * does (H.264 remains the universal fallback).
 *
 * Like H.264, HEVC (as tagged here) carries no alpha, so every incoming frame is
 * flattened onto `opts.matte` (default `#000000`) before encoding.
 *
 * Container caveat: MediaBunny tags HEVC in MP4 as `hev1` (Main, 8-bit 4:2:0).
 * Safari / QuickTime play it directly; some NLEs prefer the `hvc1` tagging and
 * may balk on import — an honest note, not a blocker.
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

export function makeHevcSink(): FrameSink {
  let out!: Output<Mp4OutputFormat, BufferTarget>
  let src!: VideoSampleSource
  let matteCanvas!: OffscreenCanvas
  let mctx!: OffscreenCanvasRenderingContext2D
  let o!: SinkOpts

  return {
    id: 'mp4-hevc',
    label: 'MP4 · H.265',
    supportsAlpha: false,
    output: 'file',
    tier: 'free',
    fileExt: 'mp4',

    async isSupported() {
      // Gate strictly on real encodability: HEVC needs a hardware H.265 encoder,
      // so only surface this format where MediaBunny can actually encode `hevc`
      // (same code path `begin()` takes). Elsewhere the H.264 sink covers MP4.
      try {
        const codec = await getFirstEncodableVideoCodec(['hevc'], {
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
      src = new VideoSampleSource({ codec: 'hevc', quality: qualityFor(o.quality, o.width, o.height) })
      out.addVideoTrack(src)
      await out.start()

      matteCanvas = new OffscreenCanvas(opts.width, opts.height)
      const ctx = matteCanvas.getContext('2d')
      if (!ctx) throw new Error('[export] mp4-hevc: OffscreenCanvas 2D context unavailable')
      mctx = ctx
    },

    async addFrame(vf, ts) {
      // Flatten straight-alpha frame onto the matte — hevc (Main) has no alpha.
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
