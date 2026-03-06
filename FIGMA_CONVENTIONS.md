# Figma Variants to React Props Convention Document

## Overview

This document maps Figma COMPONENT_SET variant properties to their React component prop equivalents in the Sombra codebase. It captures the current state of each mapping, identifies naming mismatches, and establishes conventions for future alignment.

Audit date: 2026-03-06

---

## Naming Rules (Derived from Existing Patterns)

### Variant Property Names

| Convention | Figma Pattern | React Pattern | Notes |
|---|---|---|---|
| Casing | **PascalCase** (`State`, `Position`, `Style`, `Content`, `Selected`) | **camelCase** (`connected`, `disabled`, `previewMode`) | Systematic mismatch: Figma uses PascalCase for all variant axes |
| Boolean props | String enum `"true"` / `"false"` (e.g., `Selected=true`) | Native `boolean` (e.g., `connected?: boolean`) | Figma variant booleans are always string-typed |
| State encoding | Single `State` axis with all states (`enabled`, `disabled`, `active`, `hover`) | Decomposed into separate props (`disabled?: boolean`) + CSS pseudo-classes (`:hover`) | Figma flattens interactive states into one axis; React separates concerns |
| Connected/Wired | `State=connected` / `State=disconnected` (Handle), `State=wired` / `State=unwired` (Connectable Param Row) | `connected?: boolean` (Handle, LabeledHandle), `isConnected` local variable (ShaderNode) | Terms align but encoding differs |

### Value String Rules

| Figma Value | React Equivalent | Pattern |
|---|---|---|
| `"enabled"` | default state (no prop) | Enabled is implicit in React |
| `"disabled"` | `disabled={true}` (HTML attribute) | Native HTML disabled |
| `"hover"` | CSS `:hover` pseudo-class | Handled by `hover:` Tailwind utilities |
| `"active"` | Explicit class swap (`ds.button.ghostActive`) | Active is a visual state, not a pseudo-class |
| `"true"` / `"false"` | `boolean` prop | Direct mapping |

### DS Class Mapping Convention

Figma variant combinations map to flat keys in `ds.ts`. The naming pattern is:

```
ds.<component>.<style><State>
```

Examples:
- `Content=icon, Style=ghost, State=enabled` maps to `ds.button.ghost`
- `Content=icon, Style=ghost, State=active` maps to `ds.button.ghostActive`
- `Content=icon, Style=solid, State=disabled` maps to `ds.button.solidDisabled`
- `Content=text, Style=ghost, State=enabled` maps to `ds.button.textGhost`

---

## Component Audit Table

### 1. Handle

| | Figma | React |
|---|---|---|
| **Component** | `Handle` (COMPONENT_SET `106:84`) | `BaseHandle` (`base-handle.tsx`) |
| **Variant count** | 2 | N/A (prop-driven) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `State` | `disconnected`, `connected` | `connected` | `boolean \| undefined` | **Partial** — Figma uses PascalCase axis name `State` with string values; React uses `connected?: boolean`. Semantics align (`connected=true` equals `State=connected`). |

**Visual mapping:** When `connected` is true, the handle fill is set to `handleColor`; when false, fill is `var(--surface-elevated)`. This matches Figma's filled/hollow handle variants.

---

### 2. Button

| | Figma | React |
|---|---|---|
| **Component** | `Button` (COMPONENT_SET `106:108`) | `IconButton` (`IconButton.tsx`) |
| **Variant count** | 12 | N/A (class-driven) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `Content` | `icon`, `text` | `icon` / `label` | discriminated union: `{ icon: IconName }` or `{ label: string }` | **Mismatch** — Figma uses a single `Content` axis with `icon`/`text`; React uses a discriminated union where presence of `icon` vs `label` determines content type. |
| `Style` | `solid`, `ghost` | `className` | `string` (via `ds.button.*`) | **Indirect** — No explicit `style` prop. Style is applied via `className` using `ds.button.solid`, `ds.button.ghost`, `ds.button.textGhost`. |
| `State` | `enabled`, `disabled`, `active`, `hover` | `disabled` + `className` | `boolean` + DS class | **Decomposed** — `disabled` maps to `State=disabled`. `active` is applied by the parent via `ds.button.ghostActive` / `ds.button.solidActive`. `hover` is a CSS pseudo-class (`hover:` in Tailwind). `enabled` is the implicit default. |
| `Icon#307:0` | Instance swap | `icon` | `IconName` | **Matched** — Both select which icon to display. |

**Figma variant matrix (12 variants):**

| Content | Style | State |
|---|---|---|
| icon | solid | enabled, disabled, active, hover |
| icon | ghost | enabled, disabled, active, hover |
| text | ghost | enabled, disabled, active, hover |

Note: `Content=text, Style=solid` variants do not exist in Figma.

**DS key mapping:**

| Figma Variant Combination | DS Key |
|---|---|
| `Content=icon, Style=solid, State=enabled` | `ds.button.solid` |
| `Content=icon, Style=solid, State=disabled` | `ds.button.solidDisabled` |
| `Content=icon, Style=solid, State=active` | `ds.button.solidActive` |
| `Content=icon, Style=solid, State=hover` | `ds.button.solidHover` |
| `Content=icon, Style=ghost, State=enabled` | `ds.button.ghost` |
| `Content=icon, Style=ghost, State=disabled` | `ds.button.ghostDisabled` |
| `Content=icon, Style=ghost, State=active` | `ds.button.ghostActive` |
| `Content=icon, Style=ghost, State=hover` | `ds.button.ghostHover` |
| `Content=text, Style=ghost, State=enabled` | `ds.button.textGhost` |
| `Content=text, Style=ghost, State=disabled` | `ds.button.textGhostDisabled` |
| `Content=text, Style=ghost, State=active` | `ds.button.textGhostActive` |
| `Content=text, Style=ghost, State=hover` | `ds.button.textGhostHover` |

---

### 3. Labeled Handle

| | Figma | React |
|---|---|---|
| **Component** | `Labeled Handle` (COMPONENT_SET `106:269`) | `LabeledHandle` (`labeled-handle.tsx`) |
| **Variant count** | 4 | N/A (prop-driven) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `Position` | `left`, `right` | `position` | `Position` (React Flow enum: `Top`, `Right`, `Bottom`, `Left`) | **Partial** — Figma has 2 values (`left`, `right`); React supports all 4 React Flow positions. Figma `left` corresponds to React `Position.Left` (input handle), Figma `right` to `Position.Right` (output handle). |
| `State` | `disconnected`, `connected` | `connected` | `boolean \| undefined` | **Partial** — Same pattern as Handle. Figma `State` axis name vs React `connected` boolean prop. |

---

### 4. Node Card

| | Figma | React |
|---|---|---|
| **Component** | `Node Card` (COMPONENT_SET `106:405`) | `BaseNode` (`base-node.tsx`) |
| **Variant count** | 2 | N/A (CSS-driven) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `Selected` | `"false"`, `"true"` | N/A (React Flow CSS selector) | N/A | **Mismatch (structural)** — Figma models selection as a variant property. React delegates to React Flow's built-in `.react-flow__node.selected` CSS class, which triggers `shadow-lg` via the DS class `ds.nodeCard.root`. No explicit `selected` prop exists on `BaseNode`. |

---

### 5. Properties Panel

| | Figma | React |
|---|---|---|
| **Component** | `Properties Panel` (COMPONENT_SET `106:485`) | `PropertiesPanel` (`PropertiesPanel.tsx`) |
| **Variant count** | 2 | N/A (conditional render) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `State` | `empty`, `populated` | `selectedNode` | `Node<NodeData> \| null` | **Indirect** — Figma uses `State=empty` vs `State=populated`. React determines state from `selectedNode` being `null` (empty) or truthy (populated). The component renders different JSX branches based on this value. |

---

### 6. Connectable Param Row

| | Figma | React |
|---|---|---|
| **Component** | `Connectable Param Row` (COMPONENT_SET `106:311`) | Inline JSX in `ShaderNode.tsx` |
| **Variant count** | 2 | N/A (conditional render) |

| Figma Variant Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| `State` | `unwired`, `wired` | `isConnected` (local variable) | `boolean` | **Partial** — Figma uses `wired`/`unwired`; React computes `isConnected` from edge data. The connectable param row is not a standalone React component but inline JSX within `ShaderNode`. When `isConnected` is true, it shows source label text; when false, it shows the `FloatSlider`. |

**Note:** The Connectable Param Row uses `ds.connectableParamRow.root` and `ds.connectableParamRow.innerFrame` from the DS, but variant switching (wired vs unwired visual differences) is handled by conditional rendering rather than class swapping.

---

### 7. Preview Toolbar

| | Figma | React |
|---|---|---|
| **Component** | `pill2` (FRAME `282:627`) | `PreviewToolbar` (`PreviewToolbar.tsx`) |
| **Variant count** | N/A (not a COMPONENT_SET) | N/A (state-driven) |

| Figma Property | Figma Values | React Prop | React Type | Match Status |
|---|---|---|---|---|
| N/A | N/A | `previewMode` (from store) | `'docked' \| 'fullwindow' \| 'floating'` | **No Figma variant** — The Figma node `282:627` is a plain FRAME, not a COMPONENT_SET. It has no variant properties. In React, the toolbar derives its state from the Zustand settings store (`previewMode` + `splitDirection`). Active buttons get `ds.button.ghostActive`; inactive get `ds.button.ghost`. |

---

## Summary Matrix

| Component | Figma ID | Figma Type | Variant Axes | React Props | Overall Match |
|---|---|---|---|---|---|
| Handle | `106:84` | COMPONENT_SET | `State` (2 values) | `connected?: boolean` | Partial (name + encoding differ) |
| Button | `106:108` | COMPONENT_SET | `Content` (2), `Style` (2), `State` (4), `Icon` (swap) | `icon`/`label`, `className`, `disabled` | Indirect (DS class mapping) |
| Labeled Handle | `106:269` | COMPONENT_SET | `Position` (2), `State` (2) | `position`, `connected` | Partial (scope + encoding differ) |
| Node Card | `106:405` | COMPONENT_SET | `Selected` (2) | N/A (CSS selector) | Mismatch (structural) |
| Properties Panel | `106:485` | COMPONENT_SET | `State` (2) | `selectedNode: Node \| null` | Indirect (nullability) |
| Connectable Param Row | `106:311` | COMPONENT_SET | `State` (2) | `isConnected` (local) | Partial (not a standalone component) |
| Preview Toolbar | `282:627` | FRAME | None | `previewMode` (store) | Missing (not a component set) |

---

## Migration List

The following items would need attention to bring Figma variant naming into closer alignment with React props. These are observations only -- no changes have been made.

### Figma Changes Needed

1. **Preview Toolbar (`282:627`)** — Currently a plain FRAME. To match the component pattern, it could be promoted to a COMPONENT_SET with a `Mode` variant axis (`docked-v`, `docked-h`, `floating`, `fullwindow`).

2. **Handle / Labeled Handle `State` axis** — Consider renaming from `State` to `Connected` with values `true`/`false` to match the React `connected` boolean prop more directly.

3. **Connectable Param Row `State` axis** — Consider renaming values from `wired`/`unwired` to `connected`/`disconnected` for consistency with Handle components (which use `connected`/`disconnected`).

4. **Properties Panel `State` axis** — Values `empty`/`populated` are clear but could alternatively be `hasSelection=true/false` to mirror the React prop pattern.

### React Changes Needed

1. **Button** — The `IconButton` component does not expose `style` or `state` props. Instead, the caller manually picks the correct `ds.button.*` class. A more structured API could accept `variant: 'solid' | 'ghost'` and `state: 'enabled' | 'disabled' | 'active'` props that map to DS keys internally.

2. **Connectable Param Row** — Currently inline JSX in `ShaderNode.tsx`. Extracting to a standalone `ConnectableParamRow` component with an explicit `wired: boolean` prop would improve Figma parity.

### Naming Convention Recommendations

| Area | Current State | Recommendation |
|---|---|---|
| Figma axis casing | PascalCase (`State`, `Position`) | Keep PascalCase — this is Figma convention |
| Figma boolean values | String `"true"`/`"false"` | Keep — Figma limitation, map to boolean in code |
| React prop casing | camelCase (`connected`, `disabled`) | Keep camelCase — this is React convention |
| State flattening | Figma: single `State` axis; React: decomposed | Accept divergence — different tools, different patterns |
| DS key naming | `<style><State>` (e.g., `ghostActive`) | Document and keep — works well as flat lookup |
