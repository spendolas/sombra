import { useRef, useCallback, useEffect, useMemo, type RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { useSettingsStore } from '@/stores/settingsStore'
import { ds } from '@/generated/ds'

const MIN_W = 200
const MIN_H = 150
const MARGIN = 16

/** Toggle to visualize hit areas: yellow=drag, red=resize edges, blue=resize corners */
const DEBUG_HIT_AREAS = false

interface FloatingPreviewProps {
  targetRef: RefObject<HTMLDivElement | null>
}

export function FloatingPreview({ targetRef }: FloatingPreviewProps) {
  const floatingPosition = useSettingsStore((s) => s.floatingPosition)
  const floatingSize = useSettingsStore((s) => s.floatingSize)
  const setFloatingPosition = useSettingsStore((s) => s.setFloatingPosition)
  const setFloatingSize = useSettingsStore((s) => s.setFloatingSize)

  const panelRef = useRef<HTMLDivElement>(null)

  // Compute default position (bottom-right) on first render if sentinel
  const pos = useMemo(() =>
    floatingPosition.x === -1 && floatingPosition.y === -1
      ? { x: window.innerWidth - floatingSize.width - MARGIN, y: window.innerHeight - floatingSize.height - MARGIN }
      : floatingPosition,
    [floatingPosition, floatingSize.width, floatingSize.height]
  )

  // Clamp helper
  const clamp = useCallback((x: number, y: number, w: number, h: number) => ({
    x: Math.max(0, Math.min(x, window.innerWidth - w)),
    y: Math.max(0, Math.min(y, window.innerHeight - h)),
  }), [])

  // Drag handler
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startPos = { ...pos }

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const clamped = clamp(startPos.x + dx, startPos.y + dy, floatingSize.width, floatingSize.height)
      if (panelRef.current) {
        panelRef.current.style.left = `${clamped.x}px`
        panelRef.current.style.top = `${clamped.y}px`
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const clamped = clamp(startPos.x + dx, startPos.y + dy, floatingSize.width, floatingSize.height)
      setFloatingPosition(clamped)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos, floatingSize, clamp, setFloatingPosition])

  // Resize handler — sx/sy: +1 = grow toward right/bottom, -1 = grow toward left/top
  const onResizeStart = useCallback((sx: number, sy: number, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startMouseX = e.clientX
    const startMouseY = e.clientY
    const startW = floatingSize.width
    const startH = floatingSize.height
    const startPos = { ...pos }

    const centerX = startPos.x + startW / 2
    const centerY = startPos.y + startH / 2

    const compute = (ev: MouseEvent) => {
      const dx = ev.clientX - startMouseX
      const dy = ev.clientY - startMouseY
      const vw = window.innerWidth
      const vh = window.innerHeight
      const isAlt = ev.altKey
      const isShift = ev.shiftKey
      const isCorner = sx !== 0 && sy !== 0
      const mul = isAlt ? 2 : 1

      let w = startW, h = startH, x = startPos.x, y = startPos.y

      if (isShift) {
        // ── Uniform scale: aspect ratio locked ──
        let scale: number
        if (isCorner) {
          // Dominant axis → edge follows mouse
          scale = Math.max(
            (startW + mul * sx * dx) / startW,
            (startH + mul * sy * dy) / startH,
          )
        } else {
          // Dragged axis determines scale
          scale = sx !== 0
            ? (startW + mul * sx * dx) / startW
            : (startH + mul * sy * dy) / startH
        }

        // Minimum size floor
        scale = Math.max(scale, MIN_W / startW, MIN_H / startH)

        if (isAlt) {
          // Smooth max for corners: eliminates the kink where dominant axis switches
          if (isCorner) {
            const a = (startW + mul * sx * dx) / startW
            const b = (startH + mul * sy * dy) / startH
            const eps = 0.01
            scale = (a + b + Math.sqrt((a - b) ** 2 + eps * eps)) / 2
            scale = Math.max(scale, MIN_W / startW, MIN_H / startH)
          }

          const aspect = startW / startH
          const idealW = startW * scale
          const idealH = startH * scale

          let lo_x = centerX - idealW / 2, hi_x = centerX + idealW / 2
          let lo_y = centerY - idealH / 2, hi_y = centerY + idealH / 2

          // Pin opposite edges to viewport
          if (sx > 0 && lo_x < 0) lo_x = 0
          if (sx < 0 && hi_x > vw) hi_x = vw
          if (sy > 0 && lo_y < 0) lo_y = 0
          if (sy < 0 && hi_y > vh) hi_y = vh
          // Non-dragged axes: clamp both edges
          if (sx === 0) { lo_x = Math.max(0, lo_x); hi_x = Math.min(vw, hi_x) }
          if (sy === 0) { lo_y = Math.max(0, lo_y); hi_y = Math.min(vh, hi_y) }
          // Clamp dragged edges to viewport
          hi_x = Math.min(vw, hi_x); lo_x = Math.max(0, lo_x)
          hi_y = Math.min(vh, hi_y); lo_y = Math.max(0, lo_y)

          const availW = hi_x - lo_x, availH = hi_y - lo_y

          // Fit aspect-correct rect in bounding box
          if (availW / availH > aspect) {
            h = availH; w = h * aspect
          } else {
            w = availW; h = w / aspect
          }

          // Position: center-based, clamped to stay within bounding box
          x = Math.max(lo_x, Math.min(centerX - w / 2, hi_x - w))
          y = Math.max(lo_y, Math.min(centerY - h / 2, hi_y - h))
        } else {
          // Anchor-based: viewport ceiling via scale
          // Non-dragged axes: full viewport dimension (position clamp handles edge hits)
          const limW = sx > 0 ? (vw - startPos.x) / startW
                     : sx < 0 ? (startPos.x + startW) / startW
                     : vw / startW
          const limH = sy > 0 ? (vh - startPos.y) / startH
                     : sy < 0 ? (startPos.y + startH) / startH
                     : vh / startH
          scale = Math.min(scale, limW, limH)

          w = startW * scale
          h = startH * scale
        }

        if (!isAlt) {
          // Dragged axes: anchor at opposite edge.
          // Non-dragged axes: center-based, clamped to viewport (shifts when edge hits).
          x = sx > 0 ? startPos.x : sx < 0 ? startPos.x + startW - w : Math.max(0, Math.min(centerX - w / 2, vw - w))
          y = sy > 0 ? startPos.y : sy < 0 ? startPos.y + startH - h : Math.max(0, Math.min(centerY - h / 2, vh - h))
        }

      } else if (isAlt) {
        // ── Center-based, axes independent ──
        if (sx !== 0) {
          const half = Math.max(MIN_W / 2, (startW + 2 * sx * dx) / 2)
          let lo = centerX - half
          let hi = centerX + half
          // Pin opposite edge to viewport
          if (sx > 0 && lo < 0) lo = 0
          if (sx < 0 && hi > vw) hi = vw
          // Clamp dragged edge to viewport
          if (hi > vw) hi = vw
          if (lo < 0) lo = 0
          x = lo; w = hi - lo
        } else {
          w = startW; x = startPos.x
        }

        if (sy !== 0) {
          const half = Math.max(MIN_H / 2, (startH + 2 * sy * dy) / 2)
          let lo = centerY - half
          let hi = centerY + half
          if (sy > 0 && lo < 0) lo = 0
          if (sy < 0 && hi > vh) hi = vh
          if (hi > vh) hi = vh
          if (lo < 0) lo = 0
          y = lo; h = hi - lo
        } else {
          h = startH; y = startPos.y
        }

      } else {
        // ── Anchor-based, axes independent ──
        w = sx !== 0 ? Math.max(MIN_W, startW + sx * dx) : startW
        h = sy !== 0 ? Math.max(MIN_H, startH + sy * dy) : startH

        x = sx < 0 ? startPos.x + startW - w : startPos.x
        y = sy < 0 ? startPos.y + startH - h : startPos.y

        // Viewport clamp
        if (sx > 0 && x + w > vw) w = vw - x
        if (sx < 0 && x < 0) { x = 0; w = startPos.x + startW }
        if (sy > 0 && y + h > vh) h = vh - y
        if (sy < 0 && y < 0) { y = 0; h = startPos.y + startH }
      }

      return { x, y, w, h }
    }

    const onMove = (ev: MouseEvent) => {
      const { x, y, w, h } = compute(ev)
      if (panelRef.current) {
        panelRef.current.style.left = `${x}px`
        panelRef.current.style.top = `${y}px`
        panelRef.current.style.width = `${w}px`
        panelRef.current.style.height = `${h}px`
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const { x, y, w, h } = compute(ev)
      setFloatingSize({ width: w, height: h })
      setFloatingPosition({ x, y })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [pos, floatingSize, setFloatingSize, setFloatingPosition])

  // Persist sentinel → real position on mount
  useEffect(() => {
    if (floatingPosition.x === -1 && floatingPosition.y === -1) {
      setFloatingPosition(pos)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-clamp when browser window resizes
  useEffect(() => {
    const onResize = () => {
      const maxX = window.innerWidth - floatingSize.width
      const maxY = window.innerHeight - floatingSize.height
      const clampedX = Math.max(0, Math.min(pos.x, maxX))
      const clampedY = Math.max(0, Math.min(pos.y, maxY))
      const newW = Math.max(MIN_W, Math.min(floatingSize.width, window.innerWidth))
      const newH = Math.max(MIN_H, Math.min(floatingSize.height, window.innerHeight))
      if (clampedX !== pos.x || clampedY !== pos.y) {
        setFloatingPosition({ x: clampedX, y: clampedY })
      }
      if (newW !== floatingSize.width || newH !== floatingSize.height) {
        setFloatingSize({ width: newW, height: newH })
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos, floatingSize, setFloatingPosition, setFloatingSize])

  return (
    <div
      ref={panelRef}
      className="fixed z-40"
      style={{
        left: pos.x,
        top: pos.y,
        width: floatingSize.width,
        height: floatingSize.height,
      }}
    >
      {/* Inner: visual styling + overflow-hidden for content — z-10 so resize handles (z-30) sit on top */}
      <div className={ds.floatingPreview.root + ' w-full h-full !relative z-10'}>
        <PreviewToolbar className="absolute top-xl right-xl z-10" />
        {/* Invisible drag surface */}
        <div
          className={`absolute top-0 left-0 right-0 h-8 z-[5] cursor-grab active:cursor-grabbing${DEBUG_HIT_AREAS ? ' bg-yellow-500/30' : ''}`}
          onMouseDown={onDragStart}
        />
        <div ref={targetRef} className="w-full h-full" />
        <ShaderPlaceholder />
      </div>
      {/* Resize edges — 12px hit area (6px each side of boundary) */}
      <div className={`absolute -top-1.5 left-3 right-3 h-3 cursor-n-resize z-50${DEBUG_HIT_AREAS ? ' bg-red-500/30' : ''}`} onMouseDown={(e) => onResizeStart(0, -1, e)} />
      <div className={`absolute -bottom-1.5 left-3 right-3 h-3 cursor-s-resize z-50${DEBUG_HIT_AREAS ? ' bg-red-500/30' : ''}`} onMouseDown={(e) => onResizeStart(0, 1, e)} />
      <div className={`absolute -left-1.5 top-3 bottom-3 w-3 cursor-w-resize z-50${DEBUG_HIT_AREAS ? ' bg-red-500/30' : ''}`} onMouseDown={(e) => onResizeStart(-1, 0, e)} />
      <div className={`absolute -right-1.5 top-3 bottom-3 w-3 cursor-e-resize z-50${DEBUG_HIT_AREAS ? ' bg-red-500/30' : ''}`} onMouseDown={(e) => onResizeStart(1, 0, e)} />
      {/* Resize corners */}
      <div className={`absolute -top-[12px] -left-[12px] w-[28px] h-[28px] cursor-nw-resize z-50${DEBUG_HIT_AREAS ? ' bg-blue-500/30' : ''}`} onMouseDown={(e) => onResizeStart(-1, -1, e)} />
      <div className={`absolute -top-[12px] -right-[12px] w-[28px] h-[28px] cursor-ne-resize z-50${DEBUG_HIT_AREAS ? ' bg-blue-500/30' : ''}`} onMouseDown={(e) => onResizeStart(1, -1, e)} />
      <div className={`absolute -bottom-[12px] -left-[12px] w-[28px] h-[28px] cursor-sw-resize z-50${DEBUG_HIT_AREAS ? ' bg-blue-500/30' : ''}`} onMouseDown={(e) => onResizeStart(-1, 1, e)} />
      <div className={`absolute -bottom-[12px] -right-[12px] w-[28px] h-[28px] cursor-se-resize z-50${DEBUG_HIT_AREAS ? ' bg-blue-500/30' : ''}`} onMouseDown={(e) => onResizeStart(1, 1, e)} />
    </div>
  )
}
