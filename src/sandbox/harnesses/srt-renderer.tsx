/**
 * SrtRendererSandbox — SRT (Offset Space) playground on the REAL renderer.
 * View at /srt-renderer-sandbox.html on the dev server. Not shipped.
 *
 * Compiles a live checkerboard → Fragment Output graph with the real
 * compiler and renders it with the real createShaderRenderer (WebGPU, WebGL2
 * fallback) — the same path viewer.ts uses. The Transform controls (real
 * FloatSlider + SegmentedControl) drive srt_* params; every change recompiles
 * and re-renders. ONE STORAGE: offsets always store the world value; the
 * Offset Space toggle only re-interprets the offset sliders (Node view edits
 * along the node's rotated+scaled axes) — toggling must NOT change the render.
 */

import { useEffect, useRef, useState } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { compileGraph } from '@/compiler/glsl-generator'
import { compileGraphIR } from '@/compiler/ir-compiler'
import { createShaderRenderer } from '@/renderer/create-renderer'
import { anchorToVec2 } from '@/nodes/output/fragment-output'
import { FloatSlider, SegmentedControl } from '@/components/NodeParameters'
import { worldOffsetToNode, nodeOffsetToWorld } from '@/compiler/ir/srt'
import { initializeNodeLibrary } from '@/nodes'
import type { NodeData, EdgeData, PortType, NodeParameter } from '@/nodes/types'
import type { ShaderRenderer } from '@/renderer/types'

// Populates the node registry (registerNodes(ALL_NODES)) — required before
// compileGraph/compileGraphIR can resolve 'checkerboard' / 'fragment_output'.
// Runs once per module evaluation; the app's real entry point (main.tsx) does
// this too, but this harness is loaded standalone (no App.tsx in the tree).
initializeNodeLibrary()

// ONE STORAGE: tx/ty always hold the WORLD offset (exactly what the params
// store in the real editor). The Offset Space toggle is a VIEW — in 'node'
// view the offset sliders show/edit the offset along the node's rotated+scaled
// axes via worldOffsetToNode/nodeOffsetToWorld (ir/srt.ts). Toggling never
// changes the render; only the numbers re-express.
interface Params { scale: number; rotate: number; tx: number; ty: number; space: string }
const INITIAL: Params = { scale: 2, rotate: 0, tx: 120, ty: 0, space: 'world' }

const scaleParam: NodeParameter = { id: 'srt_scale', label: 'Scale', type: 'float', default: 1, min: 0.25, max: 4, step: 0.01, updateMode: 'uniform' }
const rotateParam: NodeParameter = { id: 'srt_rotate', label: 'Rotate', type: 'float', default: 0, min: -180, max: 180, step: 1, updateMode: 'uniform' }
const txParam: NodeParameter = { id: 'srt_translateX', label: 'Offset X', type: 'float', default: 0, min: -200, max: 200, step: 1, updateMode: 'uniform' }
const tyParam: NodeParameter = { id: 'srt_translateY', label: 'Offset Y', type: 'float', default: 0, min: -200, max: 200, step: 1, updateMode: 'uniform' }
const spaceParam: NodeParameter = {
  id: 'srt_translateSpace', label: 'Offset Space', type: 'enum', default: 'world', control: 'segmented',
  updateMode: 'recompile', options: [{ value: 'world', label: 'World' }, { value: 'node', label: 'Node' }],
}

function buildGraph(p: Params): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const nodes: Node<NodeData>[] = [
    {
      id: 'src', type: 'shaderNode', position: { x: 0, y: 0 },
      data: {
        type: 'checkerboard',
        params: {
          srt_scale: p.scale, srt_rotate: p.rotate, srt_translateX: p.tx, srt_translateY: p.ty,
          srt_translateSpace: p.space, cellSize: 48,
        },
      },
    },
    { id: 'out', type: 'shaderNode', position: { x: 300, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ]
  const edges: Edge<EdgeData>[] = [
    {
      id: 'src-color-out-color', source: 'src', target: 'out', sourceHandle: 'color', targetHandle: 'color',
      type: 'typed', data: { sourcePort: 'color', targetPort: 'color', sourcePortType: 'color' as PortType },
    },
  ]
  return { nodes, edges }
}

function compile(p: Params) {
  const { nodes, edges } = buildGraph(p)
  const result = compileGraph(nodes, edges)
  if (result.success && typeof navigator !== 'undefined' && navigator.gpu) {
    const wgsl = compileGraphIR(nodes, edges)
    if (wgsl) result.wgsl = { passes: wgsl.passes }
  }
  return result
}

export default function SrtRendererHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<ShaderRenderer | null>(null)
  const [p, setP] = useState<Params>(INITIAL)
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [backend, setBackend] = useState('')

  // Init the renderer once.
  useEffect(() => {
    let disposed = false
    const result = compile(INITIAL)
    if (!result.success) { setErr(result.errors.map((e) => e.message).join('\n')); return }
    createShaderRenderer(canvasRef.current!, result).then((r) => {
      if (disposed) { r.dispose(); return }
      rendererRef.current = r
      setBackend(typeof navigator !== 'undefined' && navigator.gpu ? 'WebGPU' : 'WebGL2')
      const sr = r.updateRenderPlan(result)
      if (!sr.success) { setErr(sr.error ?? 'shader error'); return }
      // Baked param values (colors, cellSize, srt_*) live in userUniforms — must
      // be uploaded or every uniform reads 0 (→ black). viewer.ts does the same.
      if (result.userUniforms.length) r.updateUniforms(result.userUniforms.map((u) => ({ name: u.name, value: u.value })))
      r.setAnchor(anchorToVec2('center'))
      r.setAnimated(false)
      r.render()
      setReady(true)
    }).catch((e) => setErr(String(e)))
    return () => { disposed = true; rendererRef.current?.dispose(); rendererRef.current = null }
  }, [])

  // Recompile + re-render on any control change (translateSpace needs a recompile;
  // one node compiles instantly, so recompile-on-change keeps both paths correct).
  useEffect(() => {
    if (!ready || !rendererRef.current) return
    const result = compile(p)
    if (!result.success) { setErr(result.errors.map((e) => e.message).join('\n')); return }
    const sr = rendererRef.current.updateRenderPlan(result)
    if (!sr.success) { setErr(sr.error ?? 'shader error'); return }
    setErr(null)
    if (result.userUniforms.length) rendererRef.current.updateUniforms(result.userUniforms.map((u) => ({ name: u.name, value: u.value })))
    rendererRef.current.setAnchor(anchorToVec2('center'))
    rendererRef.current.render()
    rendererRef.current.notifyChange()
  }, [p, ready])

  // Node view: sliders show/edit along the node's axes; storage stays world.
  const nodeView = p.space === 'node'
  const viewOffsets = nodeView ? worldOffsetToNode(p.tx, p.ty, p.rotate, p.scale, p.scale) : { tx: p.tx, ty: p.ty }
  const setOffsetFromView = (axis: 'x' | 'y', value: number) => {
    if (!nodeView) { setP((s) => ({ ...s, [axis === 'x' ? 'tx' : 'ty']: value })); return }
    const w = nodeOffsetToWorld(
      axis === 'x' ? value : viewOffsets.tx,
      axis === 'y' ? value : viewOffsets.ty,
      p.rotate, p.scale, p.scale,
    )
    setP((s) => ({ ...s, tx: w.tx, ty: w.ty }))
  }

  const caption = (() => {
    const scaled = Math.abs(p.scale - 1) > 0.01, rotated = Math.abs(p.rotate) > 0.5
    if (!scaled && !rotated) return 'At Scale 1× / Rotate 0° both views read the same. Push Scale or Rotate, then toggle.'
    return 'One storage: toggling never moves the content — the numbers re-express. In Node view a drag moves along the node’s rotated/scaled axes.'
  })()

  return (
    <div className="min-h-screen bg-surface text-fg p-2xl" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div className="max-w-[900px] mx-auto">
        <p className="text-[11px] tracking-[0.14em] uppercase text-fg-muted font-semibold mb-1">Sombra · design sandbox</p>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          SRT Offset Space — live renderer
          <span className="ml-2 align-middle text-[10px] tracking-wider uppercase font-bold text-indigo-hover border border-indigo px-1.5 py-0.5 rounded-full">{backend || '…'}</span>
        </h1>
        <p className="text-fg-subtle mt-1 max-w-[64ch]">A real checkerboard → Fragment Output graph, compiled by the real compiler and drawn by the real renderer. The controls drive <code className="text-fg-dim">srt_*</code> (one world storage; Node view re-interprets the offset sliders along the node’s axes). Not a re-implementation — this is the engine.</p>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_300px] gap-2xl mt-2xl items-start">
          <div>
            <div className="bg-surface-elevated border border-edge-card rounded-md overflow-hidden">
              <canvas ref={canvasRef} width={460} height={460} className="block w-full h-auto aspect-square bg-black" />
            </div>
            <p className="text-fg-subtle text-sm mt-md">{caption}</p>
            {err && <pre className="text-error text-xs mt-sm whitespace-pre-wrap">{err}</pre>}
            <div className="flex gap-sm mt-md">
              <button className="text-mono-value bg-surface-raised border border-edge rounded-sm px-md py-xs cursor-pointer hover:border-indigo" onClick={() => setP(INITIAL)}>Reset</button>
              <button className="text-mono-value bg-surface-raised border border-edge rounded-sm px-md py-xs cursor-pointer hover:border-indigo" onClick={() => setP({ scale: 1, rotate: 30, tx: 120, ty: 0, space: p.space })}>Offset + Rotate 30°</button>
            </div>
          </div>

          <div className="bg-surface-elevated border border-edge-card rounded-md overflow-hidden">
            <div className="bg-surface-raised px-md py-sm text-body font-medium border-b border-edge-subtle">Transform</div>
            <div className="flex flex-col gap-md p-md">
              <FloatSlider param={scaleParam} value={p.scale} onChange={(v) => setP((s) => ({ ...s, scale: v }))} />
              <FloatSlider param={rotateParam} value={p.rotate} onChange={(v) => setP((s) => ({ ...s, rotate: v }))} />
              <FloatSlider param={txParam} value={viewOffsets.tx} onChange={(v) => setOffsetFromView('x', v)} />
              <FloatSlider param={tyParam} value={viewOffsets.ty} onChange={(v) => setOffsetFromView('y', v)} />
              <div className="border-t border-edge-subtle pt-md">
                {/* One storage: the toggle only switches the VIEW — no value
                    rewrite, and the render must not change on switch. */}
                <SegmentedControl param={spaceParam} value={p.space} onChange={(v) => setP((s) => ({ ...s, space: v }))} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
