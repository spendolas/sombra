# Embed knobs — UI still to design (SR-1)

Status: **needs Figma design before any code.** The data side of SR-1 (author
names → stable knob keys) is implemented on `feat/embed-knobs-p0`; the two
pieces of UI below are not built, by the design-first rule. Source of the
behaviour: the site feature request, SR-1 items 1 and 5
(`Spendolas SL/www/docs/refactor/SOMBRA-FEATURE-REQUEST.md`).

What already exists to build against:

| Piece | Where |
|---|---|
| Store action `renameNode(nodeId, label \| undefined)` — trims, empty/undefined clears (120-char silent safety cap), one undo step, no-op when unchanged | `src/stores/graphStore.ts` |
| Label normaliser (`NODE_LABEL_MAX` = 120, a safety cap only) | `src/nodes/node-label.ts` |
| Dev-bridge `__sombra.renameNode(id, label)` | `src/dev-bridge.ts`, `BROWSER-AUTOMATION.md` |
| Manifest: custom labels claim their key slug first; `named: true` on their knobs; duplicate labels become `Label`, `Label 2`, … in graph order | `src/embed/manifest.ts`, `EMBED.md` §2 |

A rename does not recompile the shader (the label is in none of the compile keys).

## 1. Inline rename on the node title

Today the header always shows the node type's label (`ShaderNode.tsx`,
`BaseNodeHeaderTitle`); a stored custom label is not displayed anywhere.

Behaviour to design:

- **Display.** Header shows the custom label when set, else the type label.
  Decide whether a renamed node still shows its type somewhere (subtitle,
  tooltip, muted suffix) — the type is no longer readable from the title.
- **Enter edit mode** by double-clicking the title. Single click keeps selecting
  / dragging the node as now.
- **Editing.** Inline text field in the title's place, pre-filled with the
  current label (or the type label). No design length limit and no character counter
  (owner decision 2026-11-10); the store silently cuts at 120 as a safety cap.
- **Commit / cancel.** Enter or blur commits; Escape cancels and restores.
  Committing an empty string clears the custom label and the title falls back
  to the type label.
- **Undo.** One rename = one undo step (already true in the store).
- States to draw: idle (type label), idle (custom label), editing, and how a long
  label truncates (ellipsis?) in a narrow node header.

## 2. Knob table in the Embed modal

Today `EmbedModal.tsx` shows no knob list at all. The author needs to confirm
the knob keys before downloading the `.ombra`.

Behaviour to design:

- **Read-only table**, one row per manifest knob: key, type, default, and
  min–max (blank when the knob has no range, e.g. colours).
- **Order:** named knobs (`named: true`, i.e. from nodes with a custom label)
  first, then the rest, each group in manifest order.
- **Colour defaults** need a swatch (RGBA, with alpha visible — ramp stop knobs
  are 4-component and are commonly given alpha < 1).
- **Ramp stops** appear as `<node>-stop-0 … <node>-stop-N` (manifest
  `group: "stops"`, `index`, `position`). Decide whether they are grouped
  under their ramp or listed flat.
- **Duplicate-label warning.** When two or more nodes share the same custom
  label (after trimming; case and punctuation that slugify the same also
  clash, e.g. `site.balance` and `Site Balance`), the manifest de-duplicates
  them (`site-balance-…`, `site-balance-2-…`). The modal must warn and name the
  clash: which label, how many nodes, and which keys each got — the `-2` key is
  not the stable key the host expects.
- Long keys must stay copyable (monospace, no mid-key truncation); consider a
  copy-key action per row.
- Empty state: a scene with no knobs.

Out of scope here (SR-7, P1): per-knob role / expose toggle / range overrides
edited from this table. Leave room for those columns but do not design them yet.
