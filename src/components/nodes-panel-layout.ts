/**
 * Geometry for the floaty Nodes panel overlay, shared by the overlay component
 * and every fitView call site so the card and the focus-exclusion padding can
 * never drift apart.
 */

import type { FitViewOptions } from '@xyflow/react'

/** Width of the floaty card (matches NodesPanelOverlay). */
export const NODES_CARD_WIDTH = 212
/** Inset of the top-left cluster from the canvas corner (React Flow Panel margin). */
export const NODES_PANEL_MARGIN = 16
/** Bottom space the card must leave clear so it never overlaps the bottom-left
 *  ZoomSlider pill (its ~48px height + Panel margin + a gap). */
export const ZOOM_BAR_CLEARANCE = 88

// Left padding that keeps framed content clear of the open card: inset + card + a gap.
const OPEN_LEFT = NODES_PANEL_MARGIN + NODES_CARD_WIDTH + 32

/**
 * Padding for fitView. When the panel is open, exclude the region it occupies
 * (per-side px padding is native in React Flow v12) so framing/zooming never
 * tucks nodes under the card. Closed → the normal 20% breathing room.
 */
export function getFitViewPadding(nodesPanelOpen: boolean): FitViewOptions['padding'] {
  if (!nodesPanelOpen) return 0.2
  return { left: `${OPEN_LEFT}px`, top: '64px', right: '48px', bottom: '48px' }
}
