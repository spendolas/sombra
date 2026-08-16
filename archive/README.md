# Archive

Retired code, kept for reference. Nothing here is compiled or linted —
`tsconfig` `include` is `["src"]`, so this directory is outside the build. Imports
inside these files may be stale; that's expected.

## PropertiesPanel.tsx

Retired **2026-08-16** (branch `feat/nodes-panel-floaty`). The right-hand
Properties panel was fully redundant: every affordance it exposed — node params,
`definition.component`, and `BackgroundModeControl` — already renders inline on
each node in `ShaderNode.tsx`. The editor now has no side columns; the Nodes
palette is a floaty overlay (`src/components/NodesPanelOverlay.tsx`).

To restore: move back to `src/components/PropertiesPanel.tsx`, re-add the right
`ResizablePanel` in `src/App.tsx`, and re-add the `selectedNode` memo there. The
`ds.propertiesPanel` DS tokens were left in place, so styling still resolves.

Design: `docs/research/2026-08-16-nodes-panel-floaty-design.md`.
