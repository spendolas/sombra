/**
 * ImageUploader — Custom component for the Image node.
 * File upload + minimap-style viewport overlay with full SRT manipulation.
 *
 * The viewport polygon is computed by forward-mapping the 4 canvas corners
 * through the EXACT same SRT + fit/fill transform the shader uses.
 * This guarantees the overlay matches the preview.
 */

import { useRef, useCallback, useMemo, useState, useEffect, useId } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { usePreviewStore } from '@/stores/previewStore'
import { ds } from '@/generated/ds'
import { svgCursor, moveCursor } from '@/utils/cursors'

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif'
const CORNER_ZONE = 8
const EDGE_ZONE = 6
const ROTATE_ZONE = 20

type GestureMode = 'offset' | 'scale' | 'rotate'

interface DragState {
  mode: GestureMode
  startClientX: number; startClientY: number
  startOffsetX: number; startOffsetY: number
  startScale: number; startRotate: number
  anchorX: number; anchorY: number; startDist: number
  anchorU: number; anchorV: number
  startAngle: number
  centerX: number; centerY: number
}

type Pt = [number, number]

// ---------------------------------------------------------------------------
// Forward transform: v_uv → image UV (matches GLSL exactly)
// ---------------------------------------------------------------------------

/**
 * Map a canvas-space UV point through the shader's SRT + fit/fill chain.
 * Returns the image-space UV where the texture is sampled.
 *
 * Replicates glsl-generator.ts lines 479-509 (SRT)
 *         + image.ts lines 70-87 (fit/fill)
 */
function canvasToImageUV(
  uv: Pt,
  scale: number, rotateDeg: number,
  translateX: number, translateY: number,
  canvasW: number, canvasH: number,
  imageAspect: number, fitMode: string,
): Pt {
  const aspect = canvasW / canvasH
  const rad = rotateDeg * 0.01745329

  // SRT chain (glsl-generator.ts)
  let sx = uv[0] - 0.5
  let sy = uv[1] - 0.5
  sx /= scale
  sy /= scale
  // Aspect-corrected rotation
  sx *= aspect
  const cr = Math.cos(rad), sr = Math.sin(rad)
  const rx = sx * cr - sy * sr
  const ry = sx * sr + sy * cr
  sx = rx / aspect
  sy = ry
  // Translate (note: GLSL does -= vec2(tX, -tY) / resolution)
  sx -= translateX / canvasW
  sy -= (-translateY) / canvasH
  sx += 0.5
  sy += 0.5

  // Fit/Fill (image.ts)
  const ratio = imageAspect / aspect
  let imgX = sx, imgY = sy
  if (fitMode === 'contain') {
    if (ratio > 1) imgY = (sy - 0.5) * ratio + 0.5
    else           imgX = (sx - 0.5) / ratio + 0.5
  } else {
    if (ratio > 1) imgX = (sx - 0.5) / ratio + 0.5
    else           imgY = (sy - 0.5) * ratio + 0.5
  }
  return [imgX, imgY]
}

/** Map all 4 canvas corners to image-space, then to thumbnail pixel coords. */
function computePolygon(
  scale: number, rotateDeg: number,
  translateX: number, translateY: number,
  canvasW: number, canvasH: number,
  imageAspect: number, fitMode: string,
  thumbW: number, thumbH: number,
): Pt[] {
  const corners: Pt[] = [[0,0], [1,0], [1,1], [0,1]]
  return corners.map(uv => {
    const [ix, iy] = canvasToImageUV(
      uv, scale, rotateDeg, translateX, translateY,
      canvasW, canvasH, imageAspect, fitMode,
    )
    return [ix * thumbW, (1 - iy) * thumbH] as Pt
  })
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centroid(pts: Pt[]): Pt {
  const n = pts.length
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
  ]
}

function pointInPolygon(px: number, py: number, pts: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi)
      inside = !inside
  }
  return inside
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - a[0], py - a[1])
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

// ---------------------------------------------------------------------------
// Custom cursor icons — Move / Scale / Rotate
// Each uses white outline + indigo stroke for visibility on any background.
// ---------------------------------------------------------------------------

// svgCursor + moveCursor now live in ../utils/cursors (shared with the preview
// gizmo overlay). scale/rotate cursors below stay local (angle-parameterised).

/** Double-ended arrow for scale drag, rotated to match handle direction. */
function scaleCursor(angleDeg: number): string {
  const a = Math.round(angleDeg)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">`
    + `<g transform="rotate(${a} 12 12)">`
    + `<g stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M5 12h14"/>`
    + `<path d="M5 12l3-2.5m-3 2.5l3 2.5"/>`
    + `<path d="M19 12l-3-2.5m3 2.5l-3 2.5"/>`
    + `</g>`
    + `<g stroke="#6366f1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M5 12h14"/>`
    + `<path d="M5 12l3-2.5m-3 2.5l3 2.5"/>`
    + `<path d="M19 12l-3-2.5m3 2.5l-3 2.5"/>`
    + `</g></g></svg>`
  return svgCursor(svg, 'pointer')
}

/** Curved arrow for rotate drag, follows pointer angle around centroid.
 *  Geometry from the Figma "Rotate" icon (569:17): quarter arc bisecting the
 *  +x (3 o'clock) direction, ±45° endpoints, concave toward the center, with a
 *  corner arrowhead at each end. Bisecting +x aligns the tangential arrows with
 *  the code's `angle = atan2(py-cy, px-cx)` (angle 0 = pointer right of pivot).
 *  Two-layer (white outline + indigo) for visibility on any background. */
function rotateCursor(angleDeg: number): string {
  const a = Math.round(angleDeg)
  const paths = `<path d="M16.9497 15.5356L16.9497 18.364L19.7782 18.364"/>`
    + `<path d="M16.9498 8.46451L16.9498 5.63608L19.7782 5.63608"/>`
    + `<path d="M17.6569 17.6569C18.3997 16.914 18.989 16.0321 19.391 15.0615C19.7931 14.0909 20 13.0506 20 12C20 10.9494 19.7931 9.90914 19.391 8.93853C18.989 7.96793 18.3997 7.08601 17.6569 6.34314"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">`
    + `<g transform="rotate(${a} 12 12)">`
    + `<g stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`
    + `<g stroke="#6366f1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`
    + `</g></svg>`
  return svgCursor(svg, 'alias')
}

// ---------------------------------------------------------------------------
// Polygon hit testing
// ---------------------------------------------------------------------------

function hitTestPolygon(
  px: number, py: number, poly: Pt[],
): { mode: GestureMode; cursor: string; vertexIdx?: number; isEdge?: boolean } | null {
  const cx = centroid(poly)

  // Check vertices (corners)
  for (let i = 0; i < poly.length; i++) {
    if (Math.hypot(px - poly[i][0], py - poly[i][1]) < CORNER_ZONE) {
      const angle = Math.atan2(poly[i][1] - cx[1], poly[i][0] - cx[0]) * 180 / Math.PI
      return { mode: 'scale', cursor: scaleCursor(angle), vertexIdx: i }
    }
  }

  // Check edges
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    if (distToSegment(px, py, poly[i], poly[j]) < EDGE_ZONE) {
      const midX = (poly[i][0] + poly[j][0]) / 2
      const midY = (poly[i][1] + poly[j][1]) / 2
      const angle = Math.atan2(midY - cx[1], midX - cx[0]) * 180 / Math.PI
      return { mode: 'scale', cursor: scaleCursor(angle), vertexIdx: i, isEdge: true }
    }
  }

  // Inside polygon → offset
  if (pointInPolygon(px, py, poly)) return { mode: 'offset', cursor: moveCursor() }

  // Outside but within threshold → rotate
  const expanded = poly.map(p => {
    const dx = p[0] - cx[0], dy = p[1] - cx[1]
    const d = Math.hypot(dx, dy)
    if (d === 0) return p
    return [p[0] + dx / d * ROTATE_ZONE, p[1] + dy / d * ROTATE_ZONE] as Pt
  })
  if (pointInPolygon(px, py, expanded)) {
    const angle = Math.atan2(py - cx[1], px - cx[0]) * 180 / Math.PI
    return { mode: 'rotate', cursor: rotateCursor(angle) }
  }

  return null
}

// ---------------------------------------------------------------------------
// Canvas size hook
// ---------------------------------------------------------------------------

/**
 * Returns physical pixel dimensions matching u_resolution in GLSL.
 * Reads previewStore's mainCanvasSize (fed by App's ResizeObserver on the one
 * true, reparented main canvas). The previous implementation did a one-shot
 * `document.querySelector('canvas')` per mounted instance — the node-card and
 * properties-panel copies of this component each grabbed whichever canvas
 * existed at their own mount moment (often an 80×80 thumbnail), so their SRT
 * overlays visibly disagreed for the same node.
 */
function useCanvasSize(): [number, number] {
  return usePreviewStore((s) => s.mainCanvasSize)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImageUploader({ nodeId, data }: {
  nodeId: string; data: Record<string, unknown>
}) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [thumbSize, setThumbSize] = useState<[number, number]>([156, 96])
  const [hoverCursor, setHoverCursor] = useState('default')
  // Toggled on pointerdown/up so the drag listeners live on `window` (below),
  // not on the <svg>. The gizmo restyles the polygon every frame, which slides
  // it out from under the cursor and silently drops pointer capture — binding
  // move/up on the element would then miss the release and strand the drag.
  const [dragging, setDragging] = useState(false)
  const maskId = useId().replace(/:/g, '_')

  const imageData = data.imageData as string | undefined
  const imageName = data.imageName as string | undefined
  const fitMode = (data.fitMode as string) || 'contain'
  const imageAspect = (data.imageAspect as number) || 1
  const imageWidth = (data.imageWidth as number) || 1920
  const imageHeight = (data.imageHeight as number) || 1080
  const scale = (data.srt_scale as number) || 1
  const rotateDeg = (data.srt_rotate as number) || 0
  const offsetX = (data.srt_translateX as number) || 0
  const offsetY = (data.srt_translateY as number) || 0

  const [canvasW, canvasH] = useCanvasSize()

  useEffect(() => {
    const el = thumbRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        setThumbSize([entry.contentRect.width, entry.contentRect.height])
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [imageData])

  const tw = thumbSize[0], th = thumbSize[1]

  // Polygon: 4 canvas corners mapped to thumbnail pixel coords
  const polygon = useMemo(
    () => computePolygon(
      scale, rotateDeg, offsetX, offsetY,
      canvasW, canvasH, imageAspect, fitMode, tw, th,
    ),
    [scale, rotateDeg, offsetX, offsetY, canvasW, canvasH, imageAspect, fitMode, tw, th],
  )
  const polyCenter = useMemo(() => centroid(polygon), [polygon])
  const pointsStr = useMemo(() => polygon.map(p => `${p[0]},${p[1]}`).join(' '), [polygon])

  // --- Gesture state ---
  const dragRef = useRef<DragState | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const clientToSvg = useCallback((cx: number, cy: number): Pt => {
    const svg = svgRef.current
    if (!svg) return [0, 0]
    const r = svg.getBoundingClientRect()
    return [(cx - r.left) / r.width * tw, (cy - r.top) / r.height * th]
  }, [tw, th])

  // --- Pointer handlers ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const [sx, sy] = clientToSvg(e.clientX, e.clientY)
    const hit = hitTestPolygon(sx, sy, polygon)
    if (!hit) return

    e.stopPropagation()
    e.preventDefault()

    const state: DragState = {
      mode: hit.mode,
      startClientX: e.clientX, startClientY: e.clientY,
      startOffsetX: offsetX, startOffsetY: offsetY,
      startScale: scale, startRotate: rotateDeg,
      anchorX: 0, anchorY: 0, startDist: 0,
      anchorU: 0.5, anchorV: 0.5,
      startAngle: 0,
      centerX: polyCenter[0], centerY: polyCenter[1],
    }

    if (hit.mode === 'scale') {
      const vi = hit.vertexIdx ?? 0
      const cornerUVs: Pt[] = [[0,0], [1,0], [1,1], [0,1]]

      if (e.altKey) {
        // Alt: center anchor
        state.anchorX = polyCenter[0]
        state.anchorY = polyCenter[1]
        state.anchorU = 0.5
        state.anchorV = 0.5
      } else if (hit.isEdge) {
        // Edge drag: anchor = midpoint of opposite edge
        const oppA = (vi + 2) % 4, oppB = (vi + 3) % 4
        state.anchorX = (polygon[oppA][0] + polygon[oppB][0]) / 2
        state.anchorY = (polygon[oppA][1] + polygon[oppB][1]) / 2
        state.anchorU = (cornerUVs[oppA][0] + cornerUVs[oppB][0]) / 2
        state.anchorV = (cornerUVs[oppA][1] + cornerUVs[oppB][1]) / 2
      } else {
        // Corner drag: anchor = opposite corner
        const oppIdx = (vi + 2) % 4
        state.anchorX = polygon[oppIdx][0]
        state.anchorY = polygon[oppIdx][1]
        state.anchorU = cornerUVs[oppIdx][0]
        state.anchorV = cornerUVs[oppIdx][1]
      }

      state.startDist = Math.hypot(sx - state.anchorX, sy - state.anchorY)
    }

    if (hit.mode === 'rotate') {
      state.startAngle = Math.atan2(sy - state.centerY, sx - state.centerX) * 180 / Math.PI
    }

    dragRef.current = state
    setDragging(true)
    document.body.style.cursor = hit.cursor
  }, [clientToSvg, polygon, polyCenter, offsetX, offsetY, scale, rotateDeg])

  // Element handler: hover-cursor hit-test only. Drag moves are handled by the
  // window listeners (effect below), so bail once a drag is active.
  const handleHoverMove = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) return
    const [sx, sy] = clientToSvg(e.clientX, e.clientY)
    const hit = hitTestPolygon(sx, sy, polygon)
    setHoverCursor(hit?.cursor || 'default')
  }, [clientToSvg, polygon])

  // Drag math, driven by window pointermove (clientX/clientY/altKey from the
  // native event). Reads the frozen gesture start from dragRef.
  const applyDrag = useCallback((clientX: number, clientY: number, altKey: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    const [sx, sy] = clientToSvg(clientX, clientY)

    if (drag.mode === 'offset') {
      // Client pixel delta → thumbnail pixel delta → image UV delta → invert fit/fill → offset
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      const dThumbX = (clientX - drag.startClientX) / r.width * tw
      const dThumbY = (clientY - drag.startClientY) / r.height * th

      let dImgU = dThumbX / tw
      let dImgV = -dThumbY / th

      // Invert fit/fill scaling
      const ratio = imageAspect / (canvasW / canvasH)
      if (fitMode === 'contain') {
        if (ratio > 1) dImgV /= ratio; else dImgU *= ratio
      } else {
        if (ratio > 1) dImgU *= ratio; else dImgV /= ratio
      }

      // Invert SRT translate: shader does srt -= vec2(tX, -tY)/res
      // So moving the viewport right in image space = decreasing tX
      const newTX = drag.startOffsetX - dImgU * canvasW
      const newTY = drag.startOffsetY + dImgV * canvasH

      const maxX = imageWidth / 2, maxY = imageHeight / 2
      updateNodeData(nodeId, {
        params: {
          ...dataRef.current,
          srt_translateX: Math.round(Math.max(-maxX, Math.min(maxX, newTX))),
          srt_translateY: Math.round(Math.max(-maxY, Math.min(maxY, newTY))),
        },
      })
    }

    if (drag.mode === 'scale') {
      const dist = Math.hypot(sx - drag.anchorX, sy - drag.anchorY)
      if (drag.startDist > 0.1) {
        const ratio = dist / drag.startDist
        let newScale = Math.max(0.01, drag.startScale / ratio)
        newScale = Math.round(newScale * 100) / 100
        const params: Record<string, unknown> = { ...dataRef.current, srt_scale: newScale }

        // Anchor compensation: exact SRT derivation keeps anchor corner fixed
        if (!altKey) {
          const u = drag.anchorU, v = drag.anchorV
          const aspect = canvasW / canvasH
          const rad = drag.startRotate * 0.01745329
          const c = Math.cos(rad), s = Math.sin(rad)
          const Kx = (u - 0.5) * c - (v - 0.5) * s / aspect
          const Ky = (u - 0.5) * aspect * s + (v - 0.5) * c
          const dInvS = 1 / newScale - 1 / drag.startScale
          params.srt_translateX = Math.round(drag.startOffsetX + Kx * canvasW * dInvS)
          params.srt_translateY = Math.round(drag.startOffsetY + Ky * canvasH * (-dInvS))
        }

        updateNodeData(nodeId, { params })
      }
    }

    if (drag.mode === 'rotate') {
      const angle = Math.atan2(sy - drag.centerY, sx - drag.centerX) * 180 / Math.PI
      let newRotate = drag.startRotate - (angle - drag.startAngle)
      while (newRotate > 180) newRotate -= 360
      while (newRotate < -180) newRotate += 360
      updateNodeData(nodeId, {
        params: { ...dataRef.current, srt_rotate: Math.round(newRotate) },
      })
    }
  }, [clientToSvg, tw, th, canvasW, canvasH, imageAspect, fitMode, imageWidth, imageHeight, nodeId, updateNodeData])

  // Drag lifetime: bind move/up/cancel on `window` so the release is caught
  // wherever the cursor lands — even after the gizmo has slid out from under it.
  // No pointer capture to silently drop; listeners are scoped to the drag.
  useEffect(() => {
    if (!dragging) return

    const onMove = (e: PointerEvent) => {
      e.preventDefault()
      applyDrag(e.clientX, e.clientY, e.altKey)
    }
    const onEnd = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      setDragging(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [dragging, applyDrag])

  // --- File handlers ---
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        const img = new Image()
        img.onload = () => {
          updateNodeData(nodeId, {
            params: {
              ...data, imageData: dataUrl, imageName: file.name,
              imageAspect: img.naturalWidth / img.naturalHeight,
              imageWidth: img.naturalWidth, imageHeight: img.naturalHeight,
            },
          })
        }
        img.src = dataUrl
      }
      reader.readAsDataURL(file)
    },
    [nodeId, data, updateNodeData],
  )

  const handleClick = useCallback(() => { fileInputRef.current?.click() }, [])

  const handleClear = useCallback(() => {
    updateNodeData(nodeId, {
      params: { ...data, imageData: '', imageName: '', imageAspect: 1, imageWidth: 0, imageHeight: 0 },
    })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [nodeId, data, updateNodeData])

  return (
    <div className="flex flex-col gap-y-md nodrag nowheel min-w-0 max-w-full overflow-hidden">
      <input ref={fileInputRef} type="file" accept={ACCEPTED_TYPES} onChange={handleFileChange} className="hidden" />

      {imageData ? (
        <>
          <div
            ref={thumbRef}
            className={ds.imageViewportOverlay.root}
            style={{ aspectRatio: imageAspect, width: '100%', maxWidth: '100%' }}
          >
            <img src={imageData} alt={imageName || 'Uploaded image'} className="absolute inset-0 w-full h-full" />
            <svg
              ref={svgRef}
              className="absolute inset-0 w-full h-full overflow-hidden touch-none"
              viewBox={`0 0 ${tw} ${th}`}
              style={{ cursor: hoverCursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handleHoverMove}
            >
              <defs>
                <mask id={`vp-${maskId}`}>
                  <rect x="0" y="0" width={tw} height={th} fill="white" />
                  <polygon points={pointsStr} fill="black" />
                </mask>
              </defs>
              <rect
                x="0" y="0" width={tw} height={th}
                fill="var(--surface)" opacity="0.7"
                mask={`url(#vp-${maskId})`}
                style={{ pointerEvents: 'none' }}
              />
              <polygon
                points={pointsStr}
                fill="transparent" stroke="var(--indigo)" strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />
              {/* Diamond marker at top-left corner (index 3 = TL in v_uv space) */}
              <rect
                x={polygon[3][0] - 3} y={polygon[3][1] - 3}
                width={6} height={6}
                fill="var(--indigo)"
                transform={`rotate(45 ${polygon[3][0]} ${polygon[3][1]})`}
                style={{ pointerEvents: 'none' }}
              />
            </svg>
          </div>

          <div className="flex flex-row items-center gap-sm">
            <span className="text-body text-fg-dim truncate flex-1" title={imageName}>
              {imageName || 'Image'}
            </span>
            <button
              onClick={handleClear}
              className="text-body text-fg-muted hover:text-fg transition-colors cursor-pointer shrink-0"
            >
              Clear
            </button>
          </div>
        </>
      ) : (
        <button
          onClick={handleClick}
          className="flex items-center justify-center w-full py-md rounded-sm bg-surface-raised border border-edge-subtle text-body text-fg-dim hover:bg-hover hover:text-fg transition-colors cursor-pointer"
        >
          Upload Image
        </button>
      )}
    </div>
  )
}
