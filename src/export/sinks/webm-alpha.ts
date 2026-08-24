/**
 * WebM · alpha sink (transparent, MediaBunny `alpha: 'keep'`).
 *
 * Prefers VP9, falls back to AV1 only if VP9 can't be encoded. This ordering is
 * deliberate and load-bearing for the "hand a transparent file to a user" goal:
 * browsers composite **VP9** alpha in a bare `<video>` (and ffmpeg/editors read
 * it), whereas **AV1** alpha — stored as a separate Matroska BlockAdditional
 * stream — is NOT composited by `<video>` or ffmpeg; only alpha-aware decoders
 * (e.g. MediaBunny) read it, so an AV1-alpha file renders OPAQUE when dropped
 * into a page. AV1 is smaller, but that is worthless if the alpha is invisible
 * everywhere but MediaBunny. Alpha is preserved end-to-end: the frame's straight
 * alpha channel is encoded as VP9/AV1 alpha side data and carried by the WebM
 * container.
 */

import { Output, WebMOutputFormat, StreamTarget, VideoSampleSource, VideoSample } from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'
import { qualityFor } from './quality-map'
import { createAppendOnlyStreamTarget, type AppendOnlyStreamTargetBridge } from './stream-target-adapter'

export function makeWebmAlphaSink(): FrameSink {
  let out!: Output<WebMOutputFormat, StreamTarget>
  let src!: VideoSampleSource
  let o!: SinkOpts
  let codec: 'av1' | 'vp9' = 'vp9'
  let bridge: AppendOnlyStreamTargetBridge | undefined

  return {
    id: 'webm-alpha',
    label: 'WebM',
    supportsAlpha: true,
    output: 'file',
    tier: 'free',
    fileExt: 'webm',
    mimeType: 'video/webm',

    async isSupported() {
      try {
        // VP9 first — its alpha composites in a bare <video> (see file header).
        const vp9 = await VideoEncoder.isConfigSupported({
          codec: 'vp09.00.10.08',
          width: 1280,
          height: 720,
          bitrate: 8e6,
        })
        if (vp9.supported === true) {
          codec = 'vp9'
          return true
        }
        // AV1 only as a last resort (VP9 encode unavailable). Its alpha survives
        // in the file for MediaBunny-class decoders but not for <video>/ffmpeg.
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
        return false
      } catch {
        return false
      }
    },

    async probeSize(width, height) {
      // VP9 or AV1 must encode the REAL export size on this device — large frames
      // can exceed an encoder's max dimension even when 720p is fine. Lets the
      // modal gate before export instead of failing mid-run.
      try {
        const vp9 = await VideoEncoder.isConfigSupported({ codec: 'vp09.00.10.08', width, height, bitrate: 8e6 })
        if (vp9.supported === true) return true
        const av1 = await VideoEncoder.isConfigSupported({ codec: 'av01.0.04M.08', width, height, bitrate: 8e6 })
        return av1.supported === true
      } catch {
        return false
      }
    },

    async begin(opts, writable) {
      o = opts
      // Matroska is naturally streamable, but `appendOnly: true` guarantees the
      // monotonic-position emission the StreamTarget adapter asserts (no seeking
      // back to patch duration/seek metadata).
      bridge = createAppendOnlyStreamTarget(writable)
      out = new Output({ format: new WebMOutputFormat({ appendOnly: true }), target: bridge.target })
      src = new VideoSampleSource({ codec, quality: qualityFor(o.quality, o.width, o.height), alpha: 'keep' })
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
      // Finalize flushes all remaining bytes through the StreamTarget adapter
      // into the destination writable; then close it.
      await out.finalize()
      await bridge!.close()
    },

    async abort() {
      // begin() never ran → nothing to tear down (bridge/out are unset).
      if (!bridge) return
      // Stop the encoder and release the target (state → 'canceled'); then abort
      // the destination writable via the adapter (discards the FSA swap file,
      // releases the writer lock). Both best-effort.
      try {
        await out.cancel()
      } catch {
        /* not started / already finalized — best-effort */
      }
      await bridge.abort()
    },
  }
}
