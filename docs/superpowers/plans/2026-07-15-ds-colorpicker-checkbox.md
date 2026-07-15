# DS Color Picker + Checkbox (Figma-first) + Color-node redesign — Plan

**Date:** 2026-07-15  ·  **Branch:** `feat/transparent-output`

**Goal:** Make the RGBA picker and the bool checkbox first-class DS components (Figma-first per CLAUDE.md's golden rule — the V2 code-first guide is obsolete), built from EXISTING tokens (no new tokens). Consolidate to a SINGLE color picker (kill the native `<input type=color>`). Redesign the Color node so its body IS an inline picker; the Properties panel is also inline; color-ramp stops and the preview-background solid color use a compact swatch → popover.

**Authoring brief (read first):** `.superpowers/sdd/figma-ds-authoring-brief.md`
- grip: `set_active_file` (file `gq5i0l617YkXy0GzAZPtqz`) FIRST (4 files open → ambiguous otherwise).
- Components page `106:48`; Molecules frame `136:204`; Atoms frame `136:199`; new category = trailing `Row N` (HORIZONTAL, itemSpacing 24, AUTO×AUTO).
- States = sibling COMPONENTs in a COMPONENT_SET, `Axis=value` layer names (see Anchor Cell `717:14`). Bind fills/strokes via `bind_paint_to_variable` (`UI Colors` = `VariableCollectionId:106:2`). Text color separate from Text Style. Bind sizes only where an exact token exists (else raw literal, like Color Swatch 24px).

**DB shape** (`tokens/sombra.ds.json`, keyed by figma node id): `{ name, type, dsKey, codeFile, parts: { <part>: { figmaNodeId, fill, stroke, radius, padding, gap, textStyle, textColor, hover, layout, extra, auditIgnore } } }` → `npm run tokens` generates `ds.<dsKey>.*`.

## Global constraints
- TS strict; both backends keep working (no codegen change — UI only). Reuse EXISTING tokens; NO new token variables. Runtime inline `style` only for computed position + live swatch/gradient colors (the SV/hue/alpha gradients + fixed positioning are the allowed exception). No raw hex elsewhere. Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- After DB edits: `npm run tokens` then `npm run tokens:audit` (Figma↔DB parity) must be clean.

## Phase A — Bool Checkbox (pilot: proves Figma→DB→code loop)

### A1 — Figma (grip)
Author a **Checkbox** atom on the Atoms frame (`136:199`) as a COMPONENT_SET with `State=unchecked` / `State=checked`:
- box: fixed ~16px, `radius: xs`, stroke `edge/default`; unchecked fill `surface/raised`; checked fill `indigo/default` + a check glyph (vector or "✓" text) in `fg/default`.
- Bind fills/strokes to `UI Colors` vars. Record the component-set node id + the two variant node ids + the box/glyph part node ids.

### A2 — DB + generate
Add `boolCheckbox` component to `sombra.ds.json` (type `atom`, `dsKey: boolCheckbox`, `codeFile: src/components/NodeParameters.tsx`, parts: `root`/`box`/`boxChecked`/`indicator`/`label` from existing tokens). `npm run tokens`; `npm run tokens:audit` clean.

### A3 — Wire code
Rewrite `BoolCheckbox` in `NodeParameters.tsx` to consume `ds.boolCheckbox.*` (visually-hidden native `<input type=checkbox>` + styled box, checked state from the DB tokens). Remove the inline `accent-indigo`. Keep `nodrag nowheel` on the row, keep the recompile-param wiring. `tsc`/`lint` clean. Controller live-check: checkbox toggles Preserve Alpha, styled per DS.

## Phase B — Color Picker + Color-node redesign

### B1 — Figma (grip)
Author a **Color Picker** molecule on the Molecules frame (`136:204`) (mirror Gradient Editor's molecule classification). Static representation of the panel + reuse the **Color Swatch** atom as the trigger:
- parts: `swatch` (trigger; reuse/align to Color Swatch atom), `panel` (container: fill `surface/raised`, stroke `edge/default`, `radius: sm`), `svArea` (square; static gradient mock), `hueSlider` + `alphaSlider` (bars; static), `readout` (text `text-mono-value`/`fg`), `label` (`text-param`/`fg-subtle`). Bind chrome fills/strokes to `UI Colors`; the gradient fills are static mocks (code supplies runtime gradients). Record all part node ids.

### B2 — DB + generate
Add `colorPicker` component to `sombra.ds.json` (type `molecule`, `dsKey: colorPicker`, `codeFile: src/components/RgbaColorPicker.tsx`, parts per B1 from existing tokens; use `auditIgnore` for the runtime-gradient parts). `npm run tokens`; `npm run tokens:audit` clean.

### B3 — Wire code: single picker + inline/popover modes
`RgbaColorPicker.tsx`:
- Consume `ds.colorPicker.*` for all chrome (swatch, panel, sliders, readout, label). Keep HSV math + value/onChange + portal/positioning/dismiss.
- Add a `mode: 'inline' | 'popover'` prop (default `popover`). `inline` renders the panel directly (no swatch trigger, no portal, always open). `popover` keeps the current swatch→portaled-panel behavior.

### B4 — Wire consumers
- **Color node** (`color_constant`): make its body the inline picker. In `ShaderNode.tsx` (or the node's render), for `color_constant` render `<RgbaColorPicker mode="inline" value=... onChange=...>` as the node body instead of the current swatch param control. Keep the `color` output handle. This is the "node IS the picker" redesign.
- **Properties panel** (`NodeParameters` color param, as used by PropertiesPanel): render `mode="inline"`.
- **Color-ramp stops** (`ColorRampEditor`): `mode="popover"` (swatch per stop).
- **Preview-background solid** (`BackgroundModeControl`): replace the native `<input type=color>` with `<RgbaColorPicker mode="popover">`; convert `previewBackground.color` CSS-string ↔ `[r,g,b,a]` (parse `#rgb`/`#rgba`/`rgba()`; write back `rgba()`/`#rrggbb`).
- Remove native color input everywhere: `DSPreview.tsx` colorInput demo → show the picker; drop dead `input[type="color"]` rules in `index.css`; remove `ds.colorInput.input` from the DB if now unused (regenerate). Grep-confirm no `type="color"` remains in `src/`.

### B5 — Verify
`npm run tokens:check` + `tokens:audit` clean; `tsc`/`lint` clean; `verify-ir-poc`/`validate-wgsl-multipass` still 0 failed (no codegen change). Controller live-check BOTH backends: color node shows a usable inline picker; Properties panel inline; ramp stops + bg-solid open the popover picker; a single picker component everywhere; alpha still propagates (spot-check swatch alpha → checker).

## Notes
- Only `color_constant` gets the inline-node treatment. Other color-output nodes are unaffected (they have no color param/swatch).
- If Figma authoring of a part proves impractical to bind (e.g. gradient), represent it as a static mock + `auditIgnore` the runtime bits in the DB — the interactive truth lives in code.
