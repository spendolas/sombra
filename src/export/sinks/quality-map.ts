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
const MBPS_AT_1080P: Record<QualityLevel, number> = { draft: 3.5, good: 8, high: 16, max: 34 }
const PIXELS_1080P = 1920 * 1080

export function qualityFor(level: QualityLevel, width: number, height: number): Quality {
  const scaled = MBPS_AT_1080P[level] * 1e6 * ((width * height) / PIXELS_1080P)
  // Floor so very small exports still get a usable bitrate.
  return new Quality({ bitrate: Math.max(Math.round(scaled), 100_000) })
}
