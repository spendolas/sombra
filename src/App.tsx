import { useEffect, useRef, useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WebGLRenderer } from './webgl/renderer'
import { useLiveCompiler } from './compiler'
import { useGraphStore } from './stores/graphStore'
import { createSpectraSimplexFBM } from './utils/test-graph'
import { nodeRegistry } from './nodes/registry'
import { ShaderNode } from './components/ShaderNode'
import { NodePalette } from './components/NodePalette'
import { FlowCanvas } from './components/FlowCanvas'
import { PropertiesPanel } from './components/PropertiesPanel'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)

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
    const testGraph = createSpectraSimplexFBM()
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

  return (
    <ReactFlowProvider>
      <div className="h-screen w-screen grid grid-cols-1 bg-surface">
        <ResizablePanelGroup direction="horizontal">
          {/* Left — Node Palette */}
          <ResizablePanel id="palette" defaultSize="18%" minSize="12%" maxSize="30%">
            <div className="h-full p-4 overflow-y-auto bg-surface-alt border-r border-edge min-w-[160px]">
              <NodePalette />
            </div>
          </ResizablePanel>
          <ResizableHandle />

          {/* Center — Canvas + Preview (vertical split) */}
          <ResizablePanel id="center" defaultSize="64%">
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel id="canvas" defaultSize="70%" minSize="30%">
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
              <ResizablePanel id="preview" defaultSize="30%" minSize="10%">
                <div className="relative w-full h-full bg-black border-t border-edge">
                  <div className="absolute top-2 left-2 z-10 text-xs px-2 py-1 rounded text-fg-dim bg-surface-raised">
                    Preview
                  </div>
                  <canvas
                    ref={canvasRef}
                    className="w-full h-full"
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />

          {/* Right — Properties */}
          <ResizablePanel id="properties" defaultSize="18%" minSize="12%" maxSize="30%">
            <div className="h-full p-4 overflow-y-auto bg-surface-alt border-l border-edge min-w-[160px]">
              <PropertiesPanel selectedNode={selectedNode} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </ReactFlowProvider>
  )
}

export default App
