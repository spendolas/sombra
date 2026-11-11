# Knob Table (+ Table Header, Knob Row, Knob Notice)

## Overview

| Field | Value |
|---|---|
| Figma board | [Embed modal — knob table `993:3778`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=993-3778) |
| Figma components | [Table Header `994:4033`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=994-4033) (COMPONENT), [Knob Row `994:4106`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=994-4106) (COMPONENT_SET) |
| Variants | Knob Row: State = rest / hover / copied / clash (4); text props Key, Type, Default, Range; boolean Swatch |
| Board frames used as parts | [Knobs `994:5134`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=994-5134) (table, header, hint, divider), [Name clash notice `994:5360`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=994-5360), [Empty state `994:5589`](https://www.figma.com/design/gq5i0l617YkXy0GzAZPtqz/Sombra?node-id=994-5589) |
| React File | `src/components/KnobTable.tsx` |
| React Component | `KnobTable` |
| DS Keys | `tableHeader`, `knobRow`, `knobTable`, `knobNotice` |
| Sandbox | `sandbox.html?c=knob-table` (standalone: `knob-table-sandbox.html`) |
| Gate | `npm run verify:knob-table-ui` (headless Chrome, real mouse) |
| Status | Sandbox only — **not yet wired into `EmbedModal.tsx`** |

The list of knobs a published scene exposes, exactly as a host passes them to
`shader.set()`. It sits inside the Embed modal's "Control it from JavaScript"
section, under the control snippet and its hint line, so the keys are next to
the code that uses them.

Knob Notice and Knob Table have no Figma component of their own: they are the
board's frames. `knobTable` is keyed by the board's Knobs frame (`994:5134`),
`knobNotice` by the notice frame (`994:5360`); every part still points at a real
node, so `tokens:audit` checks them.

## Anatomy

1. **Header line** — "KNOBS · n" in the Category Header look (`ds.categoryHeader.root`),
   "Click a key to copy it" on the right (hidden when there are no knobs).
2. **Notice** (optional) — a neutral raised box with an edge line: amber icon, grey text.
3. **Table** — the Table Header (KEY, TYPE, DEFAULT, RANGE, then an empty 64px
   column reserved for the later annotation / expose controls), then the body:
   named knobs, a thin divider (the Separator atom), the auto-named rest.
4. **Footnote** (optional) — one line under the table.

A row: key (+ copy icon on hover, or check + "Copied", + clash mark), type,
default, range, reserved space.

## Rules the design settled

| Rule | How |
|---|---|
| Named knobs first, then a divider, then the auto-named rest | `named === true` rows keep their given order; the rest keep theirs. Divider only when both groups exist |
| Auto-named keys a step dimmer | `knobRow.keyAuto` (fg-dim) vs `knobRow.key` (fg) |
| About eleven rows, then the body scrolls under a header that stays | The header sits **outside** the scroll box (`knobTable.body` = `max-h-[308px] overflow-y-auto`; 308 = Figma's 334 table − 26 header), so it cannot scroll away. Both header and body reserve the same scrollbar gutter, so the columns stay aligned on systems with classic scrollbars |
| The key is the copy target | The whole row is a `<button>`; a click anywhere copies the **key** only (defaults and ranges are for reading) |
| Copy feedback | Copy icon after the key on hover; after a click, green check + "Copied" for 1.5 s, the same icons, colour and timing as the snippet copy buttons. A refused copy shows nothing |
| Colours | Swatch = knob default over a token checkerboard (fg-muted / fg-subtle) so alpha below 1 shows; then `#RRGGBB α 0.00` |
| Numbers | Integers bare, fractions to ≤ 4 places, a real minus sign (−). Range `min – max`, or `—` |
| Name clash | Calm notice above the table (no tint, no red, no glow) + small amber triangle and "name clash, numbered" on the numbered row only |
| Empty | One line instead of the table: "This scene has no knobs: hosts can show it, but there is nothing to drive." |

## Props

```ts
type KnobTableItem = Pick<KnobDescriptor, 'key' | 'type' | 'default' | 'min' | 'max'> & {
  named?: boolean      // listed first, full-strength key
  clash?: boolean      // this key was numbered because of a name clash
  clashNote?: string   // text beside the mark; default "name clash, numbered"
}
KnobTable({ knobs, onCopy?, notice?, footnote?, copiedMs? = 1500, className? })
```

`onCopy` defaults to `navigator.clipboard.writeText` with a textarea +
`execCommand('copy')` fallback. Pure: no store access.

## Colours

| Part | Figma | Code |
|---|---|---|
| `tableHeader.root` | surface/raised, bottom edge/subtle | `bg-surface-raised border-b border-edge-subtle` |
| column titles | heading/category, fg/subtle | `text-category text-fg-subtle uppercase` |
| `knobRow.root` hover / `rootLifted` | interactive/hover | `hover:bg-hover` / `bg-hover` |
| `knobRow.key` / `keyAuto` | mono/value, fg / fg-dim | `text-mono-value text-fg` / `text-fg-dim` |
| `knobRow.type` | port-row/type, fg/subtle | `text-port-type text-fg-subtle` |
| `knobRow.defaultValue` / `range` | mono/value, fg/dim / fg/subtle | `text-mono-value text-fg-dim` / `text-fg-subtle` |
| `knobRow.copyIcon` / `checkIcon` / `copied` | fg/subtle / color/success / label/param success | `text-fg-subtle` / `text-success` / `text-param text-success` |
| `knobRow.clashIcon` / `clashHint` | color/warning / label/param fg/subtle | `text-warning` / `text-param text-fg-subtle` |
| `knobRow.swatch` | radius/xs, edge/card, checker fg/muted + fg/subtle | `rounded-xs border-edge-card` + conic-gradient checker |
| `knobNotice.root` | surface/raised, edge/subtle | `bg-surface-raised border border-edge-subtle` |
| `knobNotice.icon` / `text` | color/warning / body/default fg/dim | `text-warning` / `text-body text-fg-dim` |
| `knobTable.empty` / `emptyText` | surface/raised / body/default fg/subtle | `bg-surface-raised p-lg` / `text-body text-fg-subtle` |

## Reused, not rebuilt

Category Header (title), Separator (group divider), icons `copy` / `check` /
`triangleAlert`, the snippet buttons' copy feedback (same icons, `text-success`,
1500 ms). No new tokens, no new icons.

## Audit

`tokens:audit` clean. Ignores (reasons — append to `.claude/ds-queue.md`, which is
gitignored and lives in the main checkout only):

- `knobRow.rootLifted` (994:4053) → `fill.opacity`: the 6 % is the interactive/hover
  variable's own alpha, copied onto the paint by Figma's binding. `bg-hover` already
  contains it; a `/6` modifier would apply it twice.
- `knobRow.swatch` (994:4044) → `stroke.opacity`: same — edge/card's own 10 % alpha.
- `knobRow.copyIcon / checkIcon / clashIcon` (994:4056, 994:4073, 994:4090) and
  `knobNotice.icon` (994:5361) → `fill`, `textColor`: icon instances. Figma colours the
  vectors' strokes inside the instance (fg/subtle, color/success, color/warning) and
  hides the instance's own fill; code tints via `currentColor` (`text-*`).
- `knobRow.swatchColor` (994:4049) → `fill`, `width`, `height`: the colour is the knob's
  runtime default; code layer is `absolute inset-0`.
- `knobTable.table` (994:5151) → `height`: Figma frame is FIXED 334; code caps the
  body at `max-h-[308px]` and shrinks to content when shorter.

The checker squares (994:4045–4048) have no parts: the four rects are drawn in code
by one `repeating-conic-gradient` in `knobRow.swatch`'s `extra`, using the same two
tokens.

## Plug-in plan (not done — owner sign-off first)

1. **Rows from the manifest.** `EmbedModal` already holds `result = publishScene(...)`,
   whose `result.manifest` is `buildManifest(plan.userUniforms, nodes)` — a
   `KnobDescriptor[]` in graph order. Pass it straight through:
   `<KnobTable knobs={result.manifest} footnote="Named nodes come first …" />`.
   `KnobTableItem` is a structural subset of `KnobDescriptor`, so no mapping is needed.
2. **`named`.** The SR-1 manifest work (other branch) adds `named: boolean` to
   `KnobDescriptor` (true when the owning node has an author-given name). The board
   also lists Fragment Output's alpha with the named knobs ("it is always public");
   whether the manifest marks it `named` or the modal does is for that work to settle.
   Once merged, delete the local `named?` from `KnobTableItem` — the field then comes
   from `Pick<KnobDescriptor, …>`.
3. **Clash info.** The same work's dedupe pass knows when a key had to be numbered
   because two named nodes share a name. Two outputs are needed from it: per knob, a
   `clash: true` on the numbered key (optionally `clashNote`); per scene, the clashing
   label and the key it produced, so the modal can build the notice text
   (board wording: "Two nodes are named “<label>”. The second one publishes as
   <key>. Rename one of them so each key stays the one you meant."). If the manifest
   only exposes the per-knob flag, the modal can build the notice from the flagged
   knob's key plus its node's display name.
4. **Placement.** Inside the `result &&` "Control it from JavaScript" block, after the
   `shader.nodes()` hint line, before the Inline `<details>`. The table's own `pt-md`
   gives the gap; the section needs no new spacing.
5. **Copy.** Leave `onCopy` unset (default clipboard). The modal's snippet buttons and
   the table then share icons, colour and the 1.5 s hold; a shared copy hook is a
   separate change if wanted.
6. **Check.** Open the modal on the site scene, a clash scene and an all-baked scene
   at real modal width (720, and narrow at 92vw) — the sandbox at 680 can hide a
   narrow-container bug.
