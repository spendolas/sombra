# Separator

## Overview

| Field | Value |
|---|---|
| Figma ID | `37:132` |
| Figma Page | Atoms |
| Type | COMPONENT |
| Variants | none |
| React File | `src/components/ui/separator.tsx` |
| React Component | `<Separator />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=37:132) |

## Figma Screenshot

A thin 1px horizontal line in `edge/subtle` color. Spans full width of parent container.

## Properties

### Dimensions

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Height | 1px | (literal) | `h-px` (via `data-[orientation=horizontal]:h-px`) | ✅ |
| Width | FILL | — | `w-full` (via `data-[orientation=horizontal]:w-full`) | ✅ |

### Colors

| Property | Figma Hex | Figma Variable | CSS Variable | Tailwind | Match |
|---|---|---|---|---|---|
| Fill | `#2a2a3e` | edge/subtle (`17:17`) | `--edge-subtle` | — | ⚠️ |

### Notes on Color

The Figma separator uses `edge/subtle` (`#2a2a3e`). The shadcn `Separator` component uses `bg-border` which maps to `--border: oklch(1 0 0 / 10%)`. In the node card context (`ShaderNode.tsx`), the separator is rendered as `border-t border-edge-subtle` on a `<div>` rather than using the `<Separator>` component directly.

**In ShaderNode.tsx (line 259):**
```tsx
<div className="mt-1 pt-2 w-full border-t border-edge-subtle">
```
This matches the Figma `edge/subtle` color exactly.

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Corner radius | 0 | — | ✅ |

## Children

None (atom — indivisible)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `37:132`
- **React:** `<Separator className="my-2" />`
- **File:** `src/components/ui/separator.tsx`
- **Also used as:** `border-t border-edge-subtle` on `<div>` in ShaderNode.tsx

## Parity: ✅ Match

The visual appearance is identical — a 1px horizontal line in `edge/subtle` color. The implementation varies by context: `<Separator>` (shadcn) in PropertiesPanel, `border-t border-edge-subtle` in ShaderNode. Both produce the same 1px `#2a2a3e` line.
