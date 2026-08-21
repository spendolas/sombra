/**
 * ImageUploader — Custom component for the Image node.
 * File upload + minimap-style viewport overlay with full SRT manipulation.
 *
 * The viewport polygon is computed by forward-mapping the 4 canvas corners
 * through the EXACT same SRT + fit/fill transform the shader uses.
 * This guarantees the overlay matches the preview.
 */

import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { usePreviewStore } from '@/stores/previewStore'
import { ds } from '@/generated/ds'
import { svgCursor, moveCursor } from '@/utils/cursors'
import { processImageFile } from '@/utils/process-image'
import { REFERENCE_SIZE } from '@/renderer/constants'

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
// Model B overlay geometry — the thumbnail IS the canvas viewport (a fixed
// rectangle at the canvas aspect); the image transforms INSIDE it, exactly as
// the shader renders. Rotation stays clean (right angles preserved) and the
// image tracks the live output, unlike the old crop-region model where a
// rotated non-square viewport drew the visible region as a skewed parallelogram.
// ---------------------------------------------------------------------------

/**
 * imageToScreen — image-UV → screen_uv (v_uv, y-up, 0..1 over the canvas).
 *
 * The EXACT inverse of the shader's sample chain px_fit(emitSRT(auto_uv))
 * (ir/srt.ts `emitSRT` + image.ts px-based fit). auto_uv is isotropic, so the
 * image quad stays a clean rotated rectangle; drawn on the canvas-aspect thumb
 * (a uniform scaling of the canvas) it displays clean. u_anchor is the default
 * (0.5); a non-default Fragment Output anchor is not modelled here.
 */
function imageToScreen(
  iuv: Pt,
  scale: number, rotateDeg: number,
  translateX: number, translateY: number,
  canvasW: number, canvasH: number,
  imageAspect: number, fitMode: string,
): Pt {
  const rad = rotateDeg * 0.01745329
  const tDen = Math.min(window.devicePixelRatio || 1, 2) * REFERENCE_SIZE // u_dpr·u_ref_size
  const anchor = 0.5
  const A_c = canvasW / canvasH
  // imgDisp = the image's on-canvas pixel size (must match image.ts).
  const dh = fitMode === 'contain'
    ? (imageAspect > A_c ? canvasW / imageAspect : canvasH)
    : (imageAspect > A_c ? canvasH : canvasW / imageAspect)
  const dw = dh * imageAspect

  // 1. fit⁻¹: texUV → SRT'd auto_uv c (y negated — auto_uv y-down vs texture y-up).
  const cx = (iuv[0] - 0.5) * dw / tDen + anchor
  const cy = -(iuv[1] - 0.5) * dh / tDen + anchor

  // 2. emitSRT⁻¹ (world order): un-anchor, R(−θ), un-scale, re-add world translate.
  const dx = cx - anchor, dy = cy - anchor
  const c = Math.cos(rad), s = Math.sin(rad)
  const ax = (dx * c + dy * s) * scale + anchor + translateX / tDen
  const ay = (-dx * s + dy * c) * scale + anchor - translateY / tDen

  // 3. auto_uv → screen_uv (v_uv, y-up). auto_uv is isotropic (÷tDen both axes);
  //    screen_uv is canvas-normalised (÷res per axis) — the y-flip undoes auto_uv's.
  const sux = (ax - anchor) * tDen / canvasW + anchor
  const suy = 1 - anchor - (ay - anchor) * tDen / canvasH
  return [sux, suy]
}

/** The image's 4 corners (image-UV) → thumbnail px (screen_uv y-up → y-down). */
function computeImageQuad(
  scale: number, rotateDeg: number,
  translateX: number, translateY: number,
  canvasW: number, canvasH: number,
  imageAspect: number, fitMode: string,
  thumbW: number, thumbH: number,
): Pt[] {
  const corners: Pt[] = [[0,0], [1,0], [1,1], [0,1]]
  return corners.map(iuv => {
    const [sx, sy] = imageToScreen(
      iuv, scale, rotateDeg, translateX, translateY,
      canvasW, canvasH, imageAspect, fitMode,
    )
    return [sx * thumbW, (1 - sy) * thumbH] as Pt
  })
}

/**
 * CSS `matrix(a,b,c,d,e,f)` that places an <img> (sized thumbW×thumbH,
 * transform-origin 0 0) into computeImageQuad. The img's own box px (X,Y) maps
 * to image-UV (X/thumbW, 1−Y/thumbH); image-UV → thumb px is affine (fit⁻¹ and
 * emitSRT⁻¹ are both affine), so it is solved exactly from 3 corners.
 */
function computeImageMatrix(
  scale: number, rotateDeg: number,
  translateX: number, translateY: number,
  canvasW: number, canvasH: number,
  imageAspect: number, fitMode: string,
  thumbW: number, thumbH: number,
): [number, number, number, number, number, number] {
  const P = (iuv: Pt): Pt => {
    const [sx, sy] = imageToScreen(
      iuv, scale, rotateDeg, translateX, translateY,
      canvasW, canvasH, imageAspect, fitMode,
    )
    return [sx * thumbW, (1 - sy) * thumbH]
  }
  const [e, f] = P([0, 1])   // img box (0,0)
  const [t1x, t1y] = P([1, 1])   // img box (thumbW,0)
  const [t3x, t3y] = P([0, 0])   // img box (0,thumbH)
  return [
    (t1x - e) / thumbW, (t1y - f) / thumbW,
    (t3x - e) / thumbH, (t3y - f) / thumbH,
    e, f,
  ]
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
  const [processing, setProcessing] = useState(false)
  // Toggled on pointerdown/up so the drag listeners live on `window` (below),
  // not on the <svg>. The gizmo restyles the polygon every frame, which slides
  // it out from under the cursor and silently drops pointer capture — binding
  // move/up on the element would then miss the release and strand the drag.
  const [dragging, setDragging] = useState(false)

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

  // Model B: the image's 4 corners in thumbnail px (the movable element), plus
  // the CSS affine matrix that lays the <img> into that quad. Handles/hit-tests
  // run on this image quad; the viewport frame is the fixed thumbnail border.
  const polygon = useMemo(
    () => computeImageQuad(
      scale, rotateDeg, offsetX, offsetY,
      canvasW, canvasH, imageAspect, fitMode, tw, th,
    ),
    [scale, rotateDeg, offsetX, offsetY, canvasW, canvasH, imageAspect, fitMode, tw, th],
  )
  const imageMatrix = useMemo(
    () => computeImageMatrix(
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
      // Model B scales the image about its centre (shader scales about u_anchor
      // 0.5); startDist is the cursor's distance from that centre.
      state.startDist = Math.hypot(sx - polyCenter[0], sy - polyCenter[1])
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

    void altKey

    if (drag.mode === 'offset') {
      // Model B: the image moves in screen space. World translate is ADDITIVE in
      // screen (emitSRT⁻¹: screenX += tX/tDen, screenY −= tY/tDen), so a screen_uv
      // delta maps straight to the offset — no fit inversion, scale/rotate-free.
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      // Via imageToScreen, d(screen_uv.x)/d(tX) = 1/canvasW and
      // d(screen_uv.y)/d(tY) = 1/canvasH, so a screen_uv delta maps to the
      // offset by ×canvasW/×canvasH (Y flips: client y-down → screen y-up).
      const dSux = (clientX - drag.startClientX) / r.width
      const dClientYFrac = (clientY - drag.startClientY) / r.height
      const newTX = drag.startOffsetX + dSux * canvasW
      const newTY = drag.startOffsetY - dClientYFrac * canvasH

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
      // Scale about the image centre (shader scales about u_anchor 0.5): the image
      // quad's size is ∝ srt_scale, so the cursor's distance-from-centre ratio is
      // the scale ratio. World offset is scale-invariant → left untouched.
      const dist = Math.hypot(sx - drag.centerX, sy - drag.centerY)
      if (drag.startDist > 0.1) {
        let newScale = Math.max(0.05, drag.startScale * (dist / drag.startDist))
        newScale = Math.round(newScale * 100) / 100
        updateNodeData(nodeId, { params: { ...dataRef.current, srt_scale: newScale } })
      }
    }

    if (drag.mode === 'rotate') {
      // auto_uv is y-down and imageToScreen flips Y (screen_uv y-up), so the
      // displayed handle angle runs OPPOSITE to srt_rotate — the cursor angle
      // delta is subtracted so the image follows the drag.
      const angle = Math.atan2(sy - drag.centerY, sx - drag.centerX) * 180 / Math.PI
      let newRotate = drag.startRotate - (angle - drag.startAngle)
      while (newRotate > 180) newRotate -= 360
      while (newRotate < -180) newRotate += 360
      updateNodeData(nodeId, {
        params: { ...dataRef.current, srt_rotate: Math.round(newRotate) },
      })
    }
  }, [clientToSvg, canvasW, canvasH, imageWidth, imageHeight, nodeId, updateNodeData])

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
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      setProcessing(true)
      try {
        // Downscale + re-encode at import (Figma-style) so we store only a small
        // image, not the multi-MB original — see processImageFile.
        const { dataUrl, width, height, aspect } = await processImageFile(file)
        updateNodeData(nodeId, {
          params: {
            ...data, imageData: dataUrl, imageName: file.name,
            imageAspect: aspect, imageWidth: width, imageHeight: height,
          },
        })
      } catch (err) {
        console.error('[ImageUploader] failed to process image', err)
      } finally {
        setProcessing(false)
      }
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
            style={{
              aspectRatio: canvasW && canvasH ? canvasW / canvasH : imageAspect,
              width: '100%', maxWidth: '100%', overflow: 'hidden',
            }}
          >
            {/* Model B: the fixed viewport IS this box (canvas aspect); the image
                is placed inside it by the affine matrix, exactly as the shader
                renders — so rotation stays clean and it tracks the live output. */}
            <img
              src={imageData}
              alt={imageName || 'Uploaded image'}
              draggable={false}
              className="absolute top-0 left-0 select-none"
              style={{
                width: tw, height: th,
                transformOrigin: '0 0',
                transform: `matrix(${imageMatrix.join(',')})`,
                pointerEvents: 'none',
              }}
            />
            <svg
              ref={svgRef}
              className="absolute inset-0 w-full h-full overflow-hidden touch-none"
              viewBox={`0 0 ${tw} ${th}`}
              style={{ cursor: hoverCursor }}
              onPointerDown={handlePointerDown}
              onPointerMove={handleHoverMove}
            >
              {/* Image-bounds outline (the movable element). */}
              <polygon
                points={pointsStr}
                fill="transparent" stroke="var(--indigo)" strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />
              {/* Corner handles. */}
              {polygon.map((p, i) => (
                <rect
                  key={i}
                  x={p[0] - 3} y={p[1] - 3} width={6} height={6}
                  fill="var(--surface)" stroke="var(--indigo)" strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: 'none' }}
                />
              ))}
              {/* Orientation marker at the image top-left corner (index 3). */}
              <rect
                x={polygon[3][0] - 3} y={polygon[3][1] - 3}
                width={6} height={6}
                fill="var(--indigo)"
                transform={`rotate(45 ${polygon[3][0]} ${polygon[3][1]})`}
                style={{ pointerEvents: 'none' }}
              />
            </svg>
          </div>

          <div className="flex flex-row items-center gap-sm min-w-0">
            <span className="text-body text-fg-dim truncate flex-1 min-w-0" title={imageName}>
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
          disabled={processing}
          className="flex items-center justify-center w-full py-md rounded-sm bg-surface-raised border border-edge-subtle text-body text-fg-dim hover:bg-hover hover:text-fg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {processing ? 'Processing…' : 'Upload Image'}
        </button>
      )}
    </div>
  )
}
