# File Drop Dialog

## Overview

| Field | Value |
|---|---|
| Figma ID | `901:2118` |
| Figma Page | Components / Organisms / Row 4 |
| Type | COMPONENT |
| States | Confirmation with optional Cancel; notice with one Dismiss action |
| React File | `src/components/FileDropOverlay.tsx` |
| React Component | `<FileDropDialog />` |
| DB key | `fileDropDialog` |
| Figma URL | [Open in Figma](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=901:2118) |

## Purpose

Provides a browser-independent Sombra confirmation and notice surface for file
imports. It replaces native `window.confirm` and `window.alert` UI while keeping
project replacement cancellable and import errors dismissible.

## Structure

- Full-window scrim root, centered in both axes.
- Raised panel with title, detail, and right-aligned actions.
- Actions compose the shared Action Button atom.
- Cancel is optional; confirmation uses Open project and notices use Dismiss.

## Token bindings

| Part | Figma variables / styles | Generated classes |
|---|---|---|
| Root | `overlay/scrim` | `ds.fileDropDialog.root` |
| Panel | `surface/raised`, `edge/default`, `radius/md`, `spacing/lg`, `spacing/md` | `ds.fileDropDialog.panel` |
| Title | `heading/node-title`, `fg/default` | `ds.fileDropDialog.title` |
| Detail | `body/description`, `fg/dim` | `ds.fileDropDialog.detail` |
| Actions | `spacing/md` | `ds.fileDropDialog.actions` |
| Buttons | Action Button secondary / primary variants | `<ActionButton />` |

Every visual part is variable- or text-style-bound in Figma. The 720×450 Figma
component size is only a reference viewport; code uses the audited fixed/inset
root behavior to cover the current browser viewport.

## Interaction

- Confirmation receives initial keyboard focus.
- Escape and clicking the scrim resolve as Cancel/Dismiss.
- Clicking inside the panel does not dismiss it.
- `aria-modal`, labelled-by, and described-by relationships are present.

## Parity: ✅ Match

Figma node IDs are registered in `tokens/sombra.ds.json`, generated through
`npm run tokens`, and consumed by the React component without duplicated visual
classes.
