# Section Header

## Overview

| Field | Value |
|---|---|
| Figma ID | `993:3777` (component set). Board: `994:4107` "Transform — collapsed wires" |
| Figma Page | Components |
| Type | COMPONENT_SET |
| Variants | State = open / collapsed / hover (3). Properties: Label (text), Count (text), Show count (bool), Gathered wires (bool) |
| React File | `src/components/SectionHeader.tsx` |
| React Component | `SectionHeader` |
| DS Key | `sectionHeader` |
| Sandbox | `sandbox.html?c=section-header` |
| Gate | `npm run verify:section-header-ui` (headless Chrome, no GPU) |

The header of a collapsible section in a node body: today, the framework
Transform section that every spatial node carries. It fixes a real bug: closing
Transform unmounted the param rows and their handles, so any wire into Scale /
Rotate / Offset vanished from the canvas while still driving the shader.

Designed on the board, Option A (wires gather at the header) and drop behaviour 1
(open on drag). Option B and "Refused" were not chosen.

## Behaviour the design settled

| State | What shows |
|---|---|
| A1 · collapsed, nothing wired | Chevron (pointing right) + label. No dot, no count — same as today |
| A2 · collapsed, N wired | One gathered dot on the header's handle column, port colour, every hidden wire ends on it. Label reads `TRANSFORM · N` |
| A3 · pointer on the dot (or on a gathered wire) | Header takes its hover look, wires thicken, a popover lists `→ Param   from Source` per wire and "Click to open Transform". Clicking the header **or the dot** opens the section |
| A4 · open | Dot and count go away; each wire returns to its own row |
| 1A · wire dragged over a collapsed header | Header lights up as a drop target (`interactive/highlight`, radius sm). After ~400 ms the section opens under the pointer |
| 1B · then | The user drops on the exact row. The section stays open after the drop |

An open header is never a drop target — its rows are.

## Anatomy

| Part | Figma node | Code |
|---|---|---|
| `root` | `993:3750` (State=open) | `relative flex items-center pr-xs` |
| `rootDropTarget` | `994:4600` (1A instance, fill override) | `root` + `bg-highlight rounded-sm` |
| `toggle` | `993:3754` (content frame) | the `<button>`: chevron + label + count, `pl-handle-offset py-2xs gap-2xs` |
| `chevron` / `chevronHover` / `chevronCollapsed` | code only | `icons.chevronDown` at `icon-sm`, fg-subtle → fg-dim; collapsed = `-rotate-90` (Figma rotates the instance 90°) |
| `label` / `labelHover` | `993:3757` / `993:3775` | `text-category` fg-subtle / fg-dim |
| `count` | `993:3758` | `text-category` fg-dim, `· N` |
| `gather` | `993:3751` (handle column) | 12px box centred on the content edge: `absolute left-0 top-1/2 -translate-1/2` |
| `popover` | `994:4963` | surface/raised, edge border, radius md, `px-md py-sm gap-xs`, shadow `0 8 24 rgba(0,0,0,.5)` |
| `popoverRow` / `popoverParam` / `popoverSource` / `popoverHint` | `994:4964` / `4965` / `4966` / `4970` | gap md; body fg; param fg-muted; param fg-subtle |

Geometry follows the Stack Layer convention: Figma draws the handle in-flow
(header at 6, 12px column, 4px pad → chevron at 22); code centres the handle on
the content edge (header at 12, `pl-handle-offset` → chevron at 22). Same pixels,
different arithmetic. The popover sits 6px below the header and 14px in from its
left edge (`left-handle-offset ml-xs mt-sm`), as on the board.

## Props

| Prop | Meaning |
|---|---|
| `label`, `open`, `onToggle(next)` | Title, state, requested next state (header click, dot click, or drag dwell) |
| `wiredParams: {label, source}[]` | Wired params inside the section. Its length is the count and decides the dot |
| `connecting` | A wire drag is in progress; the pointer entering the header then counts as drag-over |
| `dropActive` | Controlled drag-over, overrides pointer detection (for touch/pen drags, which capture the pointer, and for fixtures) |
| `openDelay` | Dwell before drag-over opens, default 400 ms |
| `popoverOpen` | Controlled popover; undefined = dot hover / keyboard focus |
| `onGatherHoverChange(h)` | Pointer entered/left the dot — the node thickens its wires |
| `renderGatherHandle({count})` | Slot for the gathered handle(s); rendered only while collapsed with ≥1 wire |
| `controlsId` | id of the section body, for `aria-controls` |

Accessibility: the toggle is a `<button aria-expanded>`; the popover is
`role="tooltip"`, linked with `aria-describedby`, and also appears on keyboard
(`:focus-visible`) focus — not on a mouse click. Transitions are off under
`prefers-reduced-motion: reduce`.

## Audit

`tokens:audit` clean. Four ignores, all "same result, unrepresentable in Figma":

- `toggle` → `padding.left` (`993:3754`): Figma 4 after an in-flow 12px handle column; code `handle-offset` from the content edge. Same pixel position.
- `rootDropTarget` → `fill.opacity` (`994:4600`): the `interactive/highlight` variable already carries 15% alpha, which Figma reports as paint opacity. Adding `fillOpacity: 15` would double-apply it (`bg-highlight/15` = 2.25%).
- `rootDropTarget` → `height` (`994:4600`): an instance of the 20px variant; code height comes from the content (16px chevron + 2×2px).
- `count` → `width`, `height` (`993:3758`): the Figma text box is FIXED 13×15 (auto-resize off); code sizes to the text. Fixing auto-resize in Figma would remove this ignore.

## Plug-in — done (branch feat/wire-node-sections)

Wired into the live editor by `src/components/TransformSection.tsx`, which
`ShaderNode.tsx` renders for every node with visible SRT params. The component
itself is unchanged. What was built, against the plan above:

1. **Header swapped.** `<SectionHeader label="Transform" …>` replaces the inline
   button. `wiredParams` = visible connectable SRT params that have an edge; the
   source reads `<source node type label>.<output>` (the lookup the connected body
   rows use, plus the output id), e.g. `Scale  from Number.value`.
2. **Wired handles stay mounted.** While collapsed, one `BaseHandle` per wired
   param sits in `renderGatherHandle`, `id = param id`, port colour, all stacked
   on the dot (`style.left = 50%` centres React Flow's left handle on the 12px
   gather box). Exactly one handle per id is mounted at any time. They are
   `isConnectableStart={false}` and `isConnectableEnd={false}`.
3. **Re-measure.** `updateNodeInternals(nodeId)` in an effect keyed on the string
   `open|wiredIds` (value, not identity).
4. **Open on drag.** `connecting` = `useConnection(c => c.inProgress)`; `dropActive`
   = a boolean `useConnection` selector that hit-tests the drag against the header
   rect, so the node re-renders only when the drag enters/leaves. It uses
   `connection.pointer`, which is **px relative to the `.react-flow` container**,
   not flow units, and never snapped (`connection.to` snaps to a nearby valid
   handle and is converted by the hook). Mouse and touch both verified.
5. **Wire hover — NOT built.** No popover on hovering a gathered edge and no wire
   thickening on dot hover (`onGatherHoverChange` is unused); the node has no edge
   hover state. The dot-hover popover works.
6. **Dot click.** Opens the section; with `isConnectableStart={false}` React Flow's
   click-connect does not start from the stacked handles (gate check; perturbed:
   with it on, a following click on an output created an edge).
7. **Popover stacking.** Hangs below the node as on the board; not checked against
   a node placed directly underneath.
8. **Persistence (owner decision: remembered).** `node.data.ui.collapsed.transform`,
   stored only when it differs from the default (collapsed). Saved in localStorage
   and `.sombra`; not in the share hash, manifest or artifact; no history entry
   (`graphStore.setSectionCollapsed`), and undo/redo carry the live value over.

Gates: `npm run verify:node-sections` (offline, in `verify:ci`) and
`npm run verify:node-sections-ui` (live editor, headless Chrome, real mouse and
CDP touch). Still run `npm run verify:section-header-ui` after any change to the
component.
