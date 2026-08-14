import { QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, type Quality } from 'mediabunny'
import type { QualityLevel } from '../frame-sink'

/** Maps the UI's 4 quality steps to MediaBunny quality levels. */
export const QMAP: Record<QualityLevel, Quality> = {
  draft: QUALITY_LOW,
  good: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  max: QUALITY_VERY_HIGH,
}
