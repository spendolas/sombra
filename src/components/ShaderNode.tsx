/**
 * ShaderNode - Visual component for shader nodes on the canvas
 */

import { memo } from 'react'
import { Position, useEdges, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { NodeParameters } from './NodeParameters'
import { BaseNode, BaseNodeHeader, BaseNodeHeaderTitle, BaseNodeContent } from '@/components/base-node'
import { LabeledHandle } from '@/components/labeled-handle'

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

export const ShaderNode = memo(({ id, data }: NodeProps) => {
  const edges = useEdges()
  const definition = nodeRegistry.get((data as NodeData).type)

  if (!definition) {
    return (
      <div className="px-4 py-2 bg-red-900 border border-red-700 rounded text-white">
        Unknown node: {(data as NodeData).type}
      </div>
    )
  }

  const hasParameters = definition.params && definition.params.length > 0

  // Build sets of connected port IDs for this node
  const connectedInputs = new Set(
    edges.filter((e) => e.target === id).map((e) => e.targetHandle)
  )
  const connectedOutputs = new Set(
    edges.filter((e) => e.source === id).map((e) => e.sourceHandle)
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
        {/* Input handles */}
        {definition.inputs.map((input) => (
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

        {/* Parameters (if defined) */}
        {hasParameters && (
          <div className="mt-1 pt-2 w-full" style={{ borderTop: '1px solid var(--border-secondary)' }}>
            <NodeParameters
              nodeId={id}
              parameters={definition.params!}
              currentValues={(data as NodeData).params || ({} as Record<string, unknown>)}
            />
          </div>
        )}

        {/* Custom component (if provided) */}
        {definition.component && (
          <div className="mt-1 pt-2 w-full" style={!hasParameters ? { borderTop: '1px solid var(--border-secondary)' } : {}}>
            <definition.component nodeId={id} data={(data as NodeData).params || ({} as Record<string, unknown>)} />
          </div>
        )}
      </BaseNodeContent>
    </BaseNode>
  )
})

ShaderNode.displayName = 'ShaderNode'
