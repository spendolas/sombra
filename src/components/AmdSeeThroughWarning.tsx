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
 * Glass pill comes from the DS (`ds.amdWarning.*`, Figma set 884:355): surface-alt
 * at 60% + a warning/10 wash + backdrop blur. The blur is justified here because
 * the pill floats over the live shader canvas; in-node chrome should not pay for
 * one. Only structure, the collapse animation and the wash's geometry stay inline.
 */

import { useEffect, useRef, useState } from 'react'
import { icons } from '@/components/icons'
import { useRendererStore } from '@/stores/rendererStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { seeThroughAvailable } from '@/utils/preview-background'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

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
  const previewMode = useSettingsStore((s) => s.previewMode)
  // Only when see-through is actually rendering (floating) on Chromium+AMD — the
  // one place a transparent canvas is composited over the page and flickers.
  const active = isAmd && IS_CHROMIUM && mode === 'none' && seeThroughAvailable(previewMode)

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
      className={cn(ds.amdWarning.pill, 'nodrag relative isolate overflow-hidden select-none')}
    >
      {/* Amber wash — Figma models it as the pill's second fill; a DS part carries one
          fill, so it is a layered span here. */}
      <span aria-hidden className={cn(ds.amdWarning.tint)} />
      <TriangleAlert className={cn(ds.amdWarning.icon, 'relative shrink-0 size-icon-sm')} />
      {/* The label's margin animates rather than the pill's gap: Figma collapses by
          hiding the child (auto-layout then drops the gap), which CSS cannot do while
          also transitioning. Hence `gap` is auditIgnore'd on the pill. */}
      <span
        className={cn(
          ds.amdWarning.label,
          'relative overflow-hidden whitespace-nowrap transition-all duration-200 ease-out',
          expanded ? 'ml-md max-w-[12rem] opacity-100' : 'ml-0 max-w-0 opacity-0',
        )}
      >
        Unstable on this hardware
      </span>
    </div>
  )
}
