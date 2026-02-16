/**
 * PropertiesPanel - Displays and edits properties for the selected node
 */

import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { NodeParameters } from './NodeParameters'

interface PropertiesPanelProps {
  selectedNode: Node<NodeData> | null
}

export function PropertiesPanel({ selectedNode }: PropertiesPanelProps) {
  if (!selectedNode) {
    return (
      <div>
        <h2
          className="text-xs font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-secondary)' }}
        >
          Properties
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Select a node to edit properties...
        </p>
      </div>
    )
  }

  const definition = nodeRegistry.get(selectedNode.data.type)

  if (!definition) {
    return (
      <div>
        <h2
          className="text-xs font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-secondary)' }}
        >
          Properties
        </h2>
        <p className="text-xs text-red-400">
          Unknown node type: {selectedNode.data.type}
        </p>
      </div>
    )
  }

  const hasParameters = definition.params && definition.params.length > 0

  return (
    <div>
      <h2
        className="text-xs font-semibold uppercase tracking-wider mb-3"
        style={{ color: 'var(--text-secondary)' }}
      >
        Properties
      </h2>

      {/* Node Info */}
      <div
        className="mb-4 p-3 rounded-lg"
        style={{
          backgroundColor: 'var(--bg-tertiary)',
          border: '1px solid var(--border-primary)'
        }}
      >
        <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: 'var(--text-tertiary)' }}>
          {definition.category}
        </div>
        <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
          {definition.label}
        </div>
        {definition.description && (
          <div className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {definition.description}
          </div>
        )}
        <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--border-secondary)' }}>
          <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            ID: {selectedNode.id}
          </div>
        </div>
      </div>

      {/* Inputs */}
      {definition.inputs.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
            Inputs
          </div>
          <div className="space-y-1">
            {definition.inputs.map((input) => (
              <div
                key={input.id}
                className="flex justify-between text-[11px] px-2 py-1 rounded"
                style={{ backgroundColor: 'var(--bg-tertiary)' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>{input.label}</span>
                <span
                  className="font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {input.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outputs */}
      {definition.outputs.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
            Outputs
          </div>
          <div className="space-y-1">
            {definition.outputs.map((output) => (
              <div
                key={output.id}
                className="flex justify-between text-[11px] px-2 py-1 rounded"
                style={{ backgroundColor: 'var(--bg-tertiary)' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>{output.label}</span>
                <span
                  className="font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {output.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Parameters */}
      {hasParameters && (
        <div className="mb-4">
          <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
            Parameters
          </div>
          <div
            className="p-3 rounded-lg"
            style={{
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)'
            }}
          >
            <NodeParameters
              nodeId={selectedNode.id}
              parameters={definition.params!}
              currentValues={selectedNode.data.params || {}}
            />
          </div>
        </div>
      )}

      {/* Custom Component */}
      {definition.component && (
        <div className="mb-4">
          <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
            Custom Controls
          </div>
          <div
            className="p-3 rounded-lg"
            style={{
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)'
            }}
          >
            <definition.component nodeId={selectedNode.id} data={selectedNode.data.params || {}} />
          </div>
        </div>
      )}
    </div>
  )
}
