import type { PreviewMode } from '@/stores/settingsStore'

export type PreviewBackground = { mode: 'checker' | 'solid' | 'none'; color: string }

/**
 * See-through ('none') is only meaningful in the floating (PiP) preview, where
 * "behind" the transparent canvas is the node graph. Docked/fullwindow sit over
 * app chrome, so see-through there just shows the dark app surface (≈ solid) — it
 * adds nothing and (on Chromium+AMD) would flicker for no benefit.
 */
export function seeThroughAvailable(previewMode: PreviewMode): boolean {
  return previewMode === 'floating'
}

/**
 * The background actually rendered. See-through falls back to checker wherever
 * it isn't available, WITHOUT mutating the stored setting — so switching back to
 * floating restores the user's see-through choice.
 */
export function effectiveBackground(bg: PreviewBackground, previewMode: PreviewMode): PreviewBackground {
  if (bg.mode === 'none' && !seeThroughAvailable(previewMode)) return { ...bg, mode: 'checker' }
  return bg
}
