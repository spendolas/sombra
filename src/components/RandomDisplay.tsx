/**
 * RandomDisplay — Custom component for the Random node.
 * Shows the computed value (matching GLSL rounding) and a Randomise button.
 */

import { useEffect } from 'react'
import { Shuffle } from 'lucide-react'
import { useGraphStore } from '@/stores/graphStore'
import { hashNodeId } from '@/nodes/input/random'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

export function RandomDisplay({
  nodeId,
  data,
}: {
  nodeId: string
  data: Record<string, unknown>
}) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData)

  // Auto-initialize seed on first render (unique per instance)
  useEffect(() => {
    if (data.seed === undefined || data.seed === 0) {
      updateNodeData(nodeId, { params: { ...data, seed: Math.random() } })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const seed = (data.seed as number) || 0
  const min = (data.min as number) ?? 0
  const max = (data.max as number) ?? 1
  const dp = Math.round((data.decimals as number) ?? 7)
  const hash = hashNodeId(nodeId)

  // Match GLSL: floor(raw / stepSize + 0.5) * stepSize
  const stepSize = Math.pow(10, -dp)
  const raw = min + (((seed + hash) % 1 + 1) % 1) * (max - min)
  const value = Math.round(raw / stepSize) * stepSize

  const handleRandomise = () => {
    updateNodeData(nodeId, { params: { ...data, seed: Math.random() } })
  }

  return (
    <div className={cn(ds.randomDisplay.root, "nodrag nowheel")}>
      <span className="text-fg text-mono-value tabular-nums">
        {value.toFixed(dp)}
      </span>
      <button
        onClick={handleRandomise}
        className={cn(
          ds.randomDisplay.button,
          "flex size-btn-sm items-center justify-center text-fg-dim transition-colors hover:bg-surface-raised hover:text-fg"
        )}
        title="Randomise"
      >
        <Shuffle size={12} />
      </button>
    </div>
  )
}
