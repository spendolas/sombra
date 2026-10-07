# Stack Layer (+ Stack Empty, Stack Drop Slot)

## Overview

| Field | Value |
|---|---|
| Figma ID | `982:5693` (Stack Layer), `982:5702` (Stack Empty), `982:5703` (Stack Drop Slot) |
| Figma Page | Components (Molecules, Row 7 · Stack) |
| Type | COMPONENT_SET ×2 + COMPONENT |
| Variants | Stack Layer: State = rest / hover / dragging / hidden × Bottom = false / true (8). Stack Empty: State = rest / hover (2) |
| React File | `src/components/StackLayerList.tsx` |
| React Component | `StackLayerList` |
| DS Keys | `stackLayer`, `stackEmpty`, `stackDropSlot` |
| Sandbox | `sandbox.html?c=stack-layer-list` |

The layer list inside the Stack compositing node's body. Designed in Figma first,
board by board, on the Components page beside the components: full node, drag
states, hidden layer, single layer, delete and empty.

## Anatomy

A layer is four lines, each beside the control it drives:

1. **Layer** — source handle (the layer's image input), grip, name, `← Source.output`,
   remove (on hover) and visibility.
2. **Blend mode** — a fixed choice, so no handle.
3. **Opacity** — the same slider / `← source` pair every connectable parameter uses.
4. **Mask** — a port, labelled like any input port.

Top of the list is the topmost layer. The list header ("Layers" + add) sits above
the cards, so new layers land next to the button that made them.

## Rules the design settled

| Rule | Why |
|---|---|
| Blend greys when nothing **visible** sits below the layer | A blend against full transparency is mathematically identical to Normal — a live dropdown would offer 24 options that do the same thing |
| Hidden layer: card sinks (black 10%), colour drains, content dims to 50% — handles and eye stay full strength | Still editable and still wireable; the switch to bring it back must stay easy to find |
| Names are stored, assigned at creation, never shift | Dragging Layer 1 to the top must not rename it |
| Removing the last layer is allowed | An empty Stack outputs transparent; the empty hole is itself the add button |
| No red, no glow | Destructive and drag states use the standard button hover and the card tint, as everything else in Sombra does |

## Geometry (matches every node, measured in the running app)

| Property | Value |
|---|---|
| Handle centre | 12px from the node edge (content edge) |
| Text / control column | 22px → 196px |
| Card | 18px (where the handle ends) → 200px; `rounded-md` |
| Rows inside a layer | 8px apart, 8px top/bottom |
| Divider above the list | 12px above, 8px below |

Figma draws handles in-flow (row at 6, 12px handle, 4px pad); code centres them
absolutely on the content edge (row at 12, `pl-handle-offset`). Same pixels,
different arithmetic — the `lineContent`, `header` and `grip` parts carry the code
side and have no Figma node.

## Colours

| Part | Figma | Code |
|---|---|---|
| `card` | white @ 4% | `bg-white/4` |
| `cardHover` | white @ 8% | `bg-white/8` |
| `cardDragging` | surface/elevated + white @ 8% | `bg-surface-elevated` under `bg-white/8` |
| `cardHidden` | overlay/scrim @ 10% | `bg-overlay-scrim/10` |
| `stackDropSlot.slot` | surface/alt | `bg-surface-alt` |
| `stackEmpty.root` / hover | surface/alt → surface/raised | `bg-surface-alt` → `bg-surface-raised` |
| `name` / `source` | fg / fg-muted | `text-handle text-fg` / `text-param text-fg-muted` |

## Reused, not rebuilt

Handle, Icon Button (ghost — eye, eye-off, minus, plus), Select (blend), Float
Slider (opacity), the connected-parameter header, Labeled Handle styles (mask),
Category Header (list title). Icons added for this: `eyeOff`, `gripVertical`.

## Audit

`tokens:audit` clean. Ignores (reasons in `.claude/ds-queue.md`): card width/height
(absolutely inset in code), `blendDisabled` / `dimmed` layout (opacity-only parts
applied to existing components).
