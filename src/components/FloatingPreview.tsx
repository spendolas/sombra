import { useRef, useCallback, useEffect, useMemo, type RefObject } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { useSettingsStore } from '@/stores/settingsStore'

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

    const compute = (ev: MouseEvent) => {
      const dx = ev.clientX - startMouseX
      const dy = ev.clientY - startMouseY
      const maxW = sx < 0 ? startPos.x + startW : sx > 0 ? window.innerWidth - startPos.x : startW
      const maxH = sy < 0 ? startPos.y + startH : sy > 0 ? window.innerHeight - startPos.y : startH
      const w = Math.max(MIN_W, Math.min(startW + sx * dx, maxW))
      const h = Math.max(MIN_H, Math.min(startH + sy * dy, maxH))
      const x = sx < 0 ? startPos.x + startW - w : startPos.x
      const y = sy < 0 ? startPos.y + startH - h : startPos.y
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

  return (
    <div
      ref={panelRef}
      className="fixed z-40 rounded-lg border border-edge bg-black shadow-2xl overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width: floatingSize.width,
        height: floatingSize.height,
      }}
    >
      <PreviewToolbar className="absolute top-2 right-2 z-10" />
      {/* Invisible drag surface */}
      <div
        className="absolute top-0 left-0 right-0 h-8 z-[5] cursor-grab active:cursor-grabbing opacity-0 hover:opacity-10 transition-opacity bg-surface-raised"
        onMouseDown={onDragStart}
      />
      <div ref={targetRef} className="w-full h-full" />
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
