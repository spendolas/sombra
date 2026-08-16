/**
 * FlowCanvas - React Flow canvas with drag-and-drop support
 */

import { useCallback, useEffect, useRef } from 'react'
import { ReactFlow, Background, MiniMap, useReactFlow } from '@xyflow/react'
import type { Node, Edge, NodeTypes, OnNodesChange, OnEdgesChange, OnReconnect, Connection, IsValidConnection } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { areTypesCompatible } from '../nodes/type-coercion'
import { useGraphStore } from '../stores/graphStore'
import { ZoomSlider } from '@/components/zoom-slider'
import { NodesPanelOverlay } from '@/components/NodesPanelOverlay'
import { getFitViewPadding } from '@/components/nodes-panel-layout'
import { useSettingsStore } from '@/stores/settingsStore'
import { TypedEdge } from './TypedEdge'
import { ds } from '@/generated/ds'

const EDGE_TYPES = { typed: TypedEdge } as const

interface FlowCanvasProps {
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  nodeTypes: NodeTypes
  onNodesChange: OnNodesChange<Node<NodeData>>
  onEdgesChange: OnEdgesChange<Edge<EdgeData>>
  onConnect: (connection: Connection) => void
  onAddNode: (node: Node<NodeData>) => void
}

export function FlowCanvas({
  nodes,
  edges,
  nodeTypes,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onAddNode,
}: FlowCanvasProps) {
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow()

  const onInit = useCallback(() => {
    setTimeout(() => fitView({ padding: getFitViewPadding(useSettingsStore.getState().nodesPanelOpen), duration: 200 }), 50)
  }, [fitView])

  // Keep the canvas CENTRE fixed when the flow area resizes (panel drags, preview
  // dock, window resize). React Flow leaves the viewport transform untouched on
  // resize, which pins content to the top-left; shifting the viewport by half the
  // size delta re-anchors it to the centre instead. Zoom is unaffected — the delta
  // is in screen pixels, which is exactly the viewport translation's space.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const prevSize = useRef<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      const prev = prevSize.current
      prevSize.current = { w: width, h: height }
      // First callback establishes the baseline; also skip zero-size blips (a
      // panel momentarily collapsing) so re-showing doesn't shift by a full pane.
      if (!prev || !prev.w || !prev.h || !width || !height) return
      const dw = width - prev.w
      const dh = height - prev.h
      if (dw === 0 && dh === 0) return
      const vp = getViewport()
      setViewport({ x: vp.x + dw / 2, y: vp.y + dh / 2, zoom: vp.zoom })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [getViewport, setViewport])

  const edgeTypes = EDGE_TYPES

  // Track whether a reconnect succeeded
  const reconnectSuccessful = useRef(false)

  const replaceEdge = useGraphStore((s) => s.replaceEdge)
  const removeElements = useGraphStore((s) => s.removeElements)

  // Intercept deletion: React Flow's default flow emits node removes and
  // connected-edge removes as separate change events, producing TWO history
  // entries — one undo restored the node without its wires. Do the removal
  // atomically in the store and cancel React Flow's own deletion.
  const onBeforeDelete = useCallback(
    async ({ nodes: delNodes, edges: delEdges }: { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }) => {
      removeElements(delNodes.map((n) => n.id), delEdges.map((e) => e.id))
      return false
    },
    [removeElements]
  )

  // Handle edge reconnection (drag endpoint to new port).
  // Mirrors onConnect: rebuild edge data (fresh sourcePortType for coloring),
  // enforce single-wire-per-input, and record ONE undoable history entry —
  // React Flow's reconnectEdge() helper did none of that (kept stale data,
  // allowed duplicate edges into one handle, bypassed history).
  const onReconnect: OnReconnect = useCallback(
    (oldEdge, newConnection) => {
      if (!newConnection.source || !newConnection.target) return
      if (!newConnection.sourceHandle || !newConnection.targetHandle) return
      reconnectSuccessful.current = true

      const sourceNode = nodes.find((n) => n.id === newConnection.source)
      const sourceDef = sourceNode && nodeRegistry.get(sourceNode.data.type)
      const sourcePortType = sourceDef?.outputs.find((p) => p.id === newConnection.sourceHandle)?.type

      replaceEdge(oldEdge.id, {
        id: `${newConnection.source}-${newConnection.sourceHandle}-${newConnection.target}-${newConnection.targetHandle}`,
        source: newConnection.source,
        target: newConnection.target,
        sourceHandle: newConnection.sourceHandle,
        targetHandle: newConnection.targetHandle,
        type: 'typed',
        data: {
          sourcePort: newConnection.sourceHandle,
          targetPort: newConnection.targetHandle,
          sourcePortType,
        },
      } as Edge<EdgeData>)
    },
    [nodes, replaceEdge]
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
    <div ref={wrapperRef} style={{ width: '100%', height: '100%' }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={{ type: 'typed' }}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onBeforeDelete={onBeforeDelete}
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
      onInit={onInit}
      proOptions={{ hideAttribution: true }}
      style={{ width: '100%', height: '100%', backgroundColor: 'var(--surface)' }}
    >
      <Background
        color="var(--edge-subtle)"
        gap={16}
        style={{ backgroundColor: 'var(--surface)' }}
      />
      <NodesPanelOverlay />
      <ZoomSlider position="bottom-left" />
      <MiniMap
        className={ds.miniMap.root}
        nodeColor="var(--indigo)"
        nodeBorderRadius={2}
        maskColor="rgba(26, 26, 46, 0.7)"
        maskStrokeColor="var(--indigo)"
        maskStrokeWidth={1}
        bgColor="var(--surface-alt)"
        pannable
        zoomable
      />
    </ReactFlow>
    </div>
  )
}
