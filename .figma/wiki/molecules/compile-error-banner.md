# Compile Error Banner

## Overview

| Field | Value |
|---|---|
| Figma ID | `954:2141` |
| Figma Page | Components (Molecules) |
| Type | COMPONENT_SET |
| Variants | 2 (State=Collapsed, State=Expanded) |
| React File | `src/components/CompileErrorBanner.tsx` |
| React Component | `CompileErrorBanner` |
| DS Key | `compileErrorBanner` |

The only surface where a compile or renderer failure becomes readable. It floats
over the live shader canvas in `PreviewPanel`, which is what justifies its
backdrop blur — see the glass rule in the `sombra-ds-component` skill.

## Why it exists in this shape

The previous banner clamped every message with `truncate`. Node-attributed errors
survived that, because a node's `⚠︎` carries the full text in its `title`. Renderer
rejections do not: they have no `nodeId`, attach to no node, and their text was
therefore reachable **nowhere** in the UI. So the collapsed state shows a count
rather than a fragment, and the full text is one click away.

Click, not hover — an error is read and copied, so it must not vanish when the
pointer leaves. The AMD warning pill uses hover because it is ambient status.

## Properties

### Dimensions

| Property | Figma | Code | Match |
|---|---|---|---|
| Collapsed | HUG × HUG (154×34) | `flex` + `p-md` | ✅ |
| Expanded width | 320px (FIXED) | `max-w-[min(70%,520px)]` | code-handled |
| Expanded height | HUG (70px) | auto | ✅ |

Expanded width diverges deliberately: Figma needs a concrete width to lay out its
sample message, while the live banner sizes to the panel and caps so it never eats
the canvas.

### Colors

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Surface fill | #1a1a2e @ 60% | surface/alt (`VariableID:106:4`) | `bg-surface-alt/60` | ✅ |
| Tint fill | #ef4444 @ 10% | color/error (`VariableID:364:2`) | `bg-error/10` | ✅ |
| Icon | #ef4444 | color/error (`VariableID:364:2`) | `text-error` | ✅ |
| Title | #ef4444 | color/error (`VariableID:364:2`) | `text-error` | ✅ |
| Count | #b8b8c8 | fg/dim (`VariableID:106:8`) | `text-fg-dim` | ✅ |
| Message | #b8b8c8 | fg/dim (`VariableID:106:8`) | `text-fg-dim` | ✅ |

Figma stacks the surface and tint as two fills on one node. A DS part carries one
fill, so the tint is a layered `<span>` in code — the same arrangement as the AMD
warning pill.

### Effects

| Property | Figma | Code | Match |
|---|---|---|---|
| Background blur | BACKGROUND_BLUR 16 | `backdrop-blur-[16px]` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Padding | 8px (spacing/md) | `p-md` | ✅ |
| Gap, collapsed | 8px (spacing/md) | `gap-md` | ✅ |
| Gap, expanded | 6px (spacing/sm) | `gap-sm` | ✅ |
| Header gap | 8px (spacing/md) | `gap-md` | ✅ |
| Radius | 8px (radius/md) | `rounded-md` | ✅ |
| Direction, collapsed | HORIZONTAL | `flex-row items-center` | ✅ |
| Direction, expanded | VERTICAL | `flex-col` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| Title | heading/section, UPPERCASE | `text-section uppercase` | ✅ |
| Count | label/param | `text-param` | ✅ |
| Message | label/param | `text-param` | ✅ |

## Behaviour (code-only)

| Behaviour | Implementation |
|---|---|
| Expand | Click or Enter/Space; `aria-expanded` reflects state |
| Cursor | `cursor-pointer` on both surfaces (DB `cursor` field, never audited) |
| Reset | Expansion clears whenever the message set changes, keyed on message content — the store returns a new array each compile, so array identity would re-fire every render |
| Message count | All errors render when expanded; the collapsed pill shows the count |

## Parity

`tokens:audit` green. No `auditIgnore` entries.

## Sandbox

`npm run sandbox` → Chrome → Compile Error Banner. Covers a renderer rejection,
a single node error, four at once, and none. Rendered over a moving backdrop
because glass over a flat panel is indistinguishable from no glass.
