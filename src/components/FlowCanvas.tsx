/**
 * FlowCanvas - React Flow canvas with drag-and-drop support
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ReactFlow, Background, MiniMap, useNodesInitialized, useReactFlow } from '@xyflow/react'
import type { Node, Edge, NodeTypes, OnNodesChange, OnEdgesChange, OnReconnect, Connection, IsValidConnection } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { areTypesCompatible } from '../nodes/type-coercion'
import { useGraphStore } from '../stores/graphStore'
import { makeNodeId } from '../utils/node-id'
import { ZoomSlider } from '@/components/zoom-slider'
import { NodesPanelOverlay } from '@/components/NodesPanelOverlay'
import { getFitViewPadding } from '@/components/nodes-panel-layout'
import { useSettingsStore } from '@/stores/settingsStore'
import { TypedEdge } from './TypedEdge'
import { ds } from '@/generated/ds'
import { FileDropOverlay, type FileDropOverlayState } from '@/components/FileDropOverlay'
import {
  classifyDropFiles,
  dropClassificationKey,
  type DropFileDescriptor,
  type FileDropFormatId,
} from '@/utils/file-drop'
import { normalizeGraphImages } from '@/utils/process-image'
import { importFromFile, readSombraFile } from '@/utils/sombra-file'
import {
  confirmProjectReplacement,
  importDroppedImageNodes,
  importDroppedProject,
} from '@/utils/file-drop-import'

const EDGE_TYPES = { typed: TypedEdge } as const

function isFileTransfer(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0
    || Array.from(dataTransfer.types).some((type) => type.toLowerCase() === 'files')
    || Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files)
  if (files.length > 0) return files
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

function descriptorsFromDataTransfer(dataTransfer: DataTransfer): DropFileDescriptor[] {
  const files = filesFromDataTransfer(dataTransfer)
  if (files.length > 0) return files.map((file) => ({ name: file.name, type: file.type }))
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => ({ name: '', type: item.type }))
}

function defaultParamsFor(nodeType: string): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const param of nodeRegistry.get(nodeType)?.params ?? []) {
    if (param.default !== undefined) params[param.id] = param.default
  }
  return params
}

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
  const { screenToFlowPosition, fitView, getViewport, setViewport, viewportInitialized } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const [fileDropState, setFileDropState] = useState<FileDropOverlayState | null>(null)
  const fileDragDepth = useRef(0)
  const fileDropPreviewKey = useRef('')
  const fileDropBusy = useRef(false)

  // Keep the canvas CENTRE fixed when the flow area resizes (panel drags, preview
  // dock, window resize). React Flow leaves the viewport transform untouched on
  // resize, which pins content to the top-left; shifting the viewport by half the
  // size delta re-anchors it to the centre instead. Zoom is unaffected — the delta
  // is in screen pixels, which is exactly the viewport translation's space.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const prevSize = useRef<{ w: number; h: number } | null>(null)
  const initialFitStarted = useRef(false)
  const initialFitComplete = useRef(false)

  // Frame the restored graph only after React Flow has measured the actual node
  // DOM. A fixed delay races persisted `measured` metadata, node mounting, and
  // the resizable panel's first layout. Two animation frames let that layout
  // commit before fitView reads the canvas dimensions. While this runs, the
  // resize observer below records size changes but must not adjust the viewport
  // that fitView is actively calculating.
  useEffect(() => {
    if (!viewportInitialized || !nodesInitialized || nodes.length === 0 || initialFitStarted.current) return

    let cancelled = false
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (cancelled || initialFitStarted.current) return
        initialFitStarted.current = true
        void fitView({
          padding: getFitViewPadding(useSettingsStore.getState().nodesPanelOpen),
          duration: 200,
        }).then(() => {
          if (cancelled) return
          const rect = wrapperRef.current?.getBoundingClientRect()
          if (rect) prevSize.current = { w: rect.width, h: rect.height }
          initialFitComplete.current = true
        })
      })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [fitView, nodes.length, nodesInitialized, viewportInitialized])

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
      if (!initialFitComplete.current) return
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
  const addNodes = useGraphStore((s) => s.addNodes)
  const loadGraph = useGraphStore((s) => s.loadGraph)

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

  const onNodeDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onNodeDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const nodeType = event.dataTransfer.getData('application/reactflow')
      if (!nodeType) return

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })

      const newNode: Node<NodeData> = {
        id: makeNodeId(nodeType),
        type: 'shaderNode',
        position,
        data: {
          type: nodeType,
          params: defaultParamsFor(nodeType),
        },
      }

      onAddNode(newNode)
    },
    [screenToFlowPosition, onAddNode]
  )

  const updateFileDropPreview = useCallback((dataTransfer: DataTransfer) => {
    const classification = classifyDropFiles(descriptorsFromDataTransfer(dataTransfer))
    const key = dropClassificationKey(classification)
    if (key !== fileDropPreviewKey.current) {
      fileDropPreviewKey.current = key
      setFileDropState({ kind: 'preview', classification })
    }
    return classification
  }, [])

  const onFileDragEnter = useCallback((event: React.DragEvent) => {
    if (!isFileTransfer(event.dataTransfer) || fileDropBusy.current) return
    event.preventDefault()
    event.stopPropagation()
    fileDragDepth.current += 1
    updateFileDropPreview(event.dataTransfer)
  }, [updateFileDropPreview])

  const onFileDragOver = useCallback((event: React.DragEvent) => {
    if (!isFileTransfer(event.dataTransfer) || fileDropBusy.current) return
    event.preventDefault()
    event.stopPropagation()
    const classification = updateFileDropPreview(event.dataTransfer)
    event.dataTransfer.dropEffect = classification.status === 'accepted' ? 'copy' : 'none'
  }, [updateFileDropPreview])

  const onFileDragLeave = useCallback((event: React.DragEvent) => {
    if (!isFileTransfer(event.dataTransfer) || fileDropBusy.current) return
    event.stopPropagation()
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1)
    if (fileDragDepth.current === 0) {
      fileDropPreviewKey.current = ''
      setFileDropState(null)
    }
  }, [])

  const onFileDrop = useCallback(async (event: React.DragEvent) => {
    if (fileDropBusy.current) return
    const files = filesFromDataTransfer(event.dataTransfer)
    // Some Safari drops expose FileList but omit the conventional `Files`
    // transfer type, so the populated list is authoritative at drop time.
    if (!isFileTransfer(event.dataTransfer) && files.length === 0) return
    event.preventDefault()
    event.stopPropagation()

    fileDragDepth.current = 0
    fileDropPreviewKey.current = ''
    const classification = classifyDropFiles(files.map((file) => ({ name: file.name, type: file.type })))
    if (classification.status !== 'accepted') {
      setFileDropState(null)
      return
    }

    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    fileDropBusy.current = true
    setFileDropState({
      kind: 'busy',
      format: classification.format,
      fileCount: classification.fileCount,
    })

    const handlers: Record<FileDropFormatId, () => Promise<void>> = {
      image: async () => {
        // Sequential processing inside the importer caps peak bitmap/canvas
        // memory when several camera-sized images arrive together.
        const { nodes: imported, failures } = await importDroppedImageNodes(files, position)
        addNodes(imported)
        for (const failure of failures) {
          console.error(`[Sombra] Failed to import image "${failure.file.name}":`, failure.error)
        }
        if (failures.length > 0 && imported.length === 0) {
          window.alert('Sombra could not decode the dropped image file(s).')
        }
      },
      'sombra-project': async () => {
        const opened = await importDroppedProject(files[0], {
          confirmReplacement: confirmProjectReplacement,
          readFile: readSombraFile,
          validate: importFromFile,
          normalizeImages: normalizeGraphImages,
          loadGraph,
        })
        if (!opened) return
        requestAnimationFrame(() => requestAnimationFrame(() => {
          void fitView({
            padding: getFitViewPadding(useSettingsStore.getState().nodesPanelOpen),
            duration: 300,
          })
        }))
      },
    }

    try {
      await handlers[classification.format.id]()
    } catch (error) {
      console.error('[Sombra] Failed to import dropped file:', error)
      window.alert(error instanceof Error ? error.message : 'Sombra could not import the dropped file.')
    } finally {
      fileDropBusy.current = false
      setFileDropState(null)
    }
  }, [addNodes, fitView, loadGraph, screenToFlowPosition])

  return (
    <div
      ref={wrapperRef}
      className="relative w-full h-full"
      onDragEnterCapture={onFileDragEnter}
      onDragOverCapture={onFileDragOver}
      onDragLeaveCapture={onFileDragLeave}
      onDropCapture={(event) => { void onFileDrop(event) }}
    >
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
      onDragOver={onNodeDragOver}
      onDrop={onNodeDrop}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      minZoom={0.1}
      maxZoom={4}
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
    {fileDropState && <FileDropOverlay state={fileDropState} />}
    </div>
  )
}
