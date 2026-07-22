/**
 * RandomDisplay — Custom component for the Random node.
 * Shows the computed value (matching GLSL rounding) and a Randomise button.
 */

import { useEffect } from 'react'
import { IconButton } from '@/components/IconButton'
import { useGraphStore } from '@/stores/graphStore'
import { hashNodeId } from '@/nodes/input/random'
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
  // Clamp to toFixed's valid range [0, 100]. A negative decimals (e.g. scrubbed
  // below the param's min) would otherwise throw `RangeError: toFixed() digits
  // argument must be between 0 and 100` mid-render and crash the whole editor.
  const dpRaw = Math.round((data.decimals as number) ?? 7)
  const dp = Number.isFinite(dpRaw) ? Math.min(100, Math.max(0, dpRaw)) : 7
  // Match the shader exactly: both generators bake the hash truncated to 6
  // decimals (`hashNodeId(id).toFixed(6)` in random.ts). Using the full-precision
  // hash here made the on-node readout diverge from the rendered value at the
  // 6th–7th decimal.
  const hash = Number(hashNodeId(nodeId).toFixed(6))

  // Match GLSL: floor(raw / stepSize + 0.5) * stepSize
  const stepSize = Math.pow(10, -dp)
  const raw = min + (((seed + hash) % 1 + 1) % 1) * (max - min)
  const value = Math.round(raw / stepSize) * stepSize

  const handleRandomise = () => {
    updateNodeData(nodeId, { params: { ...data, seed: Math.random() } })
  }

  return (
    <div className={ds.randomDisplay.root}>
      <span className={ds.randomDisplay.value}>
        {value.toFixed(dp)}
      </span>
      <IconButton
        icon="shuffle"
        onClick={handleRandomise}
        className={ds.button.solid}
        title="Randomise"
      />
    </div>
  )
}
