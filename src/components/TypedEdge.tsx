/**
 * TypedEdge - Custom edge component with port-type color coding
 */

import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { EdgeData } from '../nodes/types'
import { PORT_COLORS } from '../utils/port-colors'

export function TypedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const edgeData = data as EdgeData | undefined
  const portType = edgeData?.sourcePortType as string | undefined
  const color = (portType && PORT_COLORS[portType]) ?? PORT_COLORS.default

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: color,
        strokeWidth: selected ? 2.5 : 1.5,
        opacity: selected ? 1 : 0.7,
      }}
    />
  )
}
