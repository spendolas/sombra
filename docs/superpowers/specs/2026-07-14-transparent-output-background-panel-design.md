# Transparent Output + Background Panel — Design

**Date:** 2026-07-14
**Status:** Approved (design), pending implementation plan
**Branch:** `feat/transparent-output`

## Goal

Let a Sombra shader render on a transparent background so users can overlay
the output over other page elements (embeds, shared links). Add an
After-Effects-style background-modes panel to the editor preview so
transparency is visible while authoring, without baking any backdrop into the
exported result.

This is scoped as **one** feature. An earlier framing split it into a separate
"Composite node"; that was a misread — the boolean alpha operations are a
dropdown on the Fragment Output node, not a node family.

## Approach — transparency is emergent

Both renderers clear the canvas to `a = 0` **always**. Final alpha comes
entirely from the shader. Existing graphs emit `a = 1` everywhere, so they stay
fully opaque — no behavior change and no migration. Transparency appears only
where the shader emits `a < 1`. There is **no** global "transparent mode"
toggle; the only new UI is the background panel.

**Premultiplied alpha.** The WebGPU canvas is already
`alphaMode: 'premultiplied'`, and WebGL2's canvas default is likewise
premultiplied. The final color write must therefore be premultiplied:
`vec4(color * a, a)`. For `a = 1` this is identical to today's output, so
existing opaque graphs are unaffected. Premultiplication happens **only at the
final Fragment Output write**; intermediate multi-pass textures remain
straight-alpha.

Alternative considered and rejected: an explicit transparent-mode setting.
It adds persisted state and a decision point for no benefit, because emergent
alpha already preserves opaque behavior by default.

## Component 1 — Fragment Output node

File: `src/nodes/output/fragment-output.ts` (+ `isValidConnection` in
`src/components/FlowCanvas.tsx`, coercion in `src/nodes/type-coercion.ts`).

Inputs / params:

- **Color** — accepts `vec3` / `color` / `vec4`. If a `vec4` (or alpha-bearing
  source) is wired, its `.a` is the *derived* alpha `d`; otherwise `d = 1.0`.
- **Alpha** — connectable `float` input, default `1.0` (call it `a_in`). This is
  where a future mask/composite output plugs in.
- **Alpha op** — enum param, displayed under the Alpha input, `updateMode:
  'recompile'`. Values and math (with `d`, `a_in` both in 0–1):

  | Op | Result |
  |----|--------|
  | Replace | `a_in` |
  | Multiply (Intersect) — **default** | `d * a_in` |
  | Union / Max | `max(d, a_in)` |
  | Add | `d + a_in` |
  | Subtract | `d - a_in` |
  | Min | `min(d, a_in)` |
  | Difference | `abs(d - a_in)` |

Final-alpha resolution:

```
if Alpha input unconnected:  a_final = d
else:                        a_final = clamp(op(d, a_in), 0.0, 1.0)
emit:                        fragColor = vec4(color * a_final, a_final)   // premultiplied
```

Both `glsl()` and `ir()` generators implement this identically (parity is
enforced by `verify-ir-poc.ts`). The node currently hardcodes
`fragColor = vec4(color, 1.0)` in both paths — that is the line being replaced.

Detecting "Alpha input connected" and "Color carries alpha" uses the existing
compiler input mechanism (`ctx.inputs.*`); connectable inputs already report
whether they are wired vs. using their default.

## Component 2 — Renderers

**WebGL** (`src/webgl/renderer.ts`):
- `clearColor(0, 0, 0, 1)` → `clearColor(0, 0, 0, 0)` (line ~957).
- Make context flags explicit: `getContext('webgl2', { alpha: true,
  premultipliedAlpha: true })` (line ~135) — currently relies on defaults.
- Intermediate multi-pass FBOs are unchanged; only the final
  default-framebuffer clear goes transparent.

**WebGPU** (`src/webgpu/renderer.ts`):
- `clearValue: { r:0, g:0, b:0, a:1 }` → `a:0` at the three sites
  (lines ~874, ~919, ~946).
- `alphaMode: 'premultiplied'` stays as-is.
- No blend state added: with an opaque-write pipeline the fragment's
  premultiplied alpha becomes the canvas pixel alpha, which composites
  correctly over the host page.

Renderers gain **no** premultiply logic — that lives in codegen (Component 1).

## Component 3 — Background panel (view-only)

Files: `src/components/PreviewToolbar.tsx`, `src/components/PreviewPanel.tsx`,
`src/stores/settingsStore.ts`.

- New control in the preview toolbar: a small popover with modes **Checker**
  (default) · **Solid** (with color picker) · **None / transparent**.
- Rendered as a CSS layer **behind** the canvas in `PreviewPanel.tsx`
  (checker = CSS gradient; solid = chosen color). Purely display; it never
  touches the render or the export.
- Persisted in `settingsStore` as `previewBackground: { mode, color }`,
  following the existing `previewMode` / `splitDirection` persistence pattern.
- Applies to docked / floating / fullwindow preview.
- Node mini-thumbnails render transparent and composite over the node card
  (no checker, no extra UI).

The color picker reuses an existing DS control if one exists; if a new control
is required it goes through the design-system pipeline (`sombra.ds.json` →
`npm run tokens` → `ds.*`) with a `.claude/ds-queue.md` entry for any interim
inline classes.

## Data flow

```
Color source ──(vec3|color|vec4)──► Fragment Output ─┐
Alpha source ──(float, optional)───► Alpha op merge  ├─► fragColor = vec4(rgb*a, a)
                                     (7 ops, clamp)  ─┘        │
                                                              ▼
                              renderer clears a=0, writes premultiplied pixel
                                                              │
                        ┌─────────────────────────────────────┤
                        ▼                                     ▼
              editor preview canvas                   viewer.html / embed / share
              (CSS backdrop behind: checker/solid)    (transparent over host page)
```

## Compatibility & edge cases

- **Existing graphs:** alpha defaults to 1 → premult is a no-op → output opaque.
  No save migration needed.
- **Save/load:** the new enum param serializes like any other. Older saves must
  gain `Alpha op = Multiply` and an unconnected Alpha input (→ opaque) via the
  param-default merge on load; the implementation plan verifies both the
  URL-decode and `.sombra` import paths merge defaults (the audit flagged file
  import as historically not merging — confirm it does before relying on it).
- **Viewer/embed/share** (`src/viewer.ts`): canvas is already alpha-capable;
  the transparent clear makes shared links overlay correctly. No baked
  background (matches the view-only panel decision).
- **WebGL2 fallback** must keep working alongside WebGPU (project invariant).

## Testing

- `npx tsx scripts/verify-ir-poc.ts` — GLSL↔IR parity for all 7 alpha ops and
  the premultiplied final write.
- `npx tsx scripts/validate-wgsl-multipass.ts` — WGSL still compiles on GPU for
  affected node/pass combinations.
- `npm run lint`, `tsc`.
- Live check on **both** backends via `window.__sombra`:
  - an `a < 1` graph shows through the checker and the solid-color backdrop;
  - an existing opaque graph is pixel-unchanged;
  - background panel modes switch without recompiling the shader;
  - a shared/embed URL renders transparent over a host page.

## System-wide checklist touched

Fragment Output node (both codegen paths) · `isValidConnection` ·
`type-coercion.ts` · both renderers · `settingsStore` ·
`PreviewToolbar` / `PreviewPanel` · `BROWSER-AUTOMATION.md` (node input/param
change) · design-system pipeline (only if the bg panel needs a new control).

## Out of scope (future specs)

- A richer compositing/layer node family (Porter-Duff over/in/atop across two
  full RGBA streams). The Alpha-op dropdown here covers coverage math on a
  single output; multi-layer compositing is a separate feature.
- Baking a chosen background color into the export.
