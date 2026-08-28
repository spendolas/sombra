import { useStore } from '@xyflow/react'

const selector = (s: { transform: [number, number, number]; rfId: string }) => ({
  transform: s.transform,
  patternId: `cross-bg-${s.rfId}`,
})

interface CrossBackgroundProps {
  /** Canvas-space spacing between marks; scales with zoom so the grid tracks the canvas. */
  gap?: number
  /** Half-length of each cross arm, in SCREEN px. Constant across zoom. */
  armLength?: number
  /** Stroke width of the marks, in screen px. */
  lineWidth?: number
  color?: string
  /** Zoom at/above which the grid is fully opaque. */
  fadeStart?: number
  /** Zoom at/below which the grid is fully faded out (hidden). */
  fadeEnd?: number
}

/**
 * Cross-hatch canvas background. Behaves like React Flow's built-in
 * `<Background variant="cross">` — the grid pans and its spacing opens/closes
 * with zoom — EXCEPT each `+` mark stays a constant screen size instead of
 * scaling with zoom (the built-in multiplies mark size by zoom with no opt-out).
 */
export function CrossBackground({
  gap = 16,
  armLength = 3,
  lineWidth = 1,
  color = 'color-mix(in srgb, var(--edge-subtle) 50%, var(--surface))',
  fadeStart = 0.75,
  fadeEnd = 0.2,
}: CrossBackgroundProps) {
  const { transform, patternId } = useStore(selector)
  const [offsetX, offsetY, zoom] = transform

  // Grid spacing tracks the canvas (scales with zoom); mark arms do NOT.
  const scaledGap = gap * zoom || 1
  const c = scaledGap / 2 // mark center (square cell)

  // Fade the whole grid out as you zoom past fadeStart, gone by fadeEnd,
  // so deep zoom-out (the most-used level) stays quiet.
  const opacity = Math.max(0, Math.min(1, (zoom - fadeEnd) / (fadeStart - fadeEnd)))
  if (opacity === 0) return null

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      style={{ pointerEvents: 'none', zIndex: 0, opacity }}
      data-testid="cross-background"
    >
      <pattern
        id={patternId}
        x={offsetX % scaledGap}
        y={offsetY % scaledGap}
        width={scaledGap}
        height={scaledGap}
        patternUnits="userSpaceOnUse"
      >
        <path
          d={`M${c - armLength},${c} h${armLength * 2} M${c},${c - armLength} v${armLength * 2}`}
          stroke={color}
          strokeWidth={lineWidth}
        />
      </pattern>
      <rect x="0" y="0" width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}
