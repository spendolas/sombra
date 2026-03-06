/**
 * Slider — thin native range input styled with DS tokens.
 * Used only by ZoomSlider for viewport zoom control.
 */

import { useRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import { ds } from "@/generated/ds"

interface SliderProps {
  className?: string
  value?: number[]
  min?: number
  max?: number
  step?: number
  orientation?: "horizontal" | "vertical"
  onValueChange?: (values: number[]) => void
}

function Slider({
  className,
  value,
  min = 0,
  max = 100,
  step = 1,
  orientation = "horizontal",
  onValueChange,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const currentValue = value?.[0] ?? min
  const fraction = max === min ? 0 : (currentValue - min) / (max - min)

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const track = trackRef.current
      if (!track) return

      const update = (clientX: number, clientY: number) => {
        const rect = track.getBoundingClientRect()
        let frac: number
        if (orientation === "vertical") {
          frac = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
        } else {
          frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        }
        const raw = min + frac * (max - min)
        const snapped = Math.round(raw / step) * step
        const clamped = Math.max(min, Math.min(max, snapped))
        onValueChange?.([clamped])
      }

      update(e.clientX, e.clientY)
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent) => update(ev.clientX, ev.clientY)
      const onUp = () => {
        document.removeEventListener("pointermove", onMove)
        document.removeEventListener("pointerup", onUp)
      }
      document.addEventListener("pointermove", onMove)
      document.addEventListener("pointerup", onUp)
    },
    [min, max, step, orientation, onValueChange]
  )

  const isVertical = orientation === "vertical"

  return (
    <div
      className={cn(
        "relative flex touch-none items-center select-none",
        isVertical ? "flex-col h-full w-auto" : "w-full",
        className
      )}
    >
      <div
        ref={trackRef}
        className={cn(
          ds.sliderTrack.track,
          "cursor-pointer overflow-hidden",
          isVertical ? "!h-full !w-slider-track" : "!h-slider-track !w-full"
        )}
        onPointerDown={handlePointerDown}
      >
        <div
          className={cn(
            ds.sliderTrack.fill,
            isVertical ? "!w-full !h-auto left-0 right-0 bottom-0" : "!h-full left-0"
          )}
          style={
            isVertical
              ? { height: `${fraction * 100}%` }
              : { width: `${fraction * 100}%` }
          }
        />
      </div>
    </div>
  )
}

export { Slider }
