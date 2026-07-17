/**
 * PreviewGizmoOverlay — draggable control points rendered over the active
 * preview canvas for the single selected node, when its NodeDefinition
 * declares a `gizmo` (see `GizmoConfig`/`GizmoPoint` in `../nodes/types`).
 *
 * Mounted once from App.tsx (see mount comment there). The canvas is
 * reparented between three target containers depending on `previewMode`
 * (docked/floating/fullwindow) — this overlay is handed all three target
 * refs, picks the active one via `previewMode`, and locates the live
 * `<canvas>` child to read its rect. Position is `fixed` (viewport-relative,
 * matching `getBoundingClientRect()`) so the overlay works regardless of
 * where in the DOM tree it's mounted.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useGraphStore } from '../stores/graphStore'
import { useSettingsStore } from '../stores/settingsStore'
import { nodeRegistry } from '../nodes/registry'
import { matchesShowWhen, type GizmoPoint } from '../nodes/types'
import { pointPxToScreen, screenToPointPx, type Rect } from '../utils/gizmo-coords'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

/** Gizmo points are relative to the preview canvas centre (stable reference,
 *  independent of the Fragment Output anchor). Module-level so its identity is
 *  stable across renders. */
const GIZMO_ANCHOR: [number, number] = [0.5, 0.5]

interface PreviewGizmoOverlayProps {
  dockTargetRef: RefObject<HTMLDivElement | null>
  floatTargetRef: RefObject<HTMLDivElement | null>
  fullTargetRef: RefObject<HTMLDivElement | null>
}

interface DragState {
  pointId: string
  xParam: string
  yParam: string
}

export function PreviewGizmoOverlay({ dockTargetRef, floatTargetRef, fullTargetRef }: PreviewGizmoOverlayProps) {
  const previewMode = useSettingsStore((s) => s.previewMode)
  const nodes = useGraphStore((s) => s.nodes)
  const updateNodeData = useGraphStore((s) => s.updateNodeData)

  // --- Active-node / gizmo resolution -------------------------------------

  const selectedNode = useMemo(() => {
    const selected = nodes.filter((n) => n.selected)
    return selected.length === 1 ? selected[0] : null
  }, [nodes])

  const definition = selectedNode ? nodeRegistry.get(selectedNode.data.type) : undefined
  const gizmo = definition?.gizmo
  const allParams = useMemo(() => definition?.params ?? [], [definition])
  const currentParams = useMemo(
    () => (selectedNode?.data.params ?? {}) as Record<string, unknown>,
    [selectedNode],
  )

  const gizmoActive = !!gizmo && matchesShowWhen(gizmo.showWhen, currentParams, allParams)

  const visiblePoints = useMemo<GizmoPoint[]>(() => {
    if (!gizmo) return []
    return gizmo.points.filter((p) => matchesShowWhen(p.showWhen, currentParams, allParams))
  }, [gizmo, currentParams, allParams])

  // Gizmo points are relative to the PREVIEW CANVAS CENTRE (not the Fragment
  // Output anchor) so their preview-window position survives anchor changes.
  const anchor = GIZMO_ANCHOR

  // --- Canvas rect tracking -------------------------------------------------

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const [canvasRect, setCanvasRect] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState<DragState | null>(null)

  // Resolve the active target container's <canvas> child and keep canvasRect
  // synced via ResizeObserver (size changes) + window resize/scroll
  // (position changes from layout/viewport changes).
  useEffect(() => {
    if (!gizmoActive) {
      canvasElRef.current = null
      setCanvasRect(null)
      return
    }
    const targetMap = {
      docked: dockTargetRef.current,
      floating: floatTargetRef.current,
      fullwindow: fullTargetRef.current,
    }
    const container = targetMap[previewMode]
    const canvas = container?.querySelector('canvas') ?? null
    canvasElRef.current = canvas
    if (!canvas) {
      setCanvasRect(null)
      return
    }

    const updateRect = () => {
      const r = canvas.getBoundingClientRect()
      setCanvasRect({ left: r.left, top: r.top, width: r.width, height: r.height })
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
  }, [gizmoActive, previewMode, dockTargetRef, floatTargetRef, fullTargetRef])

  // Follow the preview live: the docked/floating/full-window panel (or its
  // canvas) can move/resize without a discrete resize/scroll event — panel
  // drags, split-handle drags, layout settling. A rAF loop while the gizmo is
  // active keeps canvasRect exact every frame, and only calls setState when the
  // rect actually changed so a static preview costs no re-renders.
  useEffect(() => {
    if (!gizmoActive) return
    let raf = 0
    const tick = () => {
      const canvas = canvasElRef.current
      if (canvas) {
        const r = canvas.getBoundingClientRect()
        setCanvasRect((prev) =>
          prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
            ? prev
            : { left: r.left, top: r.top, width: r.width, height: r.height },
        )
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [gizmoActive])

  // Drag lifetime: bind move/up/cancel on `window` so release is caught even
  // off-canvas — no setPointerCapture, mirroring the ImageUploader gizmo.
  useEffect(() => {
    if (!dragging || !selectedNode) return
    const nodeId = selectedNode.id

    const onMove = (e: PointerEvent) => {
      const canvas = canvasElRef.current
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      const { x, y } = screenToPointPx(e.clientX, e.clientY, r, anchor)
      const latest = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      const latestParams = (latest?.data.params ?? {}) as Record<string, unknown>
      updateNodeData(nodeId, {
        params: { ...latestParams, [dragging.xParam]: x, [dragging.yParam]: y },
      })
    }
    const onEnd = () => setDragging(null)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [dragging, anchor, selectedNode, updateNodeData])

  if (!gizmoActive || !gizmo || !canvasRect) return null

  const pointScreenPos = new Map<string, { x: number; y: number }>()
  for (const p of visiblePoints) {
    // Fall back to the param's DEFINITION default (not 0) for points the user
    // hasn't dragged yet — else every unset point collapses onto the anchor.
    const xDef = allParams.find((pp) => pp.id === p.xParam)?.default
    const yDef = allParams.find((pp) => pp.id === p.yParam)?.default
    const px = (currentParams[p.xParam] as number) ?? (xDef as number) ?? 0
    const py = (currentParams[p.yParam] as number) ?? (yDef as number) ?? 0
    pointScreenPos.set(p.id, pointPxToScreen(px, py, canvasRect, anchor))
  }

  return (
    <div
      className="fixed pointer-events-none z-[55]"
      style={{ left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height }}
    >
      {gizmo.connectors && gizmo.connectors.length > 0 && (
        <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
          {gizmo.connectors.map((c) => {
            const from = pointScreenPos.get(c.from)
            const to = pointScreenPos.get(c.to)
            if (!from || !to) return null
            return (
              <line
                key={`${c.from}-${c.to}`}
                x1={from.x - canvasRect.left}
                y1={from.y - canvasRect.top}
                x2={to.x - canvasRect.left}
                y2={to.y - canvasRect.top}
                stroke="var(--indigo)"
                strokeWidth={1.5}
              />
            )
          })}
        </svg>
      )}

      {visiblePoints.map((point) => {
        const pos = pointScreenPos.get(point.id)
        if (!pos) return null
        const isCenter = point.role === 'center'
        return (
          <div
            key={point.id}
            className={cn(
              'absolute nodrag nowheel pointer-events-auto',
              isCenter ? ds.gizmo.center : ds.gizmo.handle,
            )}
            style={{
              left: pos.x - canvasRect.left,
              top: pos.y - canvasRect.top,
              transform: 'translate(-50%, -50%)',
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setDragging({ pointId: point.id, xParam: point.xParam, yParam: point.yParam })
            }}
          />
        )
      })}
    </div>
  )
}
