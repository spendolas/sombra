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
import { matchesShowWhen, type GizmoPoint, type GizmoAspectHandle, type GizmoOutline } from '../nodes/types'
import { pointPxToScreen, screenToPointPx, type Rect } from '../utils/gizmo-coords'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

/** Tailwind override for the marker's border-radius: 'circle' (default) keeps
 *  the base `rounded-full`; 'square'/'diamond' switch to `rounded-none` (a
 *  diamond is a square rotated 45deg — see `markerTransform`). */
function markerShapeClass(shape: 'circle' | 'diamond' | 'square' | undefined): string {
  return shape === 'square' || shape === 'diamond' ? 'rounded-none' : ''
}

/** Marker's inline `transform`: always re-centers on its (left, top) via
 *  translate(-50%, -50%); 'diamond' additionally rotates 45deg. Computed
 *  inline (not via a Tailwind `rotate-45` class) because the centering
 *  translate is already an inline style and would otherwise clobber it. */
function markerTransform(shape: 'circle' | 'diamond' | 'square' | undefined): string {
  return shape === 'diamond' ? 'translate(-50%, -50%) rotate(45deg)' : 'translate(-50%, -50%)'
}

/** Screen-space geometry derived from an aspect handle's center/end points:
 *  direction along the center->end line, its perpendicular, the line length,
 *  and the resolved aspect scalar (current param value, falling back to the
 *  param's declared default, then 1). */
interface AspectGeometry {
  Cs: { x: number; y: number }
  dirX: number
  dirY: number
  perpX: number
  perpY: number
  L: number
  aspect: number
}

function computeAspectGeometry(
  handle: Pick<GizmoAspectHandle, 'centerPoint' | 'endPoint' | 'aspectParam'>,
  pointScreenPos: Map<string, { x: number; y: number }>,
  currentParams: Record<string, unknown>,
  allParams: { id: string; default: unknown }[],
): AspectGeometry | null {
  const Cs = pointScreenPos.get(handle.centerPoint)
  const Es = pointScreenPos.get(handle.endPoint)
  if (!Cs || !Es) return null
  const dx = Es.x - Cs.x
  const dy = Es.y - Cs.y
  const L = Math.hypot(dx, dy)
  const dirX = L > 1e-6 ? dx / L : 1
  const dirY = L > 1e-6 ? dy / L : 0
  const perpX = -dirY
  const perpY = dirX
  const aspect =
    (currentParams[handle.aspectParam] as number | undefined) ??
    (allParams.find((pp) => pp.id === handle.aspectParam)?.default as number | undefined) ??
    1
  return { Cs, dirX, dirY, perpX, perpY, L, aspect }
}

/** Gizmo points are relative to the preview canvas centre (stable reference,
 *  independent of the Fragment Output anchor). Module-level so its identity is
 *  stable across renders. */
const GIZMO_ANCHOR: [number, number] = [0.5, 0.5]

interface PreviewGizmoOverlayProps {
  dockTargetRef: RefObject<HTMLDivElement | null>
  floatTargetRef: RefObject<HTMLDivElement | null>
  fullTargetRef: RefObject<HTMLDivElement | null>
}

type DragState =
  | { kind: 'point'; pointId: string; xParam: string; yParam: string }
  | { kind: 'aspect'; handleId: string; aspectParam: string; centerPoint: string; endPoint: string }

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

  const visibleAspectHandles = useMemo<GizmoAspectHandle[]>(() => {
    if (!gizmo?.aspectHandles) return []
    return gizmo.aspectHandles.filter((h) => matchesShowWhen(h.showWhen, currentParams, allParams))
  }, [gizmo, currentParams, allParams])

  const visibleOutlines = useMemo<GizmoOutline[]>(() => {
    if (!gizmo?.outline) return []
    return gizmo.outline.filter((o) => matchesShowWhen(o.showWhen, currentParams, allParams))
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
      const latest = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      const latestParams = (latest?.data.params ?? {}) as Record<string, unknown>

      if (dragging.kind === 'point') {
        const { x, y } = screenToPointPx(e.clientX, e.clientY, r, anchor)
        updateNodeData(nodeId, {
          params: { ...latestParams, [dragging.xParam]: x, [dragging.yParam]: y },
        })
        return
      }

      // Aspect handle: project the cursor onto the perpendicular of the
      // center->end line, using each point's LATEST params (not the
      // possibly-stale render-time pointScreenPos).
      const centerPoint = gizmo?.points.find((p) => p.id === dragging.centerPoint)
      const endPoint = gizmo?.points.find((p) => p.id === dragging.endPoint)
      if (!centerPoint || !endPoint) return
      const cx = (latestParams[centerPoint.xParam] as number | undefined) ??
        (allParams.find((pp) => pp.id === centerPoint.xParam)?.default as number | undefined) ?? 0
      const cy = (latestParams[centerPoint.yParam] as number | undefined) ??
        (allParams.find((pp) => pp.id === centerPoint.yParam)?.default as number | undefined) ?? 0
      const ex = (latestParams[endPoint.xParam] as number | undefined) ??
        (allParams.find((pp) => pp.id === endPoint.xParam)?.default as number | undefined) ?? 0
      const ey = (latestParams[endPoint.yParam] as number | undefined) ??
        (allParams.find((pp) => pp.id === endPoint.yParam)?.default as number | undefined) ?? 0
      const Cs = pointPxToScreen(cx, cy, r, anchor)
      const Es = pointPxToScreen(ex, ey, r, anchor)
      const dx = Es.x - Cs.x
      const dy = Es.y - Cs.y
      const L = Math.hypot(dx, dy)
      if (L < 1e-6) return
      const perpX = -(dy / L)
      const perpY = dx / L
      const proj = ((e.clientX - Cs.x) * perpX + (e.clientY - Cs.y) * perpY) / Math.max(L, 1e-6)
      const aspectNew = Math.max(0.05, proj)
      updateNodeData(nodeId, {
        params: { ...latestParams, [dragging.aspectParam]: aspectNew },
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
  }, [dragging, anchor, selectedNode, updateNodeData, gizmo, allParams])

  if (!gizmoActive || !gizmo || !canvasRect) return null

  // Built from ALL gizmo points (not just currently-visible ones) so aspect
  // handles/outline can resolve their centerPoint/endPoint even if that point
  // itself isn't rendered as a handle.
  const pointScreenPos = new Map<string, { x: number; y: number }>()
  for (const p of gizmo.points) {
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
      {visibleOutlines.map((outline, i) => {
        const outlineGeom = computeAspectGeometry(outline, pointScreenPos, currentParams, allParams)
        if (!outlineGeom) return null
        return (
          <svg key={`outline-${i}`} className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
            {outline.shape === 'ellipse' ? (
              (() => {
                const cx = outlineGeom.Cs.x - canvasRect.left
                const cy = outlineGeom.Cs.y - canvasRect.top
                const angleDeg = (Math.atan2(outlineGeom.dirY, outlineGeom.dirX) * 180) / Math.PI
                return (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={outlineGeom.L}
                    ry={outlineGeom.aspect * outlineGeom.L}
                    transform={`rotate(${angleDeg} ${cx} ${cy})`}
                    fill="none"
                    stroke="var(--indigo)"
                    strokeWidth={1}
                  />
                )
              })()
            ) : (
              (() => {
                const { Cs, dirX, dirY, perpX, perpY, L, aspect } = outlineGeom
                const tips = [
                  { x: Cs.x + dirX * L, y: Cs.y + dirY * L },
                  { x: Cs.x + perpX * aspect * L, y: Cs.y + perpY * aspect * L },
                  { x: Cs.x - dirX * L, y: Cs.y - dirY * L },
                  { x: Cs.x - perpX * aspect * L, y: Cs.y - perpY * aspect * L },
                ]
                const pointsAttr = tips
                  .map((t) => `${t.x - canvasRect.left},${t.y - canvasRect.top}`)
                  .join(' ')
                return (
                  <polygon points={pointsAttr} fill="none" stroke="var(--indigo)" strokeWidth={1} />
                )
              })()
            )}
          </svg>
        )
      })}

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
              markerShapeClass(point.shape),
            )}
            style={{
              left: pos.x - canvasRect.left,
              top: pos.y - canvasRect.top,
              transform: markerTransform(point.shape),
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setDragging({ kind: 'point', pointId: point.id, xParam: point.xParam, yParam: point.yParam })
            }}
          />
        )
      })}

      {visibleAspectHandles.map((handle) => {
        const geom = computeAspectGeometry(handle, pointScreenPos, currentParams, allParams)
        if (!geom) return null
        const pos = {
          x: geom.Cs.x + geom.perpX * geom.aspect * geom.L,
          y: geom.Cs.y + geom.perpY * geom.aspect * geom.L,
        }
        return (
          <div
            key={handle.id}
            className={cn(
              'absolute nodrag nowheel pointer-events-auto',
              ds.gizmo.handle,
              markerShapeClass(handle.shape),
            )}
            style={{
              left: pos.x - canvasRect.left,
              top: pos.y - canvasRect.top,
              transform: markerTransform(handle.shape),
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              setDragging({
                kind: 'aspect',
                handleId: handle.id,
                aspectParam: handle.aspectParam,
                centerPoint: handle.centerPoint,
                endPoint: handle.endPoint,
              })
            }}
          />
        )
      })}
    </div>
  )
}
