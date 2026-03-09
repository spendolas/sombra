import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import type { Connection } from '@xyflow/react'
import { WebGLRenderer } from './webgl/renderer'
import type { QualityTier } from './webgl/renderer'
import { useLiveCompiler } from './compiler'
import { useGraphStore } from './stores/graphStore'
import { useSettingsStore } from './stores/settingsStore'
import { createDefaultGraph } from './utils/test-graph'
import { nodeRegistry } from './nodes/registry'
import { ShaderNode } from './components/ShaderNode'
import { NodePalette } from './components/NodePalette'
import { FlowCanvas } from './components/FlowCanvas'
import { PropertiesPanel } from './components/PropertiesPanel'
import { PreviewPanel } from './components/PreviewPanel'
import { FloatingPreview } from './components/FloatingPreview'
import { FullWindowOverlay } from './components/FullWindowOverlay'
import { CommandPalette } from './components/CommandPalette'
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
  const previousPreviewMode = useSettingsStore((s) => s.previousPreviewMode)
  const splitDirection = useSettingsStore((s) => s.splitDirection)
  const setPreviewMode = useSettingsStore((s) => s.setPreviewMode)
  const splitPct = useSettingsStore((s) => splitDirection === 'vertical' ? s.verticalSplitPct : s.horizontalSplitPct)
  const setSplitPct = useSettingsStore((s) => s.setSplitPct)
  const splitSwapped = useSettingsStore((s) => splitDirection === 'vertical' ? s.verticalSplitSwapped : s.horizontalSplitSwapped)

  // Command palette state (ephemeral UI — not persisted)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const mousePositionRef = useRef({ x: 0, y: 0 })
  const [paletteMousePos, setPaletteMousePos] = useState({ x: 0, y: 0 })

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

  // Load default graph only when no persisted graph exists
  useEffect(() => {
    if (nodes.length === 0) {
      const testGraph = createDefaultGraph()
      setNodes(testGraph.nodes)
      setEdges(testGraph.edges)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on mount
  }, [])

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

  // Undo/redo keybindings (Cmd+Z / Cmd+Shift+Z)
  const undo = useGraphStore((state) => state.undo)
  const redo = useGraphStore((state) => state.redo)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  // Track mouse position for command palette node placement
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      mousePositionRef.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

  // Cmd+K / Cmd+/ opens command palette
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === '/')) {
        // Don't trigger when typing in inputs
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        setCommandPaletteOpen((prev) => {
          if (!prev) setPaletteMousePos({ ...mousePositionRef.current })
          return !prev
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // F toggles fullwindow, Esc exits fullwindow
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'f' || e.key === 'F') {
        if (previewMode === 'fullwindow') {
          setPreviewMode(previousPreviewMode === 'fullwindow' ? 'docked' : previousPreviewMode)
        } else {
          setPreviewMode('fullwindow')
        }
      } else if (e.key === 'Escape' && previewMode === 'fullwindow') {
        setPreviewMode(previousPreviewMode === 'fullwindow' ? 'docked' : previousPreviewMode)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [previewMode, previousPreviewMode, setPreviewMode])

  // Live compiler - updates shader when graph changes
  const handleCompile = useCallback(
    (result: {
      success: boolean
      fragmentShader: string
      userUniforms?: Array<{ name: string; value: number | number[] }>
      isTimeLiveAtOutput?: boolean
      qualityTier?: string
    }) => {
      if (result.success && rendererRef.current) {
        const updateResult = rendererRef.current.updateShader(result.fragmentShader)
        if (!updateResult.success) {
          console.error('WebGL shader update failed:', updateResult.error)
        } else {
          if (result.userUniforms?.length) {
            rendererRef.current.updateUniforms(
              result.userUniforms.map((u) => ({ name: u.name, value: u.value }))
            )
          }
          const isAnimated = result.isTimeLiveAtOutput ?? false
          rendererRef.current.setAnimated(isAnimated)
          if (isAnimated) {
            const timeNode = useGraphStore.getState().nodes.find(n => n.data.type === 'time')
            const speed = (timeNode?.data.params?.speed as number) ?? 1.0
            rendererRef.current.setAnimationSpeed(speed)
          }
          rendererRef.current.setQualityTier((result.qualityTier ?? 'adaptive') as QualityTier)
          rendererRef.current.notifyChange()
          // Static shaders need an explicit render — setAnimated(false) only
          // calls requestRender() on the animated→static transition, not when
          // the shader was already static.
          if (!isAnimated) {
            rendererRef.current.requestRender()
          }
        }
      }
    },
    []
  )

  const handleUniformUpdate = useCallback(
    (uniforms: Array<{ name: string; value: number | number[] }>) => {
      if (rendererRef.current) {
        rendererRef.current.updateUniforms(uniforms)
        rendererRef.current.notifyChange()
        const timeNode = useGraphStore.getState().nodes.find(n => n.data.type === 'time')
        if (timeNode) {
          const speed = (timeNode.data.params?.speed as number) ?? 1.0
          rendererRef.current.setAnimationSpeed(speed)
        }
      }
    },
    []
  )

  const handleRendererUpdate = useCallback(
    (update: { qualityTier: string }) => {
      rendererRef.current?.setQualityTier(update.qualityTier as QualityTier)
    },
    []
  )

  useLiveCompiler(handleCompile, handleUniformUpdate, handleRendererUpdate)

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
          <ResizablePanel id="palette" defaultSize="12%" minSize="12%" maxSize="30%">
            <div className="h-full overflow-y-auto min-w-node bg-surface-alt">
              <NodePalette />
            </div>
          </ResizablePanel>
          <ResizableHandle />

          {/* Center — Canvas + Preview */}
          <ResizablePanel id="center" defaultSize="64%">
            <ResizablePanelGroup direction={splitDirection} className={isDocked && splitSwapped ? (splitDirection === 'vertical' ? '!flex-col-reverse' : '!flex-row-reverse') : undefined} onLayoutChanged={(layout) => { if (layout.preview != null) setSplitPct(splitDirection, layout.preview) }}>
              <ResizablePanel id="canvas" defaultSize={isDocked ? `${100 - splitPct}%` : '100%'} minSize="30%">
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
              {isDocked && (
                <>
                  <ResizableHandle />
                  <ResizablePanel id="preview" defaultSize={`${splitPct}%`} minSize="10%">
                    <PreviewPanel targetRef={dockTargetRef} />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />

          {/* Right — Properties */}
          <ResizablePanel id="properties" defaultSize="12%" minSize="12%" maxSize="30%">
            <div className="h-full overflow-y-auto min-w-node bg-surface-alt">
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

        {/* Command palette overlay */}
        {commandPaletteOpen && (
          <CommandPalette onClose={() => setCommandPaletteOpen(false)} mousePosition={paletteMousePos} />
        )}
      </div>
    </ReactFlowProvider>
  )
}

export default App
