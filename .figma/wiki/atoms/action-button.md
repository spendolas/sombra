# Action Button

## Overview

| Field | Value |
|---|---|
| Figma ID | `901:2134` |
| Figma Page | Components / Atoms / Row 2 |
| Type | COMPONENT_SET |
| Variants | Secondary enabled; Primary enabled; Primary disabled |
| React File | `src/components/ActionButton.tsx` |
| React Component | `<ActionButton />` |
| DB key | `actionButton` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=901:2134) |

## Purpose

Provides the shared text actions used by export and import dialogs. The atom
formalizes the button styles first introduced by the video export UI so other
workflows do not duplicate their visual classes.

## Variants

| Variant | Figma node | Use |
|---|---|---|
| Secondary / enabled | `901:2128` | Cancel and Close |
| Primary / enabled | `901:2130` | Open project, Download, and Export |
| Primary / disabled | `901:2132` | Unavailable primary action |

## Token bindings

| Property | Tokens / styles |
|---|---|
| Label | `label/action`; `fg/default`, `fg/dim`, or `fg/muted` |
| Fill | `indigo/default` or `surface/raised`; secondary is transparent |
| Border | Secondary uses `edge/default` at 1px |
| Padding | `spacing/lg` horizontal; `spacing/xs` vertical |
| Radius | `radius/sm` |
| Hover | Secondary uses `interactive/hover`; primary uses `indigo/hover` |

## Code usage

```tsx
<ActionButton onClick={onCancel}>Cancel</ActionButton>
<ActionButton variant="primary" disabled={!canSubmit} onClick={onSubmit}>
  Submit
</ActionButton>
```

Use `actionButtonClass('primary')` for button-like links such as the completed
export Download action.

## Parity: ✅ Match

Every static visual property is registered in `tokens/sombra.ds.json`, generated
as `ds.actionButton`, and consumed by `ActionButton`. Export and file-drop dialog
actions both use this atom.
