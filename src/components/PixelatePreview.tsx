/**
 * PixelatePreview — CSS checkerboard grid that matches the Pixelate node's
 * actual pixel block size. Compensates for React Flow zoom so cells always
 * appear at their true output pixel size on screen.
 */

import { useViewport } from '@xyflow/react'

export function PixelatePreview({ data }: { nodeId: string; data: Record<string, unknown> }) {
  const pixelSize = (data.pixelSize as number) ?? 8
  const { zoom } = useViewport()

  // Compensate for React Flow's transform: scale(zoom).
  // Cell size in node-space = pixelSize / zoom.
  // After zoom transform: (pixelSize / zoom) * zoom = pixelSize screen pixels.
  const cellSize = pixelSize / zoom

  return (
    <div
      className="w-full aspect-square rounded-sm nodrag nowheel"
      style={{
        background: `repeating-conic-gradient(var(--surface-elevated) 0% 25%, var(--surface-raised) 0% 50%) 0 0 / ${cellSize}px ${cellSize}px`,
      }}
    />
  )
}
