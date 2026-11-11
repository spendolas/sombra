# Node Title (+ Inline Text Field)

## Overview

| Field | Value |
|---|---|
| Figma ID | `993:3749` (Inline Text Field, component set) · board "Node — inline rename" `993:3781` |
| Figma links | [board](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=993-3781) · [Inline Text Field](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=993-3749) · [Icon=pencil](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=995-5755) |
| Figma Page | Components |
| Type | COMPONENT_SET (field) + board rows (title states) |
| Variants | Inline Text Field: State = editing (props Value, Selected, Caret; Counter hidden and unused) |
| React File | `src/components/NodeTitle.tsx` |
| React Component | `NodeTitle` |
| DS Keys | `inlineTextField` (atom), `nodeTitle` (molecule, DB key `nt:1`) |
| Sandbox | `sandbox.html?c=node-title` · standalone `node-title-sandbox.html` |
| Gate | `npm run verify:node-title-ui` (headless Chrome) |
| Status | Wired into `ShaderNode` (branch feat/wire-node-sections) |

The title region of a node header, with inline rename. A drop-in for
`<BaseNodeHeaderTitle>{definition.label}</BaseNodeHeaderTitle>`: it fills the same
flex-1 slot inside `<BaseNodeHeader>` and never touches the header itself.

## Props

| Prop | Type | Meaning |
|---|---|---|
| `title` | `string` | The node's type label ("Number") |
| `customName` | `string?` | The author's name for this node |
| `duplicate` | `boolean?` | Another node carries the same name → amber warning |
| `onRename` | `(name: string \| undefined) => void` | Called once per saved edit that changes the name; `undefined` clears it |
| `className` | `string?` | Extra classes on the root |

Editing state is internal. No store access.

## Behaviour (board A–G)

| State | What shows |
|---|---|
| A · Default | The type label, exactly as before |
| B · Hover | A pencil fades in at the right end (after the type tag when named). It is always laid out, only its opacity changes, so nothing shifts |
| C · Editing | Pencil click **or** double-click on the title → a field in the same place and type size, whole text selected, indigo border |
| D · Custom name | Name in the title; the type as a small dim tag on the right |
| E · Long name | Name truncates with an ellipsis; the tag never shrinks; full name in the `title` tooltip. The title never widens the node (`w-0 flex-1`) |
| F · Save / clear / cancel | Enter or click-away saves; Escape cancels; an empty field shows the type faintly as placeholder and clears the name |
| G · Duplicate | Amber triangle before the type tag; tooltip "Another node has this name — exported controls will be numbered". No tint, no red |

Rules:

- **No visible limit or counter.** `maxLength={120}` on the input is a silent safety net;
  the store caps names too. The Figma component's `Counter` layer is hidden and has no
  code counterpart.
- Save trims. A name saved as `""` **or equal to the type label** becomes `undefined`
  (clears). An unchanged name does not call `onRename` (no empty undo step).
- IME: Enter / Escape while composing belong to the composition and are ignored.
- Canvas safety: field and pencil carry `nodrag nopan` (field also `nokey`); every
  key event in the field is stopped at the field, so Backspace/Delete can't delete the
  node and Escape/F can't toggle app modes; double-click on the title is stopped so it
  can't reach `onNodeDoubleClick`.
- Tooltips are native `title` attributes, like layer names elsewhere in the app. The
  board draws them as styled tooltips; there is no tooltip component yet.

## Geometry (measured in the sandbox)

| Property | Value |
|---|---|
| Header | 32 high, 212 wide (unchanged, owned by `nodeCard.header`) |
| Field | 200 × 24 at x 6, y ≈4 — bleeds 6px into the header padding (`-mx-sm`), as in Figma (header content padding drops to sm/6 while editing) |
| Title text x | rest 12, editing 13 — the field's 1px border, same as Figma (its stroke is included in layout). Within the 1px gate tolerance |
| Pencil | 16px icon at x 184 (12 from the right edge). It is an `IconButton` (24px hit area) with `-mx-xs`, so the hover plate bleeds 4px either side and the icon sits exactly where Figma draws it |
| Gaps | name · warning · tag · pencil, 8px (`gap-md`) |

## Colours

| Part | Figma | Code |
|---|---|---|
| `inlineTextField.field` | surface/default fill, interactive/active stroke, radius sm/4, height input/h | `bg-surface border border-active rounded-sm h-input-h` |
| `inlineTextField.value` | heading/node-title, fg/default | `text-node-title text-fg` |
| `inlineTextField.selection` | interactive/active @ 50% | applied as `selection:bg-active/50` on the field (was interactive/highlight @ 15%: a menu-hover tint, too faint to see selected text on the dark field; changed 2026-11-11 after owner review) |
| `inlineTextField.placeholder` | fg/muted (instance override in board F) | applied as `placeholder:text-fg-muted` on the field |
| `nodeTitle.name` | heading/node-title, fg/default, truncate ending | `text-node-title text-fg truncate` |
| `nodeTitle.typeTag` | label/param, fg/subtle | `text-param text-fg-subtle` |
| `nodeTitle.warning` | Icon=triangle-alert, color/warning strokes | `text-warning` |
| `nodeTitle.pencil` | Icon=pencil, fg/subtle strokes | `text-fg-subtle`, hover plate `bg-hover` + `text-fg` (IconButton ghost convention) |

`selection` and `placeholder` hold Figma's colours so the audit checks them, but the
generator has no pseudo-element prefix, so code applies the same tokens through the
field's `selection:` / `placeholder:` variants (in `field.extra`). Keep the two in step.

## Audit

`tokens:audit` clean. Ignores and nulls (reasons — `.claude/ds-queue.md` is gitignored and
lives only in the main checkout, so they are recorded here):

- `inlineTextField.selection` (993:3738) → `fill.opacity`: the 50% is the paint's own opacity over
  interactive/active (solid `#6366f1`); in code it is the `/50` modifier in `selection:bg-active/50`.
  (Until 2026-11-11 this was interactive/highlight at 15%: too faint to see a selection.)
- `inlineTextField.selection` → `width`, `height`: Figma draws the selection as a fixed
  55×21 rect; code uses the native `::selection` over the selected glyphs.
- `nodeTitle.root` (993:3897) → `padding`, `width`, `height`: on the board the row is an
  absolute 212×32 frame with 12px side padding; in code the header (`nodeCard.header`)
  owns the padding and height, and the title root is the header's flex-1 slot.
- `inlineTextField.placeholder` — `figmaNodeId: null`: Figma draws the placeholder only as an
  instance override in board F (`I993:3946;993:3739`). Instance-sublayer ids are fragile (they
  change when the instance is swapped) and resolving one needed a Figma server round-trip that
  timed out and took the whole audit down, so it is not anchored. Colour: fg/muted.
- `nodeTitle.warning`, `nodeTitle.pencil` — `figmaNodeId: null`: the icon colour lives on
  the vector strokes inside the instance, which the extractor does not read (same as
  `amdWarning.icon`, `compileErrorBanner.icon`). The pencil's button chrome (radius, hover
  plate) is the IconButton convention, not drawn on the board.

## Gate — `verify:node-title-ui`

15 checks, real mouse/keyboard, headless Chrome, Vite on its own port (no watcher/HMR).
Each outcome is paired with proof the mechanism ran (a control drag that DOES move the
node, a control Backspace outside the field that DOES reach the delete sentinel, the
focused input's selection range, opacity 0 while laid out at 24px…).

Perturbations, each removed alone, gate red, then restored:

| Removed | Result |
|---|---|
| blur-save (`onBlur` → no-op) | 9/15 red — "click-away saves" (`onRename` never called); the field then stays open, so later checks cascade |
| select-all (`input.select()`) | 7/15 red — pencil and double-click (selection 6..6 / 12..12), Enter (typing appended), click-away, Escape, empty-clear, IME |
| `nodrag` on the field only | 1/15 red — dragging in the field moved the node 53px |
| `nodrag` on the pencil only | 1/15 red — dragging the pencil moved the node |
| key `stopPropagation` | 1/15 red — Backspace ×2 and Delete reached the canvas delete handler |

Restored: 15/15.

## Plug-in — done (branch feat/wire-node-sections)

1. `ShaderNode.tsx` renders `<NodeTitle title={definition.label} customName={nodeData.label}
   duplicate={…} onRename={(n) => renameNode(id, n)} />` in place of
   `<BaseNodeHeaderTitle>`. The error ⚠ after it still fits; header measured 32.
2. `renameNode` (from main): one undo step, no recompile — and now also **no thumbnail
   re-render**: the preview scheduler used to mark a node stale whenever its `data`
   object changed identity, so a rename re-ran its thumbnail compiles. It now compares
   `params` and `type` only (`src/renderer/preview-scheduler.ts`).
3. `duplicate`: `hasDuplicateLabel(nodes, label)` over `duplicateLabelSlugs(nodes)`
   (`src/nodes/node-label.ts`), cached per nodes array — one computation per graph
   change, shared by every title. Labels are grouped by `labelSlug`, a copy of the
   manifest's private slug rule; `verify:node-sections` asserts it flags exactly the
   pairs `buildManifest` numbers. It looks at every named node, not only nodes that own
   a knob, so two same-named nodes with no exported controls also warn.
4. Gate: `npm run verify:node-sections-ui` covers pencil + Enter, one-step undo, zero
   compile and thumbnail worker requests, the duplicate pair, click-away, Escape and
   Backspace/Delete in the field, on a real canvas.
