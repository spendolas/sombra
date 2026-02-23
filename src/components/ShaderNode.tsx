/**
 * ShaderNode - Visual component for shader nodes on the canvas
 */

import { memo, useCallback } from 'react'
import { Position, useEdges, type NodeProps } from '@xyflow/react'
import type { NodeData, NodeParameter } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { NodeParameters, FloatSlider } from './NodeParameters'
import { useGraphStore } from '../stores/graphStore'
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle, BaseNodeContent } from '@/components/base-node'
import { LabeledHandle } from '@/components/labeled-handle'
import { BaseHandle } from '@/components/base-handle'
import { cn } from '@/lib/utils'

import { getPortColor } from '../utils/port-colors'

/**
 * Check if a param is visible given current param values
 */
function isParamVisible(param: NodeParameter, currentValues: Record<string, unknown>, allParams: NodeParameter[]): boolean {
  if (param.hidden) return false
  if (!param.showWhen) return true
  return Object.entries(param.showWhen).every(
    ([key, val]) => (currentValues[key] ?? allParams.find((p) => p.id === key)?.default) === val
  )
}

/**
 * Try to resolve a static float value from a source node's output.
 * Returns the value for constant sources, null for dynamic/computed sources.
 */
function resolveSourceFloat(sourceType: string, sourceParams: Record<string, unknown>): number | null {
  if (sourceType === 'float_constant') {
    return (sourceParams.value as number) ?? 1.0
  }
  return null
}

export const ShaderNode = memo(({ id, data }: NodeProps) => {
  const edges = useEdges()
  const allNodes = useGraphStore((state) => state.nodes)
  const nodeData = data as NodeData
  const definition = nodeRegistry.get(nodeData.type)
  const updateNodeData = useGraphStore((state) => state.updateNodeData)
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange)

  const currentValues = nodeData.params || ({} as Record<string, unknown>)

  const handleParamChange = useCallback(
    (paramId: string, value: unknown) => {
      updateNodeData(id, {
        params: {
          ...(nodeData.params || {}),
          [paramId]: value,
        },
      })
    },
    [id, nodeData.params, updateNodeData]
  )

  // Dynamic input +/- handlers (must be before early return)
  const inputCount = Number(currentValues.inputCount) || 2

  const handleAddInput = useCallback(() => {
    if (inputCount >= 8) return
    updateNodeData(id, {
      params: { ...currentValues, inputCount: inputCount + 1 },
    })
  }, [id, currentValues, inputCount, updateNodeData])

  const handleRemoveInput = useCallback(() => {
    if (inputCount <= 2) return
    const newCount = inputCount - 1
    // Remove edges connected to the deleted port
    const deletedPortId = `in_${newCount}`
    const edgesToRemove = edges
      .filter((e) => e.target === id && e.targetHandle === deletedPortId)
      .map((e) => ({ id: e.id, type: 'remove' as const }))
    if (edgesToRemove.length > 0) {
      onEdgesChange(edgesToRemove)
    }
    updateNodeData(id, {
      params: { ...currentValues, inputCount: newCount },
    })
  }, [id, currentValues, inputCount, edges, updateNodeData, onEdgesChange])

  if (!definition) {
    return (
      <div className="px-4 py-2 bg-surface-raised border border-edge rounded text-destructive">
        Unknown node: {nodeData.type}
      </div>
    )
  }

  const allParams = definition.params || []

  // Build sets of connected port IDs for this node
  const connectedInputs = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle)
  )
  const connectedOutputs = new Set(
    edges.filter((e) => e.source === id).map((e) => e.sourceHandle)
  )

  // Resolve inputs: use dynamicInputs when available
  const resolvedInputs = definition.dynamicInputs
    ? definition.dynamicInputs(currentValues)
    : definition.inputs

  // Partition: connectable params that are visible
  const connectableParams = allParams.filter(
    (p) => p.connectable && isParamVisible(p, currentValues, allParams)
  )
  const connectableIds = new Set(connectableParams.map((p) => p.id))

  // Pure inputs: those NOT shadowed by a connectable param
  const pureInputs = resolvedInputs.filter((inp) => !connectableIds.has(inp.id))

  // Non-connectable, visible params (enums, non-connectable floats, colors)
  const regularParams = allParams.filter(
    (p) => !p.connectable && isParamVisible(p, currentValues, allParams)
  )

  // Dynamic input flag
  const hasDynamicInputs = !!definition.dynamicInputs

  return (
    <BaseNode className="min-w-[160px] bg-surface-elevated">
      <BaseNodeHeader className="rounded-t-md bg-surface-raised border-b border-edge-subtle">
        <BaseNodeHeaderTitle className="text-sm text-fg">
          {definition.label}
        </BaseNodeHeaderTitle>
      </BaseNodeHeader>

      <BaseNodeContent>
        {/* Output handles (above inputs) */}
        {definition.outputs.map((output) => (
          <LabeledHandle
            key={output.id}
            type="source"
            position={Position.Right}
            id={output.id}
            title={output.label}
            handleClassName="!w-3 !h-3"
            labelClassName="text-xs"
            handleColor={getPortColor(output.type)}
            connected={connectedOutputs.has(output.id)}
          />
        ))}

        {/* Pure input handles */}
        {pureInputs.map((input) => (
          <LabeledHandle
            key={input.id}
            type="target"
            position={Position.Left}
            id={input.id}
            title={input.label}
            handleClassName="!w-3 !h-3"
            labelClassName="text-xs"
            handleColor={getPortColor(input.type)}
            connected={connectedInputs.has(input.id)}
          />
        ))}

        {/* +/- buttons for dynamic input nodes */}
        {hasDynamicInputs && (
          <div className="flex items-center justify-center gap-2 py-1">
            <button
              onClick={handleRemoveInput}
              disabled={inputCount <= 2}
              className={cn(
                "w-5 h-5 flex items-center justify-center rounded text-xs leading-none border border-edge",
                inputCount <= 2
                  ? "bg-surface-raised text-fg-muted cursor-default"
                  : "bg-surface-alt text-fg cursor-pointer"
              )}
            >
              -
            </button>
            <span className="text-[10px] text-fg-muted">
              {inputCount}
            </span>
            <button
              onClick={handleAddInput}
              disabled={inputCount >= 8}
              className={cn(
                "w-5 h-5 flex items-center justify-center rounded text-xs leading-none border border-edge",
                inputCount >= 8
                  ? "bg-surface-raised text-fg-muted cursor-default"
                  : "bg-surface-alt text-fg cursor-pointer"
              )}
            >
              +
            </button>
          </div>
        )}

        {/* Connectable param rows: handle + inline slider */}
        {connectableParams.map((param) => {
          const isConnected = connectedInputs.has(param.id)

          // Resolve source info when connected
          let displayValue = (currentValues[param.id] as number) ?? (param.default as number)
          let sourceLabel = ''
          let hasResolvedValue = false
          if (isConnected) {
            const edge = edges.find((e) => e.target === id && e.targetHandle === param.id)
            if (edge) {
              const sourceNode = allNodes.find((n) => n.id === edge.source)
              if (sourceNode) {
                const sourceDef = nodeRegistry.get(sourceNode.data.type)
                sourceLabel = sourceDef?.label || sourceNode.data.type
                const resolved = resolveSourceFloat(sourceNode.data.type, sourceNode.data.params || {})
                if (resolved !== null) {
                  displayValue = resolved
                  hasResolvedValue = true
                }
              }
            }
          }

          return (
            <div key={param.id} className="relative flex items-center">
              <BaseHandle
                type="target"
                position={Position.Left}
                id={param.id}
                handleColor={getPortColor(param.type)}
                connected={isConnected}
                className="!w-3 !h-3"
              />
              <div className="flex-1 pl-4 pr-1">
                {isConnected && !hasResolvedValue ? (
                  <div className="flex justify-between items-center py-0.5">
                    <span className="text-[10px] text-fg-subtle">
                      {param.label}
                    </span>
                    <span className="text-[10px] text-fg-muted">
                      {'← ' + sourceLabel}
                    </span>
                  </div>
                ) : (
                  <FloatSlider
                    param={param}
                    value={displayValue}
                    onChange={(value) => handleParamChange(param.id, value)}
                    disabled={isConnected}
                  />
                )}
              </div>
            </div>
          )
        })}

        {/* Non-connectable params (enums, sliders without handles) */}
        {regularParams.length > 0 && (
          <div className="mt-1 pt-2 w-full border-t border-edge-subtle">
            <NodeParameters
              nodeId={id}
              parameters={regularParams}
              currentValues={currentValues}
            />
          </div>
        )}

        {/* Custom component (if provided) */}
        {definition.component && (
          <div className={cn("mt-1 pt-2 w-full", regularParams.length === 0 && "border-t border-edge-subtle")}>
            <definition.component nodeId={id} data={currentValues} />
          </div>
        )}
      </BaseNodeContent>
    </BaseNode>
  )
})

ShaderNode.displayName = 'ShaderNode'
