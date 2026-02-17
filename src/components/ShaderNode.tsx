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

/**
 * Get color for port type (for visual differentiation)
 */
function getPortColor(type: string): string {
  switch (type) {
    case 'float':
      return '#d4d4d8'
    case 'vec2':
      return '#34d399'
    case 'vec3':
      return '#60a5fa'
    case 'vec4':
      return '#a78bfa'
    case 'color':
      return '#fbbf24'
    case 'sampler2D':
      return '#f472b6'
    case 'fnref':
      return '#22d3ee'
    default:
      return '#9ca3af'
  }
}

/**
 * Check if a param is visible given current param values
 */
function isParamVisible(param: NodeParameter, currentValues: Record<string, unknown>, allParams: NodeParameter[]): boolean {
  if (!param.showWhen) return true
  return Object.entries(param.showWhen).every(
    ([key, val]) => (currentValues[key] ?? allParams.find((p) => p.id === key)?.default) === val
  )
}

export const ShaderNode = memo(({ id, data }: NodeProps) => {
  const edges = useEdges()
  const definition = nodeRegistry.get((data as NodeData).type)
  const updateNodeData = useGraphStore((state) => state.updateNodeData)

  const handleParamChange = useCallback(
    (paramId: string, value: unknown) => {
      updateNodeData(id, {
        params: {
          ...((data as NodeData).params || {}),
          [paramId]: value,
        },
      })
    },
    [id, data, updateNodeData]
  )

  if (!definition) {
    return (
      <div className="px-4 py-2 bg-red-900 border border-red-700 rounded text-white">
        Unknown node: {(data as NodeData).type}
      </div>
    )
  }

  const currentValues = (data as NodeData).params || ({} as Record<string, unknown>)
  const allParams = definition.params || []

  // Build sets of connected port IDs for this node
  const connectedInputs = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle)
  )
  const connectedOutputs = new Set(
    edges.filter((e) => e.source === id).map((e) => e.sourceHandle)
  )

  // Partition: connectable params that are visible
  const connectableParams = allParams.filter(
    (p) => p.connectable && isParamVisible(p, currentValues, allParams)
  )
  const connectableIds = new Set(connectableParams.map((p) => p.id))

  // Pure inputs: those NOT shadowed by a connectable param
  const pureInputs = definition.inputs.filter((inp) => !connectableIds.has(inp.id))

  // Non-connectable params (enums, non-connectable floats, colors)
  const regularParams = allParams.filter(
    (p) => !p.connectable && isParamVisible(p, currentValues, allParams)
  )

  return (
    <BaseNode className="min-w-[160px]" style={{ backgroundColor: 'var(--bg-elevated)' }}>
      <BaseNodeHeader
        className="rounded-t-md"
        style={{
          backgroundColor: 'var(--bg-tertiary)',
          borderBottom: '1px solid var(--border-secondary)',
        }}
      >
        <div>
          <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
            {definition.category}
          </div>
          <BaseNodeHeaderTitle className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {definition.label}
          </BaseNodeHeaderTitle>
        </div>
      </BaseNodeHeader>

      <BaseNodeContent>
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

        {/* Connectable param rows: handle + inline slider */}
        {connectableParams.map((param) => {
          const isConnected = connectedInputs.has(param.id)
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
              <div className={`flex-1 pl-4 pr-1 ${isConnected ? 'opacity-40 pointer-events-none' : ''}`}>
                <FloatSlider
                  param={param}
                  value={(currentValues[param.id] as number) ?? (param.default as number)}
                  onChange={(value) => handleParamChange(param.id, value)}
                />
              </div>
            </div>
          )
        })}

        {/* Output handles */}
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

        {/* Non-connectable params (enums, sliders without handles) */}
        {regularParams.length > 0 && (
          <div className="mt-1 pt-2 w-full" style={{ borderTop: '1px solid var(--border-secondary)' }}>
            <NodeParameters
              nodeId={id}
              parameters={regularParams}
              currentValues={currentValues}
            />
          </div>
        )}

        {/* Custom component (if provided) */}
        {definition.component && (
          <div className="mt-1 pt-2 w-full" style={regularParams.length === 0 ? { borderTop: '1px solid var(--border-secondary)' } : {}}>
            <definition.component nodeId={id} data={currentValues} />
          </div>
        )}
      </BaseNodeContent>
    </BaseNode>
  )
})

ShaderNode.displayName = 'ShaderNode'
