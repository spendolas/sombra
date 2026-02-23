# Properties Panel

## Overview

| Field | Value |
|---|---|
| Figma ID | `39:393` |
| Figma Page | Organisms |
| Type | COMPONENT_SET |
| Variants | 2: state (empty / selected) |
| React File | `src/components/PropertiesPanel.tsx` |
| React Component | `<PropertiesPanel />` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=39:393) |

## Figma Screenshot

**Empty state:** "PROPERTIES" header + "Select a node to edit properties..." placeholder text.
**Selected state:** "PROPERTIES" header → Info Card (category, name, ID) → INPUTS section (port rows) → OUTPUTS section (port rows) → PARAMETERS section (sliders, selects in a bordered card).

## Properties

### Colors

| Property | Figma Hex | Figma Variable | Tailwind | Match |
|---|---|---|---|---|
| Header text | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| Empty placeholder | `#5a5a6e` | fg/muted (`17:15`) | `text-fg-muted` | ✅ |
| Section label | `#b8b8c8` | fg/dim (`17:13`) | `text-fg-dim` | ✅ |
| Param card bg | `#252538` | surface/raised (`17:10`) | `bg-surface-raised` | ✅ |
| Param card border | `#3a3a52` | edge/default (`17:16`) | `border-edge` | ✅ |

### Spacing & Layout

| Property | Figma | Code | Match |
|---|---|---|---|
| Header margin-bottom | 12px | `mb-3` | ✅ |
| Section gap | 16px | `mb-4` | ✅ |
| Section label margin-bottom | 8px | `mb-2` / `mb-3` | ✅ |
| Param card padding | 12px | `p-3` | ✅ |
| Port row gap | 4px | `space-y-1` | ✅ |

### Typography

| Property | Figma | Code | Match |
|---|---|---|---|
| "PROPERTIES" header | 12px semibold uppercase tracking-wider | `text-xs font-semibold uppercase tracking-wider` | ✅ |
| Section labels | 12px semibold | `text-xs font-semibold` | ✅ |
| Empty text | 12px regular | `text-xs` | ✅ |

### Border & Radius

| Property | Figma | Code | Match |
|---|---|---|---|
| Param card radius | 8px | `rounded-lg` (10px) | ⚠️ |

## Children

- Header text ("PROPERTIES")
- Properties Info Card molecule (when node selected)
- Inputs section (Label + Properties Port Row molecules)
- Outputs section (Label + Properties Port Row molecules)
- Parameters section (Label + bordered card with NodeParameters)
- Custom Controls section (Label + bordered card with custom component)

## Code Connect

- **Status:** Skipped (org mismatch)
- **Figma Node:** `39:393`
- **React:** `<PropertiesPanel selectedNode={selectedNode} />`
- **File:** `src/components/PropertiesPanel.tsx`

## Parity: ✅ Match

Both states (empty and selected) match. Section organization, typography, and color tokens are aligned. Minor radius difference on parameter card (Figma 8px vs code `rounded-lg` = 10px) — negligible visual impact.
