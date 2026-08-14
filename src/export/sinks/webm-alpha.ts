/**
 * WebM · alpha sink (transparent, MediaBunny `alpha: 'keep'`).
 *
 * Prefers AV1 (better compression at a given quality); falls back to VP9 when
 * the browser can't encode AV1. Alpha is preserved end-to-end: the frame's
 * straight alpha channel is encoded as VP9/AV1 alpha side data and carried by
 * the WebM container.
 */

import { Output, WebMOutputFormat, BufferTarget, VideoSampleSource, VideoSample } from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'
import { QMAP } from './quality-map'

export function makeWebmAlphaSink(): FrameSink {
  let out!: Output<WebMOutputFormat, BufferTarget>
  let src!: VideoSampleSource
  let o!: SinkOpts
  let codec: 'av1' | 'vp9' = 'vp9'

  return {
    id: 'webm-alpha',
    label: 'WebM · alpha',
    supportsAlpha: true,
    output: 'file',
    tier: 'free',
    fileExt: 'webm',

    async isSupported() {
      try {
        const av1 = await VideoEncoder.isConfigSupported({
          codec: 'av01.0.04M.08',
          width: 1280,
          height: 720,
          bitrate: 8e6,
        })
        if (av1.supported === true) {
          codec = 'av1'
          return true
        }

        const vp9 = await VideoEncoder.isConfigSupported({
          codec: 'vp09.00.10.08',
          width: 1280,
          height: 720,
          bitrate: 8e6,
        })
        return vp9.supported === true
      } catch {
        return false
      }
    },

    async begin(opts) {
      o = opts
      out = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() })
      src = new VideoSampleSource({ codec, quality: QMAP[o.quality], alpha: 'keep' })
      out.addVideoTrack(src)
      await out.start()
    },

    async addFrame(vf, ts) {
      // `new VideoSample(vf, ...)` is a zero-cost wrapper around the SAME
      // VideoFrame (no clone) — `s.close()` below would close the caller's
      // `vf` directly. The export engine owns `vf` and closes it itself right
      // after `addFrame` returns, so we clone here and let `s.close()` close
      // only the clone, leaving the caller-owned frame open.
      const clone = vf.clone()
      const s = new VideoSample(clone, { timestamp: ts / 1e6, duration: 1 / o.fps })
      await src.add(s)
      s.close()
    },

    async finish() {
      await out.finalize()
      // `out.target.buffer` is populated once `finalize()` resolves.
      return new Blob([out.target.buffer!], { type: 'video/webm' })
    },
  }
}
