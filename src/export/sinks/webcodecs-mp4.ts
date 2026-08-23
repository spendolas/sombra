/**
 * MP4 video sink — H.265 (HEVC) preferred, automatic H.264-High fallback.
 *
 * HEVC gives noticeably better quality-per-byte than H.264 at the same bitrate
 * (helpful for retaining fine high-frequency detail), but WebCodecs HEVC encode
 * needs a HARDWARE H.265 encoder — present on Apple platforms and
 * hardware-accelerated Chrome, absent on many Linux/older machines. So this
 * single sink is adaptive: it asks MediaBunny (`getFirstEncodableVideoCodec`)
 * for the first codec that actually encodes on THIS machine, preferring `hevc`
 * and falling back to `avc` (which MediaBunny builds as AVC High, `avc1.6400XX`,
 * encodable on nearly every machine). That makes the MP4 card universally
 * available while transparently delivering HEVC quality where the hardware
 * allows.
 *
 * Both codecs here are opaque — neither carries alpha — so every incoming frame
 * is flattened onto `opts.matte` (default `#000000`) before encoding.
 *
 * Container caveat: MediaBunny tags HEVC in MP4 as `hev1` (Main, 8-bit 4:2:0).
 * Safari / QuickTime play it directly; some NLEs prefer the `hvc1` tagging and
 * may balk on import — an honest note, not a blocker.
 */

import {
  Output,
  Mp4OutputFormat,
  StreamTarget,
  VideoSampleSource,
  VideoSample,
  getFirstEncodableVideoCodec,
} from 'mediabunny'
import type { FrameSink, SinkOpts } from '../frame-sink'
import { qualityFor } from './quality-map'
import { createAppendOnlyStreamTarget, type AppendOnlyStreamTargetBridge } from './stream-target-adapter'

/** MP4 sink with the extra `usedCodec` field the done-state label reads. */
export interface Mp4Sink extends FrameSink {
  /** The codec actually chosen in `begin()` — null before begin(). */
  readonly usedCodec: 'hevc' | 'avc' | null
}

export function makeMp4Sink(): Mp4Sink {
  let out!: Output<Mp4OutputFormat, StreamTarget>
  let src!: VideoSampleSource
  let matteCanvas!: OffscreenCanvas
  let mctx!: OffscreenCanvasRenderingContext2D
  let o!: SinkOpts
  let codec!: NonNullable<Awaited<ReturnType<typeof getFirstEncodableVideoCodec>>>
  let bridge: AppendOnlyStreamTargetBridge | undefined
  // The codec actually picked in begin() — null until begin() runs.
  let usedCodec: 'hevc' | 'avc' | null = null
  // The codec `isSupported()` resolved at modal-open (the same probe begin() uses,
  // at 1080p). Lets the FORMAT card show the codec that WILL be used BEFORE export
  // — so a machine with no hardware HEVC encoder sees "MP4 · H.264" up front, not
  // a surprise fallback after the fact. null before the first probe.
  let probedCodec: 'hevc' | 'avc' | null = null

  // The label reflects the codec that will actually ship: the delivered codec
  // once begin() has run, else the probe result, defaulting to H.265 before the
  // probe resolves (getAvailableSinks awaits isSupported() before the card renders,
  // so by render time this is the real answer).
  const labelFor = (c: 'hevc' | 'avc' | null): string =>
    c === 'avc' ? 'MP4 · H.264' : 'MP4 · H.265'

  return {
    id: 'mp4',
    get label() {
      return labelFor(usedCodec ?? probedCodec)
    },
    get usedCodec() {
      return usedCodec
    },
    supportsAlpha: false,
    output: 'file',
    tier: 'free',
    fileExt: 'mp4',
    mimeType: 'video/mp4',

    async isSupported() {
      // Available if EITHER codec encodes on this machine — the same probe
      // `begin()` runs. AVC-High works on nearly all machines, so the MP4 card
      // is effectively universal; HEVC is used when its hardware encoder exists.
      try {
        const c = await getFirstEncodableVideoCodec(['hevc', 'avc'], {
          width: 1920,
          height: 1080,
          bitrate: 8e6,
        })
        // Narrow off the broad VideoCodec union — we only asked for hevc/avc.
        probedCodec = c === 'hevc' ? 'hevc' : c === 'avc' ? 'avc' : null
        return c !== null
      } catch {
        return false
      }
    },

    async begin(opts, writable) {
      o = opts
      // Pick the codec at encode time from the REAL export dims — HEVC preferred,
      // AVC-High fallback. Dimension-specific because a machine's hardware HEVC
      // encoder may accept 1080p but reject an unusual export size.
      const picked = await getFirstEncodableVideoCodec(['hevc', 'avc'], {
        width: opts.width,
        height: opts.height,
        bitrate: 8_000_000,
      })
      if (picked === null) {
        throw new Error(
          `[export] mp4: no encodable video codec (neither HEVC nor AVC) at ${opts.width}x${opts.height}`,
        )
      }
      codec = picked
      usedCodec = codec === 'hevc' ? 'hevc' : 'avc'

      // `fastStart: 'fragmented'` makes MP4 emission append-only (monotonic
      // positions), which the StreamTarget adapter asserts and requires.
      bridge = createAppendOnlyStreamTarget(writable)
      out = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: bridge.target })
      src = new VideoSampleSource({ codec, quality: qualityFor(o.quality, o.width, o.height) })
      out.addVideoTrack(src)
      await out.start()

      matteCanvas = new OffscreenCanvas(opts.width, opts.height)
      const ctx = matteCanvas.getContext('2d')
      if (!ctx) throw new Error('[export] mp4: OffscreenCanvas 2D context unavailable')
      mctx = ctx
    },

    async addFrame(vf, ts) {
      // Flatten straight-alpha frame onto the matte — hevc/avc have no alpha.
      mctx.clearRect(0, 0, o.width, o.height)
      mctx.fillStyle = o.matte || '#000000'
      mctx.fillRect(0, 0, o.width, o.height)
      mctx.drawImage(vf, 0, 0)

      const s = new VideoSample(matteCanvas, { timestamp: ts / 1e6, duration: 1 / o.fps })
      await src.add(s)
      s.close()
    },

    async finish() {
      // Finalize flushes the encoder and all remaining bytes through the
      // StreamTarget adapter into the destination writable; then close it.
      await out.finalize()
      await bridge!.close()
    },

    async abort() {
      // begin() never ran → nothing to tear down (bridge/out are unset).
      if (!bridge) return
      // Stop the encoder and release the target (state → 'canceled'), preventing
      // further sample adds; then abort the destination writable via the adapter
      // (discards the FSA swap file, releases the writer lock). Both best-effort.
      try {
        await out.cancel()
      } catch {
        /* not started / already finalized — best-effort */
      }
      await bridge.abort()
    },
  }
}
