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
import { flushSync } from 'react-dom'
import { useGraphStore } from '../stores/graphStore'
import { useSettingsStore } from '../stores/settingsStore'
import { nodeRegistry } from '../nodes/registry'
import { matchesShowWhen, type GizmoPoint, type GizmoAspectHandle, type GizmoOutline } from '../nodes/types'
import { pointPxToScreen, screenToPointPx, uvToScreen, screenToUv, type Rect } from '../utils/gizmo-coords'
import { moveCursor } from '../utils/cursors'
import { anchorToVec2 } from '../nodes/output/fragment-output'
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

/**
 * Fractional screen position (0..1 of the canvas rect) of the shader's px-space
 * origin — where `grad_center` lands on screen. Mirrors the shader:
 * `anchor + (0.5 - anchor) * (refRes / cssSize)` (the u_ref_size/dpr terms
 * cancel). refRes = the captured reference resolution (CSS px); 0 → fall back to
 * the live canvas size (→ factor 1 → 0.5, i.e. centred/no-jump, matching an
 * uncaptured shader). At the reference size the factor is 1 → 0.5 for any anchor
 * (survives anchor switches); away from it, it slides toward `outputAnchor`
 * (pins on resize). px offsets (p0/p1) add straight in CSS px from here.
 */
function pxOriginFrac(rect: Rect, outputAnchor: [number, number], refRes: [number, number]): [number, number] {
  const refX = refRes[0] > 0 ? refRes[0] : rect.width
  const refY = refRes[1] > 0 ? refRes[1] : rect.height
  const mx = rect.width > 0 ? refX / rect.width : 1
  const my = rect.height > 0 ? refY / rect.height : 1
  return [
    outputAnchor[0] + (0.5 - outputAnchor[0]) * mx,
    outputAnchor[1] + (0.5 - outputAnchor[1]) * my,
  ]
}

/** Colour of the 9-point snap targets shown while dragging (yellow). Inline
 *  affordance colour (like `handleColor`), not a brand token — DS-ify later if
 *  it needs to be themeable. Must match the magnet in the point-drag handler. */
const SNAP_TARGET_COLOR = '#eab308'
/** Snap-magnet radius in screen px (must match THRESHOLD in the point-drag handler). */
const SNAP_THRESHOLD = 10

/** Coordinate-space dispatch: a point declares `space` ('px' default, or 'uv').
 *  These map its stored param values to/from screen so px and UV handles share
 *  the same render/drag code — only the mapping differs. UV renormalizes with
 *  `rect`, so a UV handle tracks its canvas landmark across resizes. */
function pointToScreen(
  point: Pick<GizmoPoint, 'space'>,
  xVal: number,
  yVal: number,
  rect: Rect,
  anchor: [number, number],
): { x: number; y: number } {
  return point.space === 'uv' ? uvToScreen(xVal, yVal, rect) : pointPxToScreen(xVal, yVal, rect, anchor)
}

function screenToPoint(
  point: Pick<GizmoPoint, 'space'>,
  sx: number,
  sy: number,
  rect: Rect,
  anchor: [number, number],
): { x: number; y: number } {
  if (point.space === 'uv') {
    const { u, v } = screenToUv(sx, sy, rect)
    return { x: u, y: v }
  }
  return screenToPointPx(sx, sy, rect, anchor)
}

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

  // The Fragment Output anchor (as an [x,y] fraction) — the shader's px-space
  // origin (grad_center) slides toward it as the canvas diverges from
  // REFERENCE_SIZE, so the px gizmo must follow. Read from the fragment_output node.
  const outputAnchor = useMemo<[number, number]>(() => {
    const fo = nodes.find((n) => n.data.type === 'fragment_output')
    return anchorToVec2((fo?.data.params?.anchor as string) ?? 'center')
  }, [nodes])

  // The selected node's captured reference resolution (CSS px, 0 = uncaptured) —
  // feeds pxOriginFrac so the gizmo origin matches the shader's grad_center.
  const nodeRefRes = useMemo<[number, number]>(() => [
    (currentParams.refResX as number | undefined) ?? 0,
    (currentParams.refResY as number | undefined) ?? 0,
  ], [currentParams])

  // --- Canvas rect tracking -------------------------------------------------

  const canvasElRef = useRef<HTMLCanvasElement | null>(null)
  const [canvasRect, setCanvasRect] = useState<Rect | null>(null)
  // Mirror of canvasRect for the rAF change-check (avoids a stale-closure read).
  const canvasRectRef = useRef<Rect | null>(null)
  const [dragging, setDragging] = useState<DragState | null>(null)

  // Resolve the active target container's <canvas> child and keep canvasRect
  // synced via ResizeObserver (size changes) + window resize/scroll
  // (position changes from layout/viewport changes).
  useEffect(() => {
    if (!gizmoActive) {
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
    const container = targetMap[previewMode]
    const canvas = container?.querySelector('canvas') ?? null
    canvasElRef.current = canvas
    if (!canvas) {
      setCanvasRect(null)
      return
    }

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
        const prev = canvasRectRef.current
        const changed =
          !prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height
        if (changed) {
          const next = { left: r.left, top: r.top, width: r.width, height: r.height }
          canvasRectRef.current = next
          // flushSync so handles reposition in the SAME frame the canvas moved/
          // resized (plain setState commits a frame later — visible lag while
          // dragging the window/split). Only runs when the rect actually changed
          // (a canvas resize), so a static preview — and anchor switches, which
          // don't resize the canvas — cost nothing and are unaffected.
          flushSync(() => setCanvasRect(next))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [gizmoActive])

  // Capture the reference resolution once: when a pinned gradient is being
  // authored (refRes still 0), snap it to the current preview-canvas CSS size so
  // grad_center pins against it — the gradient then survives anchor switches at
  // this size and pins on resize, WITHOUT mutating p0/p1 (keeps the thumbnail
  // stable). Scoped to the selected node (you author the one you're editing).
  useEffect(() => {
    if (!selectedNode || selectedNode.data.type !== 'gradient') return
    if (selectedNode.data.params?.drawMode !== 'pinned') return
    if (((selectedNode.data.params?.refResX as number | undefined) ?? 0) > 0) return
    if (!canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) return
    updateNodeData(selectedNode.id, {
      params: {
        ...selectedNode.data.params,
        refResX: Math.round(canvasRect.width),
        refResY: Math.round(canvasRect.height),
      },
    })
  }, [selectedNode, canvasRect, updateNodeData])

  // Drag lifetime: bind move/up/cancel on `window` so release is caught even
  // off-canvas — no setPointerCapture, mirroring the ImageUploader gizmo.
  useEffect(() => {
    if (!dragging || !selectedNode) return
    const nodeId = selectedNode.id

    const onMove = (e: PointerEvent) => {
      const canvas = canvasElRef.current
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      const anchor = pxOriginFrac(r, outputAnchor, nodeRefRes)
      const latest = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
      const latestParams = (latest?.data.params ?? {}) as Record<string, unknown>

      if (dragging.kind === 'point') {
        const draggedPoint = gizmo?.points.find((p) => p.id === dragging.pointId)
        let sx = e.clientX
        let sy = e.clientY
        if (e.shiftKey) {
          // Shift = angle snap. Constrain the cursor to 15deg increments around
          // this point's PIVOT — the `from` end of the connector that points at
          // this point (dragging p1 pivots around p0). Distance preserved; only
          // the angle snaps. Magnet is suppressed while Shift is held so precise
          // angle work isn't yanked to a landmark.
          const pivotId = gizmo?.connectors?.find((c) => c.to === dragging.pointId)?.from
          const pivot = pivotId ? gizmo?.points.find((p) => p.id === pivotId) : undefined
          if (pivot) {
            const pvx = (latestParams[pivot.xParam] as number | undefined) ??
              (allParams.find((pp) => pp.id === pivot.xParam)?.default as number | undefined) ?? 0
            const pvy = (latestParams[pivot.yParam] as number | undefined) ??
              (allParams.find((pp) => pp.id === pivot.yParam)?.default as number | undefined) ?? 0
            const Ps = pointToScreen(pivot, pvx, pvy, r, anchor)
            const ddx = sx - Ps.x
            const ddy = sy - Ps.y
            const dist = Math.hypot(ddx, ddy)
            if (dist > 1e-6) {
              const step = Math.PI / 12 // 15deg
              const snapped = Math.round(Math.atan2(ddy, ddx) / step) * step
              sx = Ps.x + Math.cos(snapped) * dist
              sy = Ps.y + Math.sin(snapped) * dist
            }
          }
        } else {
          // 9-point canvas magnet: snap onto the nearest canvas anchor (corners /
          // edge-midpoints / centre) when within THRESHOLD screen px. Always on
          // (no modifier) — the small radius keeps it unobtrusive and you can
          // pull away freely.
          const THRESHOLD = SNAP_THRESHOLD
          const xs = [r.left, r.left + r.width / 2, r.left + r.width]
          const ys = [r.top, r.top + r.height / 2, r.top + r.height]
          let bestD = THRESHOLD
          let bestX = sx
          let bestY = sy
          for (const ax of xs) {
            for (const ay of ys) {
              const d = Math.hypot(sx - ax, sy - ay)
              if (d <= bestD) {
                bestD = d
                bestX = ax
                bestY = ay
              }
            }
          }
          sx = bestX
          sy = bestY
        }
        const { x, y } = screenToPoint(draggedPoint ?? {}, sx, sy, r, anchor)
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
      const Cs = pointToScreen(centerPoint, cx, cy, r, anchor)
      const Es = pointToScreen(endPoint, ex, ey, r, anchor)
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

    // Hold the Move cursor for the whole drag, even when the pointer leaves the
    // small handle (restored on release).
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
  }, [dragging, outputAnchor, nodeRefRes, selectedNode, updateNodeData, gizmo, allParams])

  if (!gizmoActive || !gizmo || !canvasRect) return null

  // Built from ALL gizmo points (not just currently-visible ones) so aspect
  // handles/outline can resolve their centerPoint/endPoint even if that point
  // itself isn't rendered as a handle.
  const pxAnchor = pxOriginFrac(canvasRect, outputAnchor, nodeRefRes)
  const pointScreenPos = new Map<string, { x: number; y: number }>()
  for (const p of gizmo.points) {
    // Fall back to the param's DEFINITION default (not 0) for points the user
    // hasn't dragged yet — else every unset point collapses onto the anchor.
    const xDef = allParams.find((pp) => pp.id === p.xParam)?.default
    const yDef = allParams.find((pp) => pp.id === p.yParam)?.default
    const px = (currentParams[p.xParam] as number) ?? (xDef as number) ?? 0
    const py = (currentParams[p.yParam] as number) ?? (yDef as number) ?? 0
    pointScreenPos.set(p.id, pointToScreen(p, px, py, canvasRect, pxAnchor))
  }

  // Ids of points currently rendered — used to gate connectors (which have no
  // showWhen of their own) so a hidden point set draws no connector.
  const visiblePointIds = new Set(visiblePoints.map((p) => p.id))

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

      {/* 9-point snap targets — visible only while dragging a point, marking the
          canvas anchors (corners / edge-midpoints / centre) the magnet snaps to. */}
      {dragging?.kind === 'point' && (
        <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
          {[0, 0.5, 1].flatMap((fx) =>
            [0, 0.5, 1].map((fy) => (
              <circle
                key={`snap-${fx}-${fy}`}
                cx={fx * canvasRect.width}
                cy={fy * canvasRect.height}
                r={SNAP_THRESHOLD / 2}
                fill={SNAP_TARGET_COLOR}
                fillOpacity={0.85}
              />
            )),
          )}
        </svg>
      )}

      {gizmo.connectors && gizmo.connectors.length > 0 && (
        <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
          {gizmo.connectors.map((c) => {
            // Only draw a connector when BOTH its endpoints are visible — else a
            // hidden point set (e.g. the Pinned points while in Stretch mode)
            // would still draw its connector, using stale/off-screen positions.
            if (!visiblePointIds.has(c.from) || !visiblePointIds.has(c.to)) return null
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
              cursor: moveCursor(),
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
              cursor: moveCursor(),
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
