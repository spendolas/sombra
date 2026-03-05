/**
 * PropertiesPanel - Displays and edits properties for the selected node
 */

import { useMemo } from 'react'
import type { Node } from '@xyflow/react'
import type { NodeData, NodeParameter } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { useGraphStore } from '../stores/graphStore'
import { NodeParameters, type SourceInfo } from './NodeParameters'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

interface PropertiesPanelProps {
  selectedNode: Node<NodeData> | null
}

/**
 * Try to resolve a static float value from a source node's output.
 */
function resolveSourceFloat(sourceType: string, sourceParams: Record<string, unknown>): number | null {
  if (sourceType === 'float_constant') {
    return (sourceParams.value as number) ?? 1.0
  }
  return null
}

export function PropertiesPanel({ selectedNode }: PropertiesPanelProps) {
  const edges = useGraphStore((state) => state.edges)
  const nodes = useGraphStore((state) => state.nodes)

  // Build set of connected input port IDs for this node (stable when no node selected)
  const connectedInputs = useMemo(() => {
    if (!selectedNode) return new Set<string>()
    return new Set(
      edges.filter((e) => e.target === selectedNode.id).map((e) => e.targetHandle!)
    )
  }, [edges, selectedNode])

  // Build source info map for connected params
  const connectedSources = useMemo(() => {
    if (!selectedNode) return new Map<string, SourceInfo>()
    const map = new Map<string, SourceInfo>()
    const incomingEdges = edges.filter((e) => e.target === selectedNode.id)
    for (const edge of incomingEdges) {
      if (!edge.targetHandle) continue
      const sourceNode = nodes.find((n) => n.id === edge.source)
      if (!sourceNode) continue
      const sourceDef = nodeRegistry.get(sourceNode.data.type)
      map.set(edge.targetHandle, {
        value: resolveSourceFloat(sourceNode.data.type, sourceNode.data.params || {}),
        sourceLabel: sourceDef?.label || sourceNode.data.type,
      })
    }
    return map
  }, [edges, selectedNode, nodes])

  if (!selectedNode) {
    return (
      <div>
        <h2 className="text-section mb-lg text-fg-dim">
          Properties
        </h2>
        <p className="text-body text-fg-muted">
          Select a node to edit properties...
        </p>
      </div>
    )
  }

  const definition = nodeRegistry.get(selectedNode.data.type)

  if (!definition) {
    return (
      <div>
        <h2 className="text-section mb-lg text-fg-dim">
          Properties
        </h2>
        <p className="text-body text-red-400">
          Unknown node type: {selectedNode.data.type}
        </p>
      </div>
    )
  }

  const currentValues = selectedNode.data.params || {}
  const allParams = definition.params || []

  // Filter params: apply hidden + showWhen (same logic as ShaderNode)
  const visibleParams = allParams.filter((p) => {
    if (p.hidden) return false
    if (p.showWhen) {
      return Object.entries(p.showWhen).every(
        ([key, val]: [string, string]) =>
          (currentValues[key] ?? allParams.find((pp: NodeParameter) => pp.id === key)?.default) === val
      )
    }
    return true
  })
  const hasParameters = visibleParams.length > 0

  // Resolve inputs (dynamic or static) for display
  const resolvedInputs = definition.dynamicInputs
    ? definition.dynamicInputs(selectedNode.data.params || {})
    : definition.inputs

  return (
    <div>
      <h2 className="text-section mb-lg text-fg-dim">
        Properties
      </h2>

      {/* Node Info */}
      <div className={cn(ds.propertiesPanel.nodeInfo, "mb-xl")}>
        <div className="text-category-meta mb-xs text-fg-subtle">
          {definition.category}
        </div>
        <div className="text-node-title mb-md text-fg">
          {definition.label}
        </div>
        {definition.description && (
          <div className="text-description text-fg-dim">
            {definition.description}
          </div>
        )}
        <Separator className="my-md" />
        <div className="text-mono-id text-fg-muted">
          ID: {selectedNode.id}
        </div>
      </div>

      {/* Inputs */}
      {resolvedInputs.length > 0 && (
        <div className="mb-xl">
          <Label className="text-section mb-md block text-fg-dim">
            Inputs
          </Label>
          <div className="flex flex-col gap-xs">
            {resolvedInputs.map((input) => (
              <div
                key={input.id}
                className={cn(ds.propertiesPanel.portRow, "text-port-type")}
              >
                <span className="text-fg-dim">{input.label}</span>
                <span className="text-mono-value text-fg-muted">
                  {input.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outputs */}
      {definition.outputs.length > 0 && (
        <div className="mb-xl">
          <Label className="text-section mb-md block text-fg-dim">
            Outputs
          </Label>
          <div className="flex flex-col gap-xs">
            {definition.outputs.map((output) => (
              <div
                key={output.id}
                className={cn(ds.propertiesPanel.portRow, "text-port-type")}
              >
                <span className="text-fg-dim">{output.label}</span>
                <span className="text-mono-value text-fg-muted">
                  {output.type}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Parameters */}
      {hasParameters && (
        <div className="mb-xl">
          <Label className="text-section mb-lg block text-fg-dim">
            Parameters
          </Label>
          <div className={ds.propertiesPanel.paramSection}>
            <NodeParameters
              nodeId={selectedNode.id}
              parameters={visibleParams}
              currentValues={currentValues}
              connectedInputs={connectedInputs}
              connectedSources={connectedSources}
            />
          </div>
        </div>
      )}

      {/* Custom Component */}
      {definition.component && (
        <div className="mb-xl">
          <Label className="text-section mb-lg block text-fg-dim">
            Custom Controls
          </Label>
          <div className={ds.propertiesPanel.paramSection}>
            <definition.component nodeId={selectedNode.id} data={selectedNode.data.params || {}} />
          </div>
        </div>
      )}
    </div>
  )
}
