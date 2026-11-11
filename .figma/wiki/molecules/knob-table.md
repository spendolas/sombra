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
| Gate | `npm run verify:knob-table-ui` (sandbox, headless Chrome, real mouse); `npm run verify:embed-knob-table-ui` (the real Embed modal) |
| Status | **Wired into `EmbedModal.tsx`** (JavaScript section, under the hint line) |

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
type KnobTableItem = Pick<KnobDescriptor, 'key' | 'type' | 'default' | 'min' | 'max' | 'named'> & {
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

- `knobRow.keyAuto` is deliberately NOT anchored to Figma (`figmaNodeId: null`). It
  pointed at a layer inside a component instance (`I994:5288;994:4041`); looking that up
  needs a Figma server round-trip that times out and fails the whole `tokens:audit` run
  (same fix as `inlineTextField.placeholder`, `82b32ef`). Its colour is `fg-dim` (the
  dimmer variant of `knobRow.key`'s `fg`), recorded here instead.

The checker squares (994:4045–4048) have no parts: the four rects are drawn in code
by one `repeating-conic-gradient` in `knobRow.swatch`'s `extra`, using the same two
tokens.

## Plug-in (done)

What was built, against the plan the component's builder wrote (each claim
re-checked against source):

1. **Rows from the manifest.** `EmbedModal` maps `result.manifest` (the publish
   result it already builds) to rows in `knobRows()`: key, type, default, min,
   max, `named`. KnobTable sorts named first. The rows are rebuilt on every open
   (the modal re-publishes on open), so a rename between opens shows up.
2. **`named`.** Comes from `KnobDescriptor.named` (SR-1); the local `named?` in
   `KnobTableItem` is gone. **Fragment Output's knobs are listed with the named
   ones** in the modal (`nodeType === 'fragment_output'`), as the board shows
   ("it is always public"); the manifest does not mark them — that would change
   published bytes.
3. **Clash info.** Editor half only: `buildManifestWithClashes()` in
   `src/embed/manifest.ts` returns the same manifest plus `KnobNameClash[]`
   (numbered node, its label, the label that kept the slug, the numbered name);
   `publishScene` passes it out as `PublishResult.clashes`. The artifact is the
   same bytes (57 fixtures + the committed `.ombra` files hashed before/after).
   Every key of a numbered node gets `clash: true`; the notice is built in the
   modal (`clashNotice()`), one sentence pair per clashing label, board wording.
   Note the real numbered key is `site-balance-2-value` (the node name is
   numbered, then the param appended), not the board's `site-balance-value-2`.
4. **Placement.** Inside the `data-section="control"` block, after the
   `shader.nodes()` hint, before Inline. No spacing added.
5. **Copy.** `onCopy` is the modal's own `writeClipboard` — the same function
   the snippet copy buttons call — so a refused write shows no "Copied".
6. **Check.** `verify:embed-knob-table-ui`. Measured in headless Chrome: at a
   1280 window the modal is 720 and the table 680, key column 261 px (the body
   reserves an 11 px gutter for a classic scrollbar, so a key + clash hint
   around 20 characters truncates where the board shows it whole; overlay
   scrollbars reserve nothing). At 640 (92vw cap) the table is 549, key column
   130. Below about a 500 px window the fixed columns (336 px + gaps) leave the
   key column no room — at 480 it is 0 px. The editor is not used at that width.
