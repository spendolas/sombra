import { useSettingsStore } from '@/stores/settingsStore'

// Runtime-dynamic backdrop values (checker tile + user-picked solid color) —
// documented CLAUDE.md exception to the "no inline style" rule. Colors come
// from DS custom properties (no raw hex) so the checker stays on-theme.
const checkerStyle = {
  backgroundColor: 'var(--surface-elevated)',
  backgroundImage:
    'linear-gradient(45deg, var(--fg-muted) 25%, transparent 0), linear-gradient(-45deg, var(--fg-muted) 25%, transparent 0), linear-gradient(45deg, transparent 75%, var(--fg-muted) 0), linear-gradient(-45deg, transparent 75%, var(--fg-muted) 0)',
  backgroundSize: '20px 20px',
  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0',
}

/**
 * Transparency backdrop shown behind the preview canvas in every preview host
 * (docked `PreviewPanel`, `FloatingPreview`, `FullWindowOverlay`). Reads
 * `previewBackground` from settingsStore and renders nothing in 'none' mode.
 *
 * The host's canvas div is a plain (non-positioned) element, so an absolutely
 * positioned sibling with z-index >= 0 would paint ABOVE it per CSS stacking
 * rules — `-z-10` is required to keep the backdrop behind the canvas while
 * still painting above the host container's own background. Callers must
 * render this inside a positioned (e.g. `relative`) container for `inset-0`
 * to resolve against the right box.
 */
export function PreviewBackdrop() {
  const previewBackground = useSettingsStore((s) => s.previewBackground)

  if (previewBackground.mode === 'none') return null

  return (
    <div
      aria-hidden
      className="absolute inset-0 -z-10 pointer-events-none"
      style={previewBackground.mode === 'checker' ? checkerStyle : { background: previewBackground.color }}
    />
  )
}
