/**
 * ShaderNode - Visual component for shader nodes on the canvas
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { NodeParameters } from './NodeParameters'

export const ShaderNode = memo(({ id, data, selected }: NodeProps) => {
  const definition = nodeRegistry.get((data as NodeData).type)

  if (!definition) {
    return (
      <div className="px-4 py-2 bg-red-900 border border-red-700 rounded text-white">
        Unknown node: {(data as NodeData).type}
      </div>
    )
  }

  const hasParameters = definition.params && definition.params.length > 0

  return (
    <div
      className={`rounded-lg min-w-[160px] shadow-lg ${
        selected
          ? 'border-2 border-[var(--accent-primary)] shadow-[var(--accent-primary)]/30'
          : 'border border-[var(--border-primary)]'
      }`}
      style={{ backgroundColor: 'var(--bg-elevated)' }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 border-b rounded-t-md"
        style={{
          backgroundColor: 'var(--bg-tertiary)',
          borderColor: 'var(--border-secondary)'
        }}
      >
        <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
          {definition.category}
        </div>
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
          {definition.label}
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-3">
        {/* Input handles */}
        {definition.inputs.map((input, idx) => (
          <div key={input.id} className="flex items-center mb-2 text-xs">
            <Handle
              type="target"
              position={Position.Left}
              id={input.id}
              style={{
                left: -8,
                top: 48 + idx * 24,
                width: 12,
                height: 12,
                background: getPortColor(input.type),
                border: '2px solid var(--bg-secondary)',
              }}
            />
            <span className="ml-2" style={{ color: 'var(--text-secondary)' }}>
              {input.label}
            </span>
          </div>
        ))}

        {/* Output handles */}
        {definition.outputs.map((output, idx) => (
          <div key={output.id} className="flex items-center justify-end mb-2 text-xs">
            <span className="mr-2" style={{ color: 'var(--text-secondary)' }}>
              {output.label}
            </span>
            <Handle
              type="source"
              position={Position.Right}
              id={output.id}
              style={{
                right: -8,
                top: 48 + idx * 24,
                width: 12,
                height: 12,
                background: getPortColor(output.type),
                border: '2px solid var(--bg-secondary)',
              }}
            />
          </div>
        ))}

        {/* Parameters (if defined) */}
        {hasParameters && (
          <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border-secondary)' }}>
            <NodeParameters
              nodeId={id}
              parameters={definition.params!}
              currentValues={data.params || {}}
            />
          </div>
        )}

        {/* Custom component (if provided, in addition to parameters) */}
        {definition.component && (
          <div className={hasParameters ? 'mt-2' : 'mt-2 pt-2'} style={hasParameters ? {} : { borderTop: '1px solid var(--border-secondary)' }}>
            <definition.component nodeId={id} data={data.params || {}} />
          </div>
        )}
      </div>
    </div>
  )
})

ShaderNode.displayName = 'ShaderNode'

/**
 * Get color for port type (for visual differentiation)
 * Brighter colors for better visibility on dark backgrounds
 */
function getPortColor(type: string): string {
  switch (type) {
    case 'float':
      return '#d4d4d8' // Light Gray
    case 'vec2':
      return '#34d399' // Bright Green
    case 'vec3':
      return '#60a5fa' // Bright Blue
    case 'vec4':
      return '#a78bfa' // Bright Purple
    case 'color':
      return '#fbbf24' // Bright Amber
    case 'sampler2D':
      return '#f472b6' // Bright Pink
    default:
      return '#9ca3af' // Default gray
  }
}
