# Wired Param Row (+ Wired Tooltip)

## Overview

| Field | Value |
|---|---|
| Figma ID | [`998:6114`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6114) (component set, Option D variants), [`999:6115`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-6115) (Wired Tooltip), hover instance [`999:7576`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-7576). Board: [`999:6139`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-6139) "Wired param display — options" |
| Figma Page | Components |
| Type | COMPONENT_SET + COMPONENT |
| Variants | Option = A / B / C / **D** × Kind = float / color / mask × Source = constant / animated / per-pixel (24; 6 per option). Only **Option D** is mirrored in the DB — the owner chose it; A–C stay on the board as the record of the decision |
| React File | `src/components/WiredParamRow.tsx` |
| React Component | `WiredParamRow` |
| DS Key | `wiredParamRow` |
| Sandbox | `sandbox.html?c=wired-param-row` |
| Gate | `npm run verify:wired-param-row-ui` (headless Chrome, no GPU) |
| Status | Component + sandbox, and **wired into the editor for direct constant sources (step one, on branch `feat/wire-param-row-step1`, not yet deployed)**: Number, Color and Random (min/max/decimals unwired) → body and Transform rows. Chains, Time and per-pixel sources keep the plain `← Source` header; Stack opacity/mask not yet. Gate: `npm run verify:wired-row-editor-ui`. Every slider row is 50px wired or not (pinned by the gate) |

What a connectable parameter's row shows while a wire drives it. Today the row
either shows the stale slider value greyed out, or just the source name. Option D
("Live indicator") shows **the value the parameter actually gets** and how it
behaves, in the same row height, with the handle where it was.

## Behaviour the design settled

| Source | Line one (label · `← Node.output` · value) | Line two (the track slot) |
|---|---|---|
| Constant float (`Scale ← Number.value`) | the exact number, `1.50` | the track with a tick at the value |
| Time-driven float (`Gap ← Time.time`) | the current number, ticking | a sparkline of the last ~2 s, ending in a "now" dot |
| Per-pixel float (`Gap ← Noise.value`) | `0.12–0.88` (muted) when min/max are known; else `varies` | track + a min–max bar with end ticks (bar only when known) |
| Constant colour (`Color A ← Color.color`) | swatch (over a checkerboard) + hex (`#RRGGBB`, `#RRGGBBAA` when alpha < 1) | a solid strip of the colour, over the checkerboard |
| Per-pixel colour (`Color B ← Gradient.color`) | struck-out swatch + `varies` | a strip of sampled colours (plain track when unknown) |
| Stack opacity | as constant / animated / per-pixel float, range 0–1 | as float |
| Stack mask | the 20px labelled-port row: `Mask ← Noise.value` | a 36px range bar at the end of the line |
| Transform rows | the same rows inside the Transform section | — |

- **Hover** (or keyboard focus — the row is the one tab stop): faint row tint
  (`interactive/hover`) and the tooltip "Driven by Node.output." / "Disconnect to
  edit.". Screen readers get the same through `aria-describedby`, and the row's
  `aria-label` reads "Scale ← Number.value: 1.50".
- **No editable control**: no input, slider or button. The row ignores drag and
  click (in a node, a drag on it drags the node).
- **Reduced motion**: the sparkline is drawn once and not redrawn while
  `prefers-reduced-motion: reduce`; the number still updates. Transitions off.

## Props

| Prop | Meaning |
|---|---|
| `label` | Param label ("Scale") |
| `kind` | `'float' \| 'color' \| 'mask' \| 'opacity'` |
| `source` | `{ node, output }` → `← Node.output` and the tooltip |
| `value` | `{mode:'constant', value: number \| [r,g,b,a]}` · `{mode:'animated', value, history}` (history oldest → newest) · `{mode:'varies', min?, max?, palette?}` (palette = CSS colours) |
| `range` | The param's slider range, to place the tick and the range bar. Default `[0, 1]`. **Not in the brief's prop list** — the tick and the bar need it (Figma places `1.50` at 36% of Scale's 0.1–4) |
| `formatValue` | Number → text. Default two decimals |
| `handle` | Slot: the node passes its React Flow handle (the sandbox, a dot) |
| `hint` | Second tooltip line, default "Disconnect to edit." |
| `tooltipOpen` | Controlled tooltip + tint (fixtures); undefined = hover / keyboard focus |

The component is pure: no store, no React Flow, no clock. It renders what it is
given; the caller decides the update rate (see the plan: ~10 Hz).

## Anatomy

| Part | Figma node | Code |
|---|---|---|
| `root` / `rootHover` | `998:6034` / `999:7576` (hover instance) | row: `relative flex-row items-center`; hover adds `bg-hover rounded-sm` |
| `content` | `998:6037` | `flex-col pl-handle-offset pr-xs gap-2xs` |
| `labelLine` | `998:6038` | `flex-row items-center gap-xs h-[18px]` |
| `label` / `source` | `998:6039` / `998:6040` | `text-param` fg-subtle / fg-muted (source truncates) |
| `valueGroup` / `valueGroupColor` | `998:6041` / `998:6080` | gap xs / gap sm |
| `value` / `valueMuted` | `998:6042` / `998:6067` | `text-mono-value` fg / fg-muted |
| `indicator` | `998:6043` | 16px slot (`h-icon-sm`), full width |
| `track` / `trackDim` | `998:6044` / `998:6056` | surface-raised, `h-slider-track`, rounded-full; dim = 50% under a sparkline |
| `tick` | `998:6045` | 2×12 fg-dim, radius xs |
| `sparkline` | code only (VECTOR `998:6057`) | SVG polyline, `stroke=currentColor` (indigo-hover), 1.25px non-scaling |
| `nowDot` | `998:6058` | 5px indigo-hover dot on the last point |
| `rangeBar` / `rangeEnd` | `998:6070` / `998:6071` | fg-muted bar; 2×12 fg-subtle ends |
| `swatch` / `swatchNone` / `swatchSlash` | `998:6081` / `998:6093` / code only (LINE `998:6094`) | 14px, radius xs, edge border; none = surface-alt + a fg-muted diagonal |
| `colorStrip` | `998:6084` | colour layered over the checkerboard in one background |
| `palette` / `paletteSample` | `998:6098` / `998:6099` | rounded strip of equal samples |
| `maskRoot` / `maskContent` / `maskLabel` | `998:6105` / `998:6108` / `998:6109` | the labelled-port row; `text-handle` fg |
| `maskRange` / `maskRangeTrack` / `maskRangeFill` | `998:6111` / `998:6112` / `998:6113` | 36×6 slot; 4px track and fill |
| `tooltip` / `tooltipMessage` / `tooltipHint` | `999:6115` / `999:6116` / `999:6117` | surface-raised, edge border, radius md, `px-md py-sm gap-2xs`, shadow `0 6 16 -4 rgba(0,0,0,.5)`; body fg / param fg-subtle |

No part is anchored to a layer inside an instance (`I…;…` ids): the audit would
have to round-trip to the Figma server for each and times out. `sparkline` and
`swatchSlash` are code-only (`figmaNodeId: null`) because the DB has no vocabulary
for an SVG/LINE stroke: the generator would emit `border-*` classes on them.

Reused, not rebuilt: the Handle look (slot), Float Slider typography (`text-param`
label, `text-mono-value` value), the slider-track token, the Labeled Handle row
(mask), the swatch checkerboard (`CHECKER_STYLE`, now exported from
`ColorSwatch.tsx`).

## Geometry

- Content = 18 (label line) + 2 + 16 (indicator) = 36px, centred in a fixed
  **50px** row (`wiredParamRow.root` `h-[50px]`) — the same 50px as the unwired
  slider row (`connectableParamRow.sliderRow`, Figma 106:303), whose Float Slider
  is 20 + 2 + 16 (track area 106:281) = 38px. Body rows, Transform rows and Stack
  opacity all use it, so nothing moves when a wire lands (2026-11-27: code matched
  to Figma; it had drawn the slider at 27.5 and the rows at 27.5 / 36).
  Mask = the Labeled Handle row (19.5px). Measured by the gates.
- Figma draws handles in-flow (12px column, then 10px pad → text at 22); code
  centres the handle on the content edge (`pl-handle-offset` → text 10px from the
  handle centre). Same convention as Stack Layer / Section Header.
- Tooltip: 4px below the row, 34px in from the handle centre
  (`top-full mt-xs left-handle-offset ml-2xl`), as on the board (row x+40, y+54).
  Max 240px wide; long source names wrap.

## Ambiguities and choices made

1. **"varies" vs the range text.** The brief says per-pixel shows "varies" with a
   range bar; the Figma variant shows the range itself (`0.12–0.88`) in the value
   slot. Built as Figma: with min/max known, the slot reads `0.12–0.88` and is
   spoken "varies, 0.12–0.88"; without, it reads `varies`.
2. **Per-pixel colour with no palette** and **mask with no range**: Figma always
   shows them filled. Built with a plain track / empty mask bar when unknown.
3. **Reduced motion** keeps the number ticking and freezes only the sparkline
   (text replacing text is not motion). The "now" dot stays at the frozen end.
4. **Hover tint covers the row from the content edge**; on the board the tinted
   instance also covers the in-flow handle column. Same tint, 6px narrower.
5. **Mask hover** uses `rootHover` (the mask variant has no hover instance on the
   board; the structure is identical).
6. Non-colour `value` given a colour, or a colour given a number, is coerced
   (first channel / grey) rather than thrown.

## Audit

`tokens:audit` clean. Ignores, each "intentional and unrepresentable in Figma"
(`.claude/ds-queue.md` is gitignored, so the reasons live here):

- `rootHover` → `fill.opacity`, `height` ([`999:7576`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-7576)): the `interactive/hover` variable already carries its 6% alpha, which Figma reports as paint opacity (adding it would double-apply); the instance is the FIXED 50px board row, code height comes from the content.
- `indicator`, `track`, `trackDim`, `colorStrip`, `palette` → `width` ([`998:6043`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6043) …): FIXED 168 in a 194px variant; code fills the column (`w-full` / `inset-x-0`), so it works at any node width.
- `rangeBar`, `maskRangeFill` → `width` ([`998:6070`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6070), [`998:6113`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6113)): runtime — min..max of the source.
- `swatch`, `colorStrip`, `paletteSample` → `fill` ([`998:6081`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6081), [`998:6084`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6084), [`998:6099`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6099)): the user's colour / sampled colours (Figma shows placeholders).
- `maskContent` → `padding.left` ([`998:6108`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=998-6108)): Figma 6 after an in-flow handle column; code `handle-offset` from the content edge, matching Labeled Handle.

Every ignore was proven necessary: with all removed the audit reports exactly
these keys (and nothing else), and the ignores Figma did not need (`overflow` on
the swatches/palette) were dropped.

## Gate — `npm run verify:wired-param-row-ui`

Headless Chrome on the sandbox (Vite on port 0, no GPU). Each check pairs the
outcome with proof the mechanism ran: heights against the real unwired DS rows in
the same node (and the reference really holds a slider track); the constant tick
moves with the value prop; the animated number and sparkline change over real
time with the "now" dot on the last point; the range bar sits at min..max and
disappears when max becomes unknown; no input/select/button/slider inside any
fixture's row (query proven live on the harness's own inputs); hover and keyboard
tooltips with exact text and `aria-describedby`; the colour swatch decoded from a
real screenshot shows two checker composites at alpha 0.5 and a uniform `#FBBF24`
when opaque; reduced motion freezes the sparkline while the number keeps ticking.

11/11 green. Each assertion was perturbed in the component, one at a time, and
went red on exactly its own check (then restored, green again):

| Perturbation | Red check |
|---|---|
| constant value text emptied | constant — `got ""` |
| `py-2xs` added to the content | height — `expected 36 ±0.5, got 40` |
| sparkline never frozen | reduced motion — not marked frozen |
| frozen flag kept, geometry still redrawn | reduced motion — geometry changed |
| tooltip never mounted | hover + keyboard — no `role=tooltip` |
| swatch fill forced opaque | colour — fill `rgb(251, 191, 36)` |
| swatch fill hidden (computed colour unchanged) | colour — decoded pixels untinted (checker greys only) |
| a `<button>` added to the row | no interactive control — `button` |

## Plug-in plan (later job — not built)

### Where each value would come from in the running editor

**(a) Constant sources.**
- Direct wire from **Number** (`float_constant`): `params.value` — already done by
  `resolveSourceFloat()` in `ShaderNode.tsx` (it handles only this type).
- Direct wire from **Color** (`color_constant`): `params.color` (RGBA 0–1).
- **Random**: constant per seed — `min + fract(seed + hashNodeId(id)) * (max − min)`,
  rounded to `decimals`. `RandomDisplay.tsx` already computes exactly this on the
  CPU (it mirrors `random.ts`'s `toFixed(6)` hash).
- **Chains** (Number → Multiply, Time → Sin) need an evaluator. Nothing in the
  editor evaluates a chain on the CPU today. Two ways:
  1. *CPU twins per node type.* Trivially evaluable (pure functions of inputs and
     params, no coordinates, no textures): Arithmetic (add/subtract/multiply/divide,
     N dynamic inputs), Trig (sin/cos/tan/abs × frequency × amplitude), Remap,
     Clamp, Smoothstep, Power, Round (floor/ceil/fract/round/sign), Mix, Combine /
     Split Vec2/Vec3, plus the sources Number, Color, Random, Time, Resolution.
     The colour adjusts (Invert, Grayscale, Brightness/Contrast, Hue Shift,
     Posterize, HSV→RGB) are also pure on a constant colour. ~15 lines per node →
     ~180 lines for the first tier + a graph walk (~60) + a parity gate (~150).
     Cost: a **third** copy of each node's maths (GLSL, IR, CPU) — exactly the
     drift the guardrails warn about; the gate would have to compare against the
     GPU.
  2. *Interpret the IR (recommended for chains).* `src/compiler/ir/types.ts` has
     11 kinds that matter: expressions `literal, variable, binary, call, swizzle,
     construct, ternary` and statements `declare, assign, for, if`. A JS
     interpreter for those plus ~25 GLSL builtins is ~250 lines and reuses each
     node's single `ir()` source. It also answers *"is this per-pixel?"*
     mechanically: any reachable `fragCoord`, `textureSample`, `raw()` (shared
     noise helpers), or an unconnected `auto_uv` default ⇒ per-pixel; a read of
     `u_time` ⇒ animated; else constant. The worker already builds "the subgraph
     up to node X" in IR form for thumbnails (`ir-subgraph-compiler.ts`); the
     same entry point aimed at the wired source + output gives the statement
     list. The worker would return, per wired input, the classification and that
     list; the main thread evaluates it (once for constants, ~10 Hz for
     animated) with live uniform values from the graph store. Cost ~1.5–2 days
     with its gate. Precision: JS doubles vs GPU fp32 — invisible at two decimals.
  Worth it: Time → Sin → param is the common way to animate in Sombra, and a
  constant chain shown as "varies" would be wrong.

**(b) Time.** Time's output is `u_time × speed` (`time.ts`). The editor's main
renderer computes `u_time = (Date.now() − startTime) / 1000`, `startTime` set at
construction (`webgpu/renderer.ts:190`, `webgl/renderer.ts:124`); each preview
renderer has its **own** `startTime`; there is no getter. Only the embed player
owns its clock, through `setTimeSource()` (both backends; documented "the editor
never calls it"). Recommended: the editor creates one clock
`() => (performance.now() − t0) / 1000`, installs it with
`renderer.setTimeSource(clock)` right after `createShaderRenderer` in `App.tsx`,
and the wired rows read the same function — one source of truth, and pausing
later is free. (Check that device-loss rebuild keeps the time source.) The value
shown is `clock() × speed`, `speed` itself resolved like any input.
**History:** one shared 10 Hz sampler (not per row) keeps a ring buffer of 20
samples (~2 s) per wired animated input in a module store; rows subscribe with
`useSyncExternalStore`, so only wired rows re-render, 10×/s, never through the
graph store. Under reduced motion the row already freezes the sparkline.

**(c) Per-pixel sources (range, palette).** The per-node thumbnails already read
every preview back to the CPU — WebGL2 `gl.readPixels` into `readBuf`
(`webgl/preview-renderer.ts:250`, `:434`), WebGPU `stagingBuffer.mapAsync` →
`Uint8Array` (`webgpu/preview-renderer.ts:535–551`) — before building the
ImageBitmap. Min/max (float) or a palette (colour) over those 6,400 pixels at
that point costs well under 0.1 ms and **no extra GPU readback**; the renderer
would return `{bitmap, stats}` and the scheduler would store `stats` beside the
bitmap in `previewStore`. Cadence: static thumbnails refresh when their node goes
stale (an upstream edit; 4 compiles per frame, worker latency — the range lags an
edit by a few frames); time-live ones every 200 / 500 / 1000 ms by canvas size.
Parity: both backends use `rgba8unorm`, so the numbers agree. **Limits, all
real:**
1. **Clamped and 8-bit.** A float preview is `vec4(vec3(v), 1)` into RGBA8
   (`outputTypeToFragColor`), so values outside 0–1 clip and precision is 1/255.
   `Noise × 10` would read `0.00–1.00`. Guard: show the range only when neither
   end is saturated, else plain `varies`; or render a small `r32float` stats
   target instead (a new pass + 25 KB readback).
2. **First output only.** The thumbnail is the source node's `outputs[0]`
   (`subgraph-compiler.ts:150`), not necessarily the wired output.
3. **Framing.** 80×80 at the reference size, not the live canvas framing — an
   estimate of the range, as the board says.
4. **No thumbnail** for `hidePreview` nodes: Number, Time, Random, Vec2,
   Resolution, Image, Split Vec2/Vec3 (and Output). Image and Split-of-per-pixel
   fall back to `varies`.

### Recommended minimal first version (~1 day)

1. A `wired-values` module (outside the component): direct **Number / Color /
   Random** wires → exact constants (existing code paths above).
2. Direct **Time** wires → editor clock via `setTimeSource` + the 10 Hz ring
   buffer.
3. Everything else → `varies` with no range/palette, **but only when the chain
   really is per-pixel** — a node-type walk upstream (any noise / pattern / UV /
   image / distort / blur node, or an unconnected `auto_uv` input). A non-per-pixel
   chain the first version cannot evaluate needs a decision: show `varies`
   (wrong) or a fourth "not evaluated" look (source only, `—`, plain track — a
   small component addition). Owner call.
4. Then v2: the IR interpreter for chains (b/c above). v3: thumbnail stats for
   ranges and palettes, with the saturation guard.

### Display paths it replaces (scope for the wiring job)

| Where | Today | Becomes |
|---|---|---|
| `ShaderNode.tsx` body params (~500–598) | wired Number → disabled `FloatSlider` at the resolved value; any other wire → label + `← Source` header (`connectedHeader`); colour params the same header | `WiredParamRow` whenever `isConnected`, handle = the row's `BaseHandle` in the slot. Decide body-row height (see Geometry). The "High value" warning should read the effective value |
| `ShaderNode.tsx` Transform rows (~605–665) | disabled `FloatSlider` at the **stored** (stale) value | `WiredParamRow` per wired SRT row inside `TransformSection` (no change to the section header/gather logic). Node-view offset sliders mix X and Y: if either is wired, the shown node-frame offset needs both effective values |
| `StackLayerList.tsx` opacity (~277–288) | `← source` header | `WiredParamRow kind="opacity"`; `StackNodeBody` must pass `{node, output}` + value instead of the `opacitySource` string. Keep the hidden-layer `dimmed` wrapper |
| `StackLayerList.tsx` mask (~291–296) | Labeled-handle row, source only in a `title` | `WiredParamRow kind="mask"` when `maskSource` is set |
| `NodeParameters.tsx` (`NodeParameters`, ~55–67) | the same two looks | Not rendered anywhere today (dead) — delete or migrate in the same job |
| Gizmos: `SrtGizmoOverlay.tsx`, `PreviewGizmoOverlay.tsx` | draw handles at `node.data.params` (stored values) and let a wired param be dragged with no effect | Owner-decided, Figma [Gizmo Handle `999:6138`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-6138) (Kind × State free/wired), board panel [`999:7608`](https://www.figma.com/design/rkjKvEFljv5OkNzmAIHKVa/Sombra?node-id=999-7608): a wired handle stays where the wire puts it (effective value from the same `wired-values` source, moving with Time), greyed and inert; hovering names the wire ("Rotate is driven by Time.time." / "Disconnect to edit.", the Wired Tooltip). Scale + rotate wired → ring, rotate dot and scale square grey; move handles live. Offset X wired → X tip and the centre grey (a free move would change X), Y tip keeps its one-axis drag. `PreviewGizmoOverlay` points bound to a wired param follow the same rule. Open: a **per-pixel**-wired SRT param has no single position — hide its handle or grey it at the stored value? |
