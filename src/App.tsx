import { useEffect, useRef, useCallback } from 'react'
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { WebGLRenderer } from './webgl/renderer'
import { useLiveCompiler } from './compiler'
import { useGraphStore } from './stores/graphStore'
import { createUVTestGraph } from './utils/test-graph'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)

  // React Flow integration
  const nodes = useGraphStore((state) => state.nodes)
  const edges = useGraphStore((state) => state.edges)
  const onNodesChange = useGraphStore((state) => state.onNodesChange)
  const onEdgesChange = useGraphStore((state) => state.onEdgesChange)
  const setNodes = useGraphStore((state) => state.setNodes)
  const setEdges = useGraphStore((state) => state.setEdges)

  // Load test graph on mount (temporary for Phase 1 testing)
  useEffect(() => {
    const testGraph = createUVTestGraph()
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
    <div className="h-screen w-screen bg-[#0a0a12]" style={{
      display: 'grid',
      gridTemplateRows: '3rem 1fr',
      gridTemplateColumns: '16rem 1fr 16rem'
    }}>
      {/* Header - spans all columns */}
      <header className="bg-gray-900/50 border-b border-gray-800 flex items-center px-4" style={{ gridColumn: '1 / -1' }}>
        <h1 className="text-sm font-semibold text-gray-200">Sombra</h1>
        <span className="ml-2 text-xs text-gray-500">WebGL Shader Builder</span>
      </header>

      {/* Left panel - Node palette */}
      <div className="bg-gray-900/30 border-r border-gray-800 p-4 overflow-y-auto">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Node Palette
        </h2>
        <p className="text-xs text-gray-600">Coming soon...</p>
      </div>

      {/* Center - Canvas and Preview */}
      <div style={{
        display: 'grid',
        gridTemplateRows: '1fr 16rem'
      }}>
        {/* Node canvas */}
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            minZoom={0.1}
            maxZoom={4}
            style={{ width: '100%', height: '100%' }}
            className="bg-[#0a0a12]"
          >
            <Background color="#1a1a2e" gap={16} />
            <Controls />
            <MiniMap
              nodeColor="#6366f1"
              maskColor="rgba(10, 10, 18, 0.8)"
              className="bg-gray-900 border border-gray-700"
            />
          </ReactFlow>
        </div>

        {/* WebGL Preview */}
        <div className="bg-black border-t border-gray-800 relative">
          <div className="absolute top-2 left-2 z-10 text-xs text-gray-400 bg-gray-900/80 px-2 py-1 rounded">
            Preview
          </div>
          <canvas
            ref={canvasRef}
            className="w-full h-full"
          />
        </div>
      </div>

      {/* Right panel - Properties */}
      <div className="bg-gray-900/30 border-l border-gray-800 p-4 overflow-y-auto">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Properties
        </h2>
        <p className="text-xs text-gray-600">Select a node to edit properties...</p>
      </div>
    </div>
  )
}

export default App
