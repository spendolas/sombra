/**
 * SrtGizmoOverlay — a deliberately PLAIN transform gizmo over the active
 * preview canvas for the selected framework-spatial node. v0 exists to QA the
 * SRT model (one storage, World/node view); the look/feel/animation pass is a
 * later epic. All transform math comes from resolveSRT() (ir/srt-resolve.ts) —
 * this file draws at returned positions and forwards pointer deltas to the
 * returned mappers. It must contain NO trig of its own.
 *
 * Handles: center = free translate (content follows cursor); axis tips =
 * constrained translate along the ACTIVE view frame's axes (world = canvas
 * axes, node = the node's rotated+scaled axes, drawn dashed); ring dot =
 * rotate (Shift = 15° snap); square = uniform scale.
 *
 * Canvas-rect tracking mirrors PreviewGizmoOverlay (kept self-contained on
 * purpose — extracting a shared hook is a refactor for the polish pass).
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useGraphStore } from '../stores/graphStore'
import { useSettingsStore } from '../stores/settingsStore'
import { nodeRegistry } from '../nodes/registry'
import { resolveSRT, type ResolvedSRT } from '../compiler/ir/srt-resolve'
import type { Rect } from '../utils/gizmo-coords'
import { moveCursor } from '../utils/cursors'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

/** Inline affordance colours (like the snap targets in PreviewGizmoOverlay) —
 *  the 3D-app axis convention. Not brand tokens; DS-ify in the gizmo polish pass. */
const AXIS_X_COLOR = '#e5484d'
const AXIS_Y_COLOR = '#46a758'

const AXIS_LEN = 52        // px from center to an axis tip handle
const ROTATE_RADIUS = 74   // px ring radius for the rotate handle
const SCALE_BASE_RADIUS = 40 // px at scale 1 — handle distance is scaleMag × this

interface SrtGizmoOverlayProps {
  dockTargetRef: RefObject<HTMLDivElement | null>
  floatTargetRef: RefObject<HTMLDivElement | null>
  fullTargetRef: RefObject<HTMLDivElement | null>
}

type DragKind = 'free' | 'x' | 'y' | 'rotate' | 'scale'

export function SrtGizmoOverlay({ dockTargetRef, floatTargetRef, fullTargetRef }: SrtGizmoOverlayProps) {
  const previewMode = useSettingsStore((s) => s.previewMode)
  const gizmoOn = useSettingsStore((s) => s.srtGizmo)
  const nodes = useGraphStore((s) => s.nodes)
  const updateNodeData = useGraphStore((s) => s.updateNodeData)

  const selectedNode = useMemo(() => {
    const selected = nodes.filter((n) => n.selected)
    return selected.length === 1 ? selected[0] : null
  }, [nodes])

  const definition = selectedNode ? nodeRegistry.get(selectedNode.data.type) : undefined
  const spatial = definition?.spatial
  // Skip nodes whose SRT params are parked hidden (gradient) — no controls, no gizmo.
  const srtHidden = definition?.params?.find((p) => p.id.startsWith('srt_'))?.hidden === true
  const active = gizmoOn && !!selectedNode && !!spatial && !srtHidden

  const currentParams = useMemo(
    () => (selectedNode?.data.params ?? {}) as Record<string, unknown>,
    [selectedNode],
  )

  const outputAnchor = useMemo<[number, number]>(() => {
    const fo = nodes.find((n) => n.data.type === 'fragment_output')
    return anchorToVec2((fo?.data.params?.anchor as string) ?? 'center')
  }, [nodes])

  // --- Canvas rect tracking (mirrors PreviewGizmoOverlay) -------------------
  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const [canvasRect, setCanvasRect] = useState<Rect | null>(null)
  const canvasRectRef = useRef<Rect | null>(null)
  const [dragging, setDragging] = useState<DragKind | null>(null)
  const lastPointer = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  useEffect(() => {
    if (!active) {
      canvasElRef.current = null
      canvasRectRef.current = null
      setCanvasRect(null)
      return
    }
    const targetMap = {
      docked: dockTargetRef.current,
      floating: floatTargetRef.current,
      fullwindow: fullTargetRef.current,
    }
    const canvas = targetMap[previewMode]?.querySelector('canvas') ?? null
    canvasElRef.current = canvas
    if (!canvas) { setCanvasRect(null); return }
    const updateRect = () => {
      const r = canvas.getBoundingClientRect()
      const next = { left: r.left, top: r.top, width: r.width, height: r.height }
      canvasRectRef.current = next
      setCanvasRect(next)
    }
    updateRect()
    const ro = new ResizeObserver(updateRect)
    ro.observe(canvas)
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [active, previewMode, dockTargetRef, floatTargetRef, fullTargetRef])

  useEffect(() => {
    if (!active) return
    let raf = 0
    const tick = () => {
      const canvas = canvasElRef.current
      if (canvas) {
        const r = canvas.getBoundingClientRect()
        const prev = canvasRectRef.current
        const changed = !prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height
        if (changed) {
          const next = { left: r.left, top: r.top, width: r.width, height: r.height }
          canvasRectRef.current = next
          flushSync(() => setCanvasRect(next))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])

  // --- Drag ------------------------------------------------------------------
  useEffect(() => {
    if (!dragging || !selectedNode || !spatial) return
    const nodeId = selectedNode.id
    const transforms = spatial.transforms

    const onMove = (e: PointerEvent) => {
      const rect = canvasRectRef.current
      if (!rect) return
      const latest = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      const latestParams = (latest?.data.params ?? {}) as Record<string, unknown>
      // CSS px per world-offset px, measured off the live canvas (buffer px) —
      // tracks content across dpr and adaptive-quality buffer scaling.
      const cv = canvasElRef.current
      const cssPerPx = cv && cv.width > 0 ? rect.width / cv.width : 1
      const r: ResolvedSRT = resolveSRT(latestParams, { transforms, cssPerPx })
      // Gizmo center in viewport px: canvas anchor point + world offset.
      const cx = rect.left + rect.width * outputAnchor[0] + r.originOffset.x
      const cy = rect.top + rect.height * outputAnchor[1] + r.originOffset.y

      let patch: Record<string, number> | null = null
      if (dragging === 'free' || dragging === 'x' || dragging === 'y') {
        const dx = e.clientX - lastPointer.current.x
        const dy = e.clientY - lastPointer.current.y
        patch = r.dragTranslate(dx, dy, dragging)
      } else if (dragging === 'rotate') {
        patch = r.dragRotate(Math.atan2(e.clientY - cy, e.clientX - cx), e.shiftKey)
      } else if (dragging === 'scale') {
        patch = r.dragScale(Math.hypot(e.clientX - cx, e.clientY - cy), SCALE_BASE_RADIUS)
      }
      lastPointer.current = { x: e.clientX, y: e.clientY }
      if (patch) updateNodeData(nodeId, { params: { ...latestParams, ...patch } })
    }
    const onEnd = () => setDragging(null)

    const prevCursor = document.body.style.cursor
    document.body.style.cursor = moveCursor()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      document.body.style.cursor = prevCursor
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [dragging, selectedNode, spatial, outputAnchor, updateNodeData])

  if (!active || !canvasRect || !spatial) return null

  const canvasEl = canvasElRef.current
  const cssPerPx = canvasEl && canvasEl.width > 0 ? canvasRect.width / canvasEl.width : 1
  const r = resolveSRT(currentParams, { transforms: spatial.transforms, cssPerPx })
  // Center within the overlay (overlay div is positioned at the canvas rect).
  const cx = canvasRect.width * outputAnchor[0] + r.originOffset.x
  const cy = canvasRect.height * outputAnchor[1] + r.originOffset.y
  const nodeFrame = r.space === 'node'
  const showRotate = r.has.rotate
  const showScale = r.has.scale || r.has.scaleXY
  const scaleHandle = {
    x: cx + r.axes.x.x * SCALE_BASE_RADIUS * r.scaleMag,
    y: cy + r.axes.x.y * SCALE_BASE_RADIUS * r.scaleMag,
  }
  const rotHandle = {
    x: cx + Math.cos(r.rotateHandleAngle) * ROTATE_RADIUS,
    y: cy + Math.sin(r.rotateHandleAngle) * ROTATE_RADIUS,
  }

  const startDrag = (kind: DragKind) => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    lastPointer.current = { x: e.clientX, y: e.clientY }
    setDragging(kind)
  }

  const tip = (axis: { x: number; y: number }) => ({ x: cx + axis.x * AXIS_LEN, y: cy + axis.y * AXIS_LEN })
  const tipX = tip(r.axes.x)
  const tipY = tip(r.axes.y)

  return (
    <div
      className="fixed pointer-events-none z-[56]"
      style={{ left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height }}
    >
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        {/* Rotate ring */}
        {showRotate && (
          <circle cx={cx} cy={cy} r={ROTATE_RADIUS} fill="none" stroke="var(--indigo)" strokeOpacity={0.45} strokeWidth={1} />
        )}
        {/* Axes of the active frame — node frame drawn dashed */}
        {r.has.translate && (
          <>
            <line x1={cx} y1={cy} x2={tipX.x} y2={tipX.y} stroke={AXIS_X_COLOR} strokeWidth={1.5} strokeDasharray={nodeFrame ? '4 3' : undefined} />
            <line x1={cx} y1={cy} x2={tipY.x} y2={tipY.y} stroke={AXIS_Y_COLOR} strokeWidth={1.5} strokeDasharray={nodeFrame ? '4 3' : undefined} />
          </>
        )}
      </svg>

      {/* Frame badge — which space the axes are in (QA aid) */}
      <div
        className="absolute text-fg-dim bg-surface-raised/80 rounded-xs px-1 pointer-events-none"
        style={{ left: cx + 10, top: cy + 10, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase' }}
      >
        {r.space}
      </div>

      {/* Axis tip handles (constrained translate) */}
      {r.has.translate && (
        <>
          <div
            className="absolute nodrag nowheel pointer-events-auto touch-none rounded-full cursor-grab"
            style={{ left: tipX.x, top: tipX.y, width: 11, height: 11, background: AXIS_X_COLOR, transform: 'translate(-50%, -50%)' }}
            onPointerDown={startDrag('x')}
            title={`Offset along ${r.space} X`}
          />
          <div
            className="absolute nodrag nowheel pointer-events-auto touch-none rounded-full cursor-grab"
            style={{ left: tipY.x, top: tipY.y, width: 11, height: 11, background: AXIS_Y_COLOR, transform: 'translate(-50%, -50%)' }}
            onPointerDown={startDrag('y')}
            title={`Offset along ${r.space} Y`}
          />
        </>
      )}

      {/* Scale handle (square) */}
      {showScale && (
        <div
          className={cn('absolute nodrag nowheel pointer-events-auto touch-none', ds.gizmo.handle, 'rounded-none')}
          style={{ left: scaleHandle.x, top: scaleHandle.y, transform: 'translate(-50%, -50%)' }}
          onPointerDown={startDrag('scale')}
          title="Scale"
        />
      )}

      {/* Rotate handle (dot on the ring) */}
      {showRotate && (
        <div
          className={cn('absolute nodrag nowheel pointer-events-auto touch-none', ds.gizmo.handle)}
          style={{ left: rotHandle.x, top: rotHandle.y, transform: 'translate(-50%, -50%)' }}
          onPointerDown={startDrag('rotate')}
          title="Rotate (Shift = 15° snap)"
        />
      )}

      {/* Center — free translate */}
      {r.has.translate && (
        <div
          className={cn('absolute nodrag nowheel pointer-events-auto touch-none', ds.gizmo.center)}
          style={{ left: cx, top: cy, transform: 'translate(-50%, -50%)', cursor: moveCursor() }}
          onPointerDown={startDrag('free')}
          title="Offset (free)"
        />
      )}
    </div>
  )
}
