import { Quality } from 'mediabunny'
import type { QualityLevel } from '../frame-sink'

/**
 * Turns the UI's 4 quality steps into a MediaBunny `Quality` with an EXPLICIT
 * numeric bitrate (scaled by pixel area).
 *
 * Why not the qualitative levels (`QUALITY_HIGH` etc.)? Those resolve to
 * *quantizer-based* encoding, which the WebCodecs **H.264** encoder does not
 * support — it throws "Unsupported configuration parameters." at real
 * resolutions (it only slipped through at tiny test sizes). An explicit bitrate
 * forces bitrate-based encoding, which every codec/encoder supports, and lets
 * MediaBunny size the H.264 level from the bitrate + dimensions.
 *
 * The Mbps figures mirror the export modal's size-estimate model, so the
 * estimate and the actual encode agree.
 */
// High/Max raised (16→20, 34→45) to retain more high-frequency detail (fine
// dither, noise) — lossy 4:2:0 has no 4:4:4 lever, so bitrate is the only knob.
// NOTE: the ExportModal size-estimate has its OWN hardcoded copy of this table
// (`[3.5, 8, 20, 45]` in ExportModal.tsx) — keep the two in sync.
const MBPS_AT_1080P: Record<QualityLevel, number> = { draft: 3.5, good: 8, high: 20, max: 45 }
const PIXELS_1080P = 1920 * 1080

export function qualityFor(level: QualityLevel, width: number, height: number): Quality {
  const scaled = MBPS_AT_1080P[level] * 1e6 * ((width * height) / PIXELS_1080P)
  // `bitrateMode: 'constant'` (CBR): mediabunny's default is 'variable' (VBR),
  // and on high-frequency content (fine dither/noise) Chrome's WebCodecs HEVC VBR
  // rate-control overshoots the target hard — measured ~2× the requested bitrate
  // on a real shader export (51 vs ~26 Mbps), Safari ~1×. CBR pins the encoder to
  // the target on both browsers, which ALSO makes the modal's size estimate honest
  // (the estimate assumes exactly this bitrate). Verified in-browser: 8 Mbps target
  // → VBR 9.4 / CBR 8.2 on Chrome HEVC.
  // Floor so very small exports still get a usable bitrate.
  return new Quality({ bitrate: Math.max(Math.round(scaled), 100_000), bitrateMode: 'constant' })
}
