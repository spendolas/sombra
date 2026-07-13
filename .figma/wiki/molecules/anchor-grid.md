# Anchor Grid

## Overview

| Field | Value |
|---|---|
| Figma ID | `717:15` |
| Figma Page | Components → Molecules → Row 2 |
| Type | COMPONENT |
| Variants | none (cells are instances of `Anchor Cell` `717:14`, State=default/active) |
| React File | `src/components/NodeParameters.tsx` |
| React Component | `AnchorGrid` (not exported, used internally) |
| DS key | `ds.anchorGrid` (`tokens/sombra.ds.json` → `717:15`) |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=717:15) |

## Purpose

3×3 pin-position toggle grid replacing the dropdown for anchor-style enum
params (Fragment Output → Anchor). Activated per-param via
`NodeParameter.control: 'anchor-grid'` — requires exactly 9 options in
row-major order (`tl tc tr / cl center cr / bl bc br`).

## Figma Screenshot

"Anchor" label above a bordered 3×3 grid of dot cells; the active cell is an
indigo square with a bright dot, inactive cells show muted dots.

## Properties

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Label text | `#88889a` | fg/subtle (`106:9`) | `text-fg-subtle` | ✅ |
| Grid bg | `#252538` | surface/raised (`106:5`) | `bg-surface-raised` | ✅ |
| Grid border | `#3a3a52` | edge/default (`106:11`) | `border-edge` | ✅ |
| Cell active bg | `#6366f1` | indigo/default (`106:13`) | `bg-indigo` | ✅ |
| Cell hover bg | — (code-only state) | interactive/highlight (`576:987`) | `hover:bg-highlight` | ✅ |
| Cell active hover | — (code-only state) | indigo/hover (`106:14`) | `hover:bg-indigo-hover` | ✅ |
| Dot (inactive) | `#5a5a6e` | fg/muted (`106:10`) | `bg-fg-muted` | ✅ |
| Dot (active) | `#e8e8f0` | fg/default (`106:7`) | `bg-fg` | ✅ |

### Dimensions & Spacing

| Property | Figma | Figma Variable | Code | Match |
|---|---|---|---|---|
| Cell size | 20×20 | size/icon-md (`106:41`) | `w-icon-md h-icon-md` | ✅ |
| Cell radius | 2px | radius/xs (`336:7`) | `rounded-xs` | ✅ |
| Grid gap + padding | 2px | spacing/2xs (`216:1079`) | `gap-2xs p-2xs` | ✅ |
| Grid radius | 4px | radius/sm (`106:34`) | `rounded-sm` | ✅ |
| Root gap (label↔grid) | 6px | spacing/sm (`106:28`) | `gap-sm` | ✅ |
| Dot size | 6×6 | — (raw, via `extra`) | `size-1.5` | ✅ |
| Label text style | 10px/1.5 | label/param style | `text-param` | ✅ |

## Structural notes

- Figma uses 3 horizontal-auto-layout rows (`Row 1..3`) of `Anchor Cell`
  instances; code uses CSS `grid grid-cols-3` with 9 buttons — visually
  identical, structurally different by design.
- Hover states exist only in code (DB `hover` fields); Figma has no hover
  variant on `Anchor Cell` — add one if interaction specs are needed.
- Accessibility: cells are `<button aria-pressed>` with the option arrow
  glyph as `title`.
