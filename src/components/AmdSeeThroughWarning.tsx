/**
 * AMD-only warning shown next to the background-mode switcher while see-through
 * ('none') is active.
 *
 * On AMD GPUs a transparent canvas composited over the page flickers under
 * macOS/Chrome (see the preview-banding findings doc). checker/solid avoid it by
 * painting an opaque background into the canvas, but see-through must stay
 * transparent — so on AMD it flickers, which is informed + accepted. This flags
 * that: expanded on the first see-through activation per session (auto-collapsing
 * after a timeout), then collapsed to just the icon; hover re-expands, mouse-out
 * collapses.
 *
 * Glass pill mirrors the Figma design (color/warning #fbbf24): surface-alt/80 +
 * a warning/10 wash, backdrop-blur, triangle-alert icon + label.
 */

import { useEffect, useRef, useState } from 'react'
import { icons } from '@/components/icons'
import { useRendererStore } from '@/stores/rendererStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

const TriangleAlert = icons.triangleAlert

/** Chromium-based browser (Chrome/Edge/Brave/…). The see-through flicker is a
 *  Chromium + AMD/Metal compositor bug — Safari and Firefox composite the
 *  transparent canvas cleanly, so the warning would be a false positive there. */
const IS_CHROMIUM = (() => {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as unknown as { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData
  if (uaData?.brands?.length) return uaData.brands.some((b) => /Chromium|Chrome|Edge/i.test(b.brand))
  return /\bChrome\//.test(navigator.userAgent)
})()

/** Expanded once per session (page load); collapsed on later activations. */
let shownExpandedThisSession = false
const AUTO_COLLAPSE_MS = 4500

export function AmdSeeThroughWarning() {
  const isAmd = useRendererStore((s) => s.isAmd)
  const mode = useSettingsStore((s) => s.previewBackground.mode)
  // Gated to Chromium: the flicker is a Chromium+AMD/Metal compositor bug only.
  const active = isAmd && IS_CHROMIUM && mode === 'none'

  const [expanded, setExpanded] = useState(false)
  const collapseTimer = useRef<number | null>(null)

  const clearTimer = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current)
      collapseTimer.current = null
    }
  }

  // On see-through activation: expand once per session (with an auto-collapse),
  // else start collapsed. Deactivating clears everything.
  useEffect(() => {
    if (!active) {
      clearTimer()
      setExpanded(false)
      return
    }
    if (!shownExpandedThisSession) {
      shownExpandedThisSession = true
      setExpanded(true)
      clearTimer()
      collapseTimer.current = window.setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS)
    }
    return clearTimer
  }, [active])

  if (!active) return null

  return (
    <div
      role="status"
      onMouseEnter={() => { clearTimer(); setExpanded(true) }}
      onMouseLeave={() => setExpanded(false)}
      title="See-through can flicker on this GPU (AMD)"
      className={cn(
        'nodrag relative isolate flex items-center overflow-hidden select-none',
        'rounded-md p-md text-warning bg-surface-alt/60 backdrop-blur-lg',
      )}
    >
      {/* Amber wash — the second Figma fill (color/warning @ 10%) over surface-alt/80. */}
      <span aria-hidden className="absolute inset-0 rounded-[inherit] bg-warning/10 pointer-events-none" />
      <TriangleAlert className="relative shrink-0 size-icon-sm" />
      <span
        className={cn(
          'relative overflow-hidden whitespace-nowrap text-param transition-all duration-200 ease-out',
          expanded ? 'ml-md max-w-[12rem] opacity-100' : 'ml-0 max-w-0 opacity-0',
        )}
      >
        Unstable on this hardware
      </span>
    </div>
  )
}
