/**
 * FlowCanvas - React Flow canvas with drag-and-drop support
 */

import { useCallback, useRef, useMemo } from 'react'
import { ReactFlow, Background, MiniMap, useReactFlow, reconnectEdge } from '@xyflow/react'
import type { Node, Edge, OnNodesChange, OnEdgesChange, OnReconnect, Connection, IsValidConnection } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { areTypesCompatible } from '../nodes/type-coercion'
import { ZoomSlider } from '@/components/zoom-slider'
import { TypedEdge } from './TypedEdge'

interface FlowCanvasProps {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  nodeTypes: Record<string, React.ComponentType<any>>
  onNodesChange: OnNodesChange<Node<NodeData>>
  onEdgesChange: OnEdgesChange<Edge<EdgeData>>
  setEdges: (edges: Edge<EdgeData>[]) => void
  onConnect: (connection: Connection) => void
  onAddNode: (node: Node<NodeData>) => void
}

export function FlowCanvas({
  nodes,
  edges,
  nodeTypes,
  onNodesChange,
  onEdgesChange,
  setEdges,
  onConnect,
  onAddNode,
}: FlowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow()

  // Register custom edge types
  const edgeTypes = useMemo(() => ({ typed: TypedEdge }), [])

  // Track whether a reconnect succeeded
  const reconnectSuccessful = useRef(false)

  // Handle edge reconnection (drag endpoint to new port)
  const onReconnect: OnReconnect = useCallback(
    (oldEdge, newConnection) => {
      reconnectSuccessful.current = true
      setEdges(reconnectEdge(oldEdge, newConnection, edges) as Edge<EdgeData>[])
    },
    [edges, setEdges]
  )

  // Start of reconnect attempt
  const onReconnectStart = useCallback(() => {
    reconnectSuccessful.current = false
  }, [])

  // Delete edge when reconnect is dropped on empty space
  const onReconnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, edge: Edge<EdgeData>) => {
      if (!reconnectSuccessful.current) {
        onEdgesChange([{ id: edge.id, type: 'remove' }])
      }
    },
    [onEdgesChange]
  )

  // Validate connection based on port types
  const isValidConnection = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return false
      if (!connection.sourceHandle || !connection.targetHandle) return false

      // Find source and target nodes
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      if (!sourceNode || !targetNode) return false

      // Get node definitions
      const sourceDef = nodeRegistry.get(sourceNode.data.type)
      const targetDef = nodeRegistry.get(targetNode.data.type)
      if (!sourceDef || !targetDef) return false

      // Find the specific ports being connected
      const sourcePort = sourceDef.outputs.find((p) => p.id === connection.sourceHandle)
      // Check dynamic inputs (if available), then static inputs, then connectable params
      const targetInputs = targetDef.dynamicInputs
        ? targetDef.dynamicInputs(targetNode.data.params || {})
        : targetDef.inputs
      const targetPort = targetInputs.find((p) => p.id === connection.targetHandle)
        ?? targetDef.params?.find((p) => p.connectable && p.id === connection.targetHandle)
      if (!sourcePort || !targetPort) return false

      // Check if types are compatible (with coercion)
      return areTypesCompatible(sourcePort.type, targetPort.type as import('../nodes/types').PortType)
    },
    [nodes]
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const nodeType = event.dataTransfer.getData('application/reactflow')
      if (!nodeType) return

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      // Build default params from node definition
      const def = nodeRegistry.get(nodeType)
      const defaultParams: Record<string, unknown> = {}
      if (def?.params) {
        for (const p of def.params) {
          if (p.default !== undefined) {
            defaultParams[p.id] = p.default
          }
        }
      }

      const newNode: Node<NodeData> = {
        id: `${nodeType}-${Date.now()}`,
        type: 'shaderNode',
        position,
        data: {
          type: nodeType,
          params: defaultParams,
        },
      }

      onAddNode(newNode)
    },
    [screenToFlowPosition, onAddNode]
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={{ type: 'typed' }}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onReconnect={onReconnect}
      onReconnectStart={onReconnectStart}
      onReconnectEnd={onReconnectEnd}
      isValidConnection={isValidConnection as IsValidConnection<Edge<EdgeData>>}
      connectionRadius={20}
      onDragOver={onDragOver}
      onDrop={onDrop}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      minZoom={0.1}
      maxZoom={4}
      fitView
      proOptions={{ hideAttribution: true }}
      style={{ width: '100%', height: '100%', backgroundColor: 'var(--surface)' }}
    >
      <Background
        color="var(--edge-subtle)"
        gap={16}
        style={{ backgroundColor: 'var(--surface)' }}
      />
      <ZoomSlider position="bottom-left" />
      <MiniMap
        nodeColor="var(--indigo)"
        maskColor="rgba(15, 15, 26, 0.85)"
        bgColor="var(--surface)"
        style={{ backgroundColor: 'var(--surface-alt)' }}
      />
    </ReactFlow>
  )
}
