import { useEffect, useRef, useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WebGLRenderer } from './webgl/renderer'
import { useLiveCompiler } from './compiler'
import { useGraphStore } from './stores/graphStore'
import { createNoiseTestGraph } from './utils/test-graph'
import { ShaderNode } from './components/ShaderNode'
import { NodePalette } from './components/NodePalette'
import { FlowCanvas } from './components/FlowCanvas'
import { PropertiesPanel } from './components/PropertiesPanel'

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

      const newEdge = {
        id: `${connection.source}-${connection.sourceHandle}-${connection.target}-${connection.targetHandle}`,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'default',
        data: {
          sourcePort: connection.sourceHandle,
          targetPort: connection.targetHandle,
        },
      }

      addEdge(newEdge)
    },
    [addEdge]
  )

  // Register custom node types
  const nodeTypes = useMemo(() => ({ shaderNode: ShaderNode }), [])

  // Find selected node for properties panel
  const selectedNode = useMemo(() => {
    return nodes.find((node) => node.selected) || null
  }, [nodes])

  // Load test graph on mount (temporary for Phase 1 testing)
  useEffect(() => {
    const testGraph = createNoiseTestGraph()
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
      <div
        className="h-screen w-screen"
        style={{
          display: 'grid',
          gridTemplateRows: '3rem 1fr',
          gridTemplateColumns: '16rem 1fr 16rem',
          backgroundColor: 'var(--bg-primary)'
        }}
      >
      {/* Header - spans all columns */}
      <header
        className="flex items-center px-4"
        style={{
          gridColumn: '1 / -1',
          backgroundColor: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-primary)'
        }}
      >
        <h1 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Sombra
        </h1>
        <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          WebGL Shader Builder
        </span>
      </header>

      {/* Left panel - Node palette */}
      <div
        className="p-4 overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border-primary)'
        }}
      >
        <h2
          className="text-xs font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-secondary)' }}
        >
          Node Palette
        </h2>
        <NodePalette />
      </div>

      {/* Center - Canvas and Preview */}
      <div style={{
        display: 'grid',
        gridTemplateRows: '1fr 16rem'
      }}>
        {/* Node canvas */}
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onAddNode={addNode}
          />
        </div>

        {/* WebGL Preview */}
        <div
          className="relative"
          style={{
            backgroundColor: '#000',
            borderTop: '1px solid var(--border-primary)'
          }}
        >
          <div
            className="absolute top-2 left-2 z-10 text-xs px-2 py-1 rounded"
            style={{
              color: 'var(--text-secondary)',
              backgroundColor: 'var(--bg-tertiary)'
            }}
          >
            Preview
          </div>
          <canvas
            ref={canvasRef}
            className="w-full h-full"
          />
        </div>
      </div>

      {/* Right panel - Properties */}
      <div
        className="p-4 overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-secondary)',
          borderLeft: '1px solid var(--border-primary)'
        }}
      >
        <PropertiesPanel selectedNode={selectedNode} />
      </div>
    </div>
    </ReactFlowProvider>
  )
}

export default App
