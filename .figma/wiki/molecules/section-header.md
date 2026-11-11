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

## Plug-in plan (not done — owner reviews the sandbox first)

How `ShaderNode.tsx` (Transform section, today ~lines 562–640) will use it:

1. **Swap the header.** Replace the inline `<button>` (with its inline `style`)
   by `<SectionHeader label="Transform" open={transformOpen} onToggle={setTransformOpen} …/>`.
   `wiredParams` = the connectable SRT params in `connectedInputs`, each with its
   source label built the way the body params already build `sourceLabel`.
2. **Keep the wired handles mounted.** Today the rows (and their handles) unmount
   when closed, which is the bug. While closed, render one `BaseHandle` per WIRED
   SRT param inside `renderGatherHandle`, all stacked at the gather point, each
   with `id={param.id}` (handle ids must stay equal to the param ids or saved
   edges drop). While open, the rows render those same ids, so exactly one handle
   per id is mounted at any time. Unwired params need no handle while closed.
   The stacked handles should be `isConnectableEnd={false}` (one dot cannot say
   which param a new wire means — the open-on-drag path handles new wires).
3. **Re-measure.** Call `updateNodeInternals(id)` whenever the handle layout
   changes — open/closed and the set of wired SRT params — the same pattern as
   `StackNodeBody.tsx` (a `useEffect` keyed on a string of the layout). Without
   it React Flow keeps the old handle bounds and the wires point at nothing.
4. **Open on drag.** Feed `connecting` from React Flow's `useConnection()`
   (`inProgress`). A mouse drag does not capture the pointer (v12 listens on the
   document), so `pointerenter` on the header works. Touch (and pen, where the
   platform captures implicitly) does not see `pointerenter`: hit-test the drag
   position against the header element and pass `dropActive` instead.
5. **Wire hover.** Pass `popoverOpen` while the pointer is on one of the gathered
   edges, and thicken those edges while `onGatherHoverChange(true)` — both need
   edge hover state the node does not have today; can ship after 1–4.
6. **Clicking the dot.** The component opens the section on a dot click. Check
   that React Flow's `connectOnClick` (default true) does not also start a
   click-connection from the stacked target handles; if it does, stop
   propagation in the slot or disable click-connect on those handles.
7. **Popover stacking.** The popover hangs below the node's bottom edge (as on
   the board). The node card does not clip it, but a node rendered later can
   cover it; raise the hovered node's z-index if that shows up in the app.
8. **Persisting the collapse state** (per node, in the graph, or not at all — it
   is component state today and resets on reload): **left to the owner.**

Run `npm run verify:section-header-ui` after any change to the component.
