/**
 * ShaderPlaceholder — bouncing DVD-style "SOMBRA" text.
 * Shown when no valid shader is compiled. Changes color on each edge bounce.
 */

import { useRef, useEffect } from 'react'
import { useCompilerStore } from '@/stores/compilerStore'

export function ShaderPlaceholder() {
  const fragmentShader = useCompilerStore((s) => s.fragmentShader)
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (fragmentShader) return

    const container = containerRef.current
    const text = textRef.current
    if (!container || !text) return

    let x = Math.random() * 200
    let y = Math.random() * 100
    let vx = 2
    let vy = 1.5
    let hue = Math.random() * 360
    let raf: number

    const tick = () => {
      const cw = container.clientWidth
      const ch = container.clientHeight
      const tw = text.offsetWidth
      const th = text.offsetHeight

      x += vx
      y += vy

      let bounced = false
      if (x <= 0) { x = 0; vx = Math.abs(vx); bounced = true }
      if (x >= cw - tw) { x = cw - tw; vx = -Math.abs(vx); bounced = true }
      if (y <= 0) { y = 0; vy = Math.abs(vy); bounced = true }
      if (y >= ch - th) { y = ch - th; vy = -Math.abs(vy); bounced = true }

      if (bounced) {
        hue = (hue + 55 + Math.random() * 30) % 360
        text.style.color = `hsl(${hue} 60% 55% / 0.35)`
      }

      text.style.transform = `translate(${x}px, ${y}px)`
      raf = requestAnimationFrame(tick)
    }

    text.style.color = `hsl(${hue} 60% 55% / 0.35)`
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [fragmentShader])

  if (fragmentShader) return null

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-[3] bg-overlay-scrim overflow-hidden pointer-events-none"
    >
      <div
        ref={textRef}
        className="absolute top-0 left-0 text-2xl font-medium tracking-[0.35em] whitespace-nowrap select-none"
      >
        SOMBRA
      </div>
    </div>
  )
}
