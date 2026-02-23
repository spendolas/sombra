import { useEffect, useRef, useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WebGLRenderer } from './webgl/renderer'
import { useLiveCompiler } from './compiler'
import { useGraphStore } from './stores/graphStore'
import { useSettingsStore } from './stores/settingsStore'
import { createSpectraWorleyRidged } from './utils/test-graph'
import { nodeRegistry } from './nodes/registry'
import { ShaderNode } from './components/ShaderNode'
import { NodePalette } from './components/NodePalette'
import { FlowCanvas } from './components/FlowCanvas'
import { PropertiesPanel } from './components/PropertiesPanel'
import { PreviewPanel } from './components/PreviewPanel'
import { FloatingPreview } from './components/FloatingPreview'
import { FullWindowOverlay } from './components/FullWindowOverlay'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)

  // Target refs for canvas reparenting
  const dockTargetRef = useRef<HTMLDivElement>(null)
  const floatTargetRef = useRef<HTMLDivElement>(null)
  const fullTargetRef = useRef<HTMLDivElement>(null)

  // Preview mode state
  const previewMode = useSettingsStore((s) => s.previewMode)
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const setPreviewMode = useSettingsStore((s) => s.setPreviewMode)
  const splitPct = useSettingsStore((s) => splitDirection === 'vertical' ? s.verticalSplitPct : s.horizontalSplitPct)
  const setSplitPct = useSettingsStore((s) => s.setSplitPct)

  // React Flow integration
  const nodes = useGraphStore((state) => state.nodes)
  const edges = useGraphStore((state) => state.edges)
  const onNodesChange = useGraphStore((state) => state.onNodesChange)
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange)
  const addNode = useGraphStore((state) => state.addNode)
  const addEdge = useGraphStore((state) => state.addEdge)
  const setNodes = useGraphStore((state) => state.setNodes)
  const setEdges = useGraphStore((state) => state.setEdges)

  // Handle new connections between nodes
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (!connection.sourceHandle || !connection.targetHandle) return

      // Single wire per input: remove existing edge to this target handle
      const existingEdge = edges.find(
        (e) => e.target === connection.target && e.targetHandle === connection.targetHandle
      )
      if (existingEdge) {
        onEdgesChange([{ id: existingEdge.id, type: 'remove' }])
      }

      // Resolve source port type for edge coloring
      const sourceNode = nodes.find((n) => n.id === connection.source)
      let sourcePortType: string | undefined
      if (sourceNode) {
        const def = nodeRegistry.get(sourceNode.data.type)
        const port = def?.outputs.find((p) => p.id === connection.sourceHandle)
        sourcePortType = port?.type
      }

      const newEdge = {
        id: `${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'typed',
        data: {
          sourcePort: connection.sourceHandle,
          targetPort: connection.targetHandle,
          sourcePortType,
        },
      }

      addEdge(newEdge)
    },
    [nodes, edges, addEdge, onEdgesChange]
  )

  // Register custom node types
  const nodeTypes = useMemo(() => ({ shaderNode: ShaderNode }), [])

  // Find selected node for properties panel
  const selectedNode = useMemo(() => {
    return nodes.find((node) => node.selected) || null
  }, [nodes])

  // Load test graph on mount (temporary for Phase 1 testing)
  useEffect(() => {
    const testGraph = createSpectraWorleyRidged()
    setNodes(testGraph.nodes)
    setEdges(testGraph.edges)
  }, [setNodes, setEdges])

  // Initialize WebGL renderer
  useEffect(() => {
    if (!canvasRef.current) return

    const renderer = new WebGLRenderer(canvasRef.current)
    rendererRef.current = renderer
    renderer.startAnimation()

    return () => {
      renderer.destroy()
    }
  }, [])

  // Reparent canvas into the active target container
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const targetMap = {
      docked: dockTargetRef.current,
      floating: floatTargetRef.current,
      fullwindow: fullTargetRef.current,
    }
    const target = targetMap[previewMode]
    if (target && canvas.parentElement !== target) {
      target.appendChild(canvas)
    }
  }, [previewMode, splitDirection])

  // Esc key exits fullwindow mode
  useEffect(() => {
    if (previewMode !== 'fullwindow') return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPreviewMode('docked')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewMode, setPreviewMode])

  // Live compiler - updates shader when graph changes
  const handleCompile = useCallback((result: { success: boolean; fragmentShader: string }) => {
    if (result.success && rendererRef.current) {
      const updateResult = rendererRef.current.updateShader(result.fragmentShader)
      if (!updateResult.success) {
        console.error('WebGL shader update failed:', updateResult.error)
      }
    }
  }, [])

  useLiveCompiler(handleCompile)

  // Determine center split direction based on mode
  const isDocked = previewMode === 'docked'

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen grid grid-cols-1 bg-surface">
        {/* Hidden canvas holder — canvas is always mounted here initially */}
        <div className="hidden">
          <canvas
            ref={canvasRef}
            className="w-full h-full block"
          />
        </div>

        <ResizablePanelGroup direction="horizontal">
          {/* Left — Node Palette */}
          <ResizablePanel id="palette" defaultSize="18%" minSize="12%" maxSize="30%">
            <div className="h-full p-4 overflow-y-auto bg-surface-alt border-r border-edge min-w-[160px]">
              <NodePalette />
            </div>
          </ResizablePanel>
          <ResizableHandle />

          {/* Center — Canvas + Preview */}
          <ResizablePanel id="center" defaultSize="64%">
            {isDocked ? (
              <ResizablePanelGroup key={splitDirection} direction={splitDirection} onLayoutChanged={(layout) => { if (layout.preview != null) setSplitPct(splitDirection, layout.preview) }}>
                <ResizablePanel id="canvas" defaultSize={`${100 - splitPct}%`} minSize="30%">
                  <div className="relative w-full h-full">
                    <FlowCanvas
                      nodes={nodes}
                      edges={edges}
                      nodeTypes={nodeTypes}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      setEdges={setEdges}
                      onConnect={onConnect}
                      onAddNode={addNode}
                    />
                  </div>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel id="preview" defaultSize={`${splitPct}%`} minSize="10%">
                  <PreviewPanel targetRef={dockTargetRef} />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <div className="relative w-full h-full">
                <FlowCanvas
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  setEdges={setEdges}
                  onConnect={onConnect}
                  onAddNode={addNode}
                />
              </div>
            )}
          </ResizablePanel>
          <ResizableHandle />

          {/* Right — Properties */}
          <ResizablePanel id="properties" defaultSize="18%" minSize="12%" maxSize="30%">
            <div className="h-full p-4 overflow-y-auto bg-surface-alt border-l border-edge min-w-[160px]">
              <PropertiesPanel selectedNode={selectedNode} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Floating preview — rendered outside panel layout */}
        {previewMode === 'floating' && (
          <FloatingPreview targetRef={floatTargetRef} />
        )}

        {/* Full window overlay — covers everything */}
        {previewMode === 'fullwindow' && (
          <FullWindowOverlay targetRef={fullTargetRef} />
        )}
      </div>
    </ReactFlowProvider>
  )
}

export default App
