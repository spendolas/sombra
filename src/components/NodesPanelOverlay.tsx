/**
 * NodesPanelOverlay — the top-left editor cluster: a Nodes toggle pill (its own
 * group) left of the main actions pill (GraphToolbar), plus the floaty Nodes
 * card that hangs below when open. Rendered as a full-bleed overlay child of the
 * ReactFlow container (pointer-events-none), so it's anchored to the CANVAS
 * region — when the preview docks left, the whole cluster follows to its right.
 *
 * Open state is persisted in settingsStore (default off). fitView call sites use
 * getFitViewPadding() so framing/zooming excludes the region this card occupies.
 */

import { IconButton } from '@/components/IconButton'
import { NodePalette } from '@/components/NodePalette'
import { GraphToolbar } from '@/components/GraphToolbar'
import { useSettingsStore } from '@/stores/settingsStore'
import { NODES_CARD_WIDTH, NODES_PANEL_MARGIN, ZOOM_BAR_CLEARANCE } from '@/components/nodes-panel-layout'
import { ds } from '@/generated/ds'
import { cn } from '@/lib/utils'

/** The floaty card — real NodePalette in a rounded, shadowed, height-capped shell. */
function NodesCard() {
  return (
    <div
      className="max-h-full bg-surface-alt rounded-xl border border-edge-card shadow-2xl overflow-hidden flex flex-col"
      style={{ width: NODES_CARD_WIDTH }}
    >
      <div className="shrink-0 flex items-center px-xl pt-lg pb-sm">
        <span className="text-category text-fg-subtle uppercase tracking-wider">Nodes</span>
      </div>
      <div className="overflow-y-auto min-h-0">
        <NodePalette />
      </div>
    </div>
  )
}

export function NodesPanelOverlay() {
  const open = useSettingsStore((s) => s.nodesPanelOpen)
  const toggle = useSettingsStore((s) => s.toggleNodesPanel)

  return (
    <div
      className="absolute inset-0 flex flex-col gap-md items-start z-10 pointer-events-none"
      style={{ padding: NODES_PANEL_MARGIN, paddingBottom: ZOOM_BAR_CLEARANCE }}
    >
      {/* Cluster row: toggle group (left) + actions group */}
      <div className={cn(ds.previewToolbar.wrapper, 'pointer-events-auto')}>
        <div className={ds.previewToolbar.root}>
          <IconButton
            icon="squareMousePointer"
            title="Toggle nodes panel"
            className={open ? ds.button.ghostActive : ds.button.ghost}
            onClick={toggle}
          />
        </div>
        <GraphToolbar />
      </div>

      {/* Floaty Nodes card — pinned open, canvas shows around/under it */}
      {open && (
        <div className="pointer-events-auto min-h-0 flex">
          <NodesCard />
        </div>
      )}
    </div>
  )
}
