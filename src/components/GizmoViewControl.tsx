/**
 * GizmoViewControl — the global coords-view switch for the SRT gizmo, its own
 * toolbar group sitting LEFT of the background (alpha) modes in every preview
 * container. Tri-state via two icons:
 *   - both deselected → gizmo off
 *   - one selected → gizmo on, axes (and the nodes' offset-slider display)
 *     interpreted in that frame — World (globe) or Node (box)
 * Clicking the active icon deselects it (off); clicking the other switches
 * frames (segmented behaviour). View only — never touches stored params
 * (ONE STORAGE, see ir/srt.ts).
 */

import { IconButton } from '@/components/IconButton'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

export function GizmoViewControl({ className }: { className?: string }) {
  const gizmoView = useSettingsStore((s) => s.gizmoView)
  const setGizmoView = useSettingsStore((s) => s.setGizmoView)

  const active = cn(ds.button.ghostActive, 'cursor-pointer')
  const inactive = ds.button.ghost

  const pick = (view: 'world' | 'node') => () => setGizmoView(gizmoView === view ? 'off' : view)

  return (
    <div className={cn(ds.previewToolbar.root, 'nodrag nowheel', className)}>
      <IconButton
        icon="globe"
        title="Gizmo: world coords (click again to hide)"
        className={gizmoView === 'world' ? active : inactive}
        onClick={pick('world')}
      />
      <IconButton
        icon="box"
        title="Gizmo: node coords (click again to hide)"
        className={gizmoView === 'node' ? active : inactive}
        onClick={pick('node')}
      />
    </div>
  )
}
