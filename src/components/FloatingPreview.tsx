import { useRef, useCallback, useEffect, useMemo, type RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { ShaderPlaceholder } from './ShaderPlaceholder'
import { useSettingsStore } from '@/stores/settingsStore'
import { ds } from '@/generated/ds'

const MIN_W = 200
const MIN_H = 150
const MARGIN = 16

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

      let w: number, h: number, x: number, y: number

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

        // Viewport ceiling
        if (isAlt) {
          // Center-based: each edge distance from center limits scale
          scale = Math.min(scale,
            2 * centerX / startW, 2 * (vw - centerX) / startW,
            2 * centerY / startH, 2 * (vh - centerY) / startH,
          )
        } else {
          // Anchor-based: per-axis distance to viewport edge
          const limW = sx > 0 ? (vw - startPos.x) / startW
                     : sx < 0 ? (startPos.x + startW) / startW
                     : (vw - startPos.x) / startW
          const limH = sy > 0 ? (vh - startPos.y) / startH
                     : sy < 0 ? (startPos.y + startH) / startH
                     : (vh - startPos.y) / startH
          scale = Math.min(scale, limW, limH)
        }

        w = startW * scale
        h = startH * scale

        if (isAlt) {
          x = centerX - w / 2
          y = centerY - h / 2
        } else {
          x = sx < 0 ? startPos.x + startW - w : startPos.x
          y = sy < 0 ? startPos.y + startH - h : startPos.y
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
      className={ds.floatingPreview.root}
      style={{
        left: pos.x,
        top: pos.y,
        width: floatingSize.width,
        height: floatingSize.height,
      }}
    >
      <PreviewToolbar className="absolute top-xl right-xl z-10" />
      {/* Invisible drag surface */}
      <div
        className="absolute top-0 left-0 right-0 h-8 z-[5] cursor-grab active:cursor-grabbing"
        onMouseDown={onDragStart}
      />
      <div ref={targetRef} className="w-full h-full" />
      <ShaderPlaceholder />
      {/* Resize edges */}
      <div className="absolute top-0 left-3 right-3 h-1.5 cursor-n-resize z-20" onMouseDown={(e) => onResizeStart(0, -1, e)} />
      <div className="absolute bottom-0 left-3 right-3 h-1.5 cursor-s-resize z-20" onMouseDown={(e) => onResizeStart(0, 1, e)} />
      <div className="absolute left-0 top-3 bottom-3 w-1.5 cursor-w-resize z-20" onMouseDown={(e) => onResizeStart(-1, 0, e)} />
      <div className="absolute right-0 top-3 bottom-3 w-1.5 cursor-e-resize z-20" onMouseDown={(e) => onResizeStart(1, 0, e)} />
      {/* Resize corners */}
      <div className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize z-20" onMouseDown={(e) => onResizeStart(-1, -1, e)} />
      <div className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize z-20" onMouseDown={(e) => onResizeStart(1, -1, e)} />
      <div className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize z-20" onMouseDown={(e) => onResizeStart(-1, 1, e)} />
      <div className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize z-20" onMouseDown={(e) => onResizeStart(1, 1, e)} />
    </div>
  )
}
