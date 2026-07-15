# RGBA Node-Port Audit (Task 1)

Classification of every port on all 41 `NodeDefinition`s in `src/nodes/*/*.ts`, in prep for
making `color` an RGBA (`vec4`) type. This is a read-only audit — no node/compiler code was
changed.

**Method:** read every node file's `inputs`/`outputs` plus its `glsl()`/`ir()` bodies to judge
whether each `vec3` (or `vec4`) port genuinely carries RGB(A) color, or whether it's data
(coordinates, HSV components, directions, scalar masks) that must not be reclassified.

**Scope note:** `src/nodes/noise/noise-functions.ts` is a shared codegen helper (GLSL/IR noise
function registration used by Noise, FBM, Warp, Reeded Glass) — it exports no `NodeDefinition`
and is excluded from the table below. The 41 node files are everything else under
`src/nodes/<category>/*.ts` excluding `types.ts`, `registry.ts`, `index.ts`, `type-coercion.ts`.

**Port-type baseline (from `src/nodes/types.ts` / `type-coercion.ts`):** `PortType` includes
`'color'` as "alias for vec3, UI shows color picker," but **no port in any of the 41 nodes
currently declares `type: 'color'`** — every color-carrying port is declared `type: 'vec3'`
(the `'color'` value is only used today as a `NodeParameter` type, e.g. `color_constant`'s
`color` param, which drives the color-picker UI control, not a port). The **only** `vec4` port
in the entire node set is `fragment_output`'s `color` input. This matters for Task 2+: the
`'color'` `PortType` alias is unused for ports today and free to redefine as the new vec4
color type without touching an existing port declaration; then each row below marked
"Generator/Channel transform/Color-space/Blend/Spatial" needs its `vec3` ports changed to
`'color'`.

---

## Table

| Node (`type`) | Color inputs (id:type) | Color outputs (id:type) | Category | Alpha rule | Notes |
|---|---|---|---|---|---|
| `brightness_contrast` | `color:vec3` | `result:vec3` | Channel transform | edits all channels (would apply brightness/contrast formula to `.a` too) | `glsl`: `(color - 0.5) * (1.0 + contrast) + 0.5 + brightness` — pure per-component arithmetic, generalizes to vec4 trivially. |
| `color_ramp` | — (`t:float` value, not color) | `color:vec3` | Generator | ramp stops need an alpha channel added | Builds `vec3` via chained `mix()` over `ColorStop[]` (`{position, color:[r,g,b]}`). Migrating to RGBA means extending `ColorStop.color` to `[r,g,b,a]` — a data-shape change, not just a port-type change. |
| `grayscale` | `color:vec3` | — (`result:float`, a scalar, not a color) | Color-space op | N/A on output — output isn't vec3/vec4 | All 3 modes (`luminance` dot-product, `average`, `lightness`) reduce `vec3`→`float`. Input becomes `color:vec4` reading `.rgb` only, unaffected by alpha (alpha isn't in this "space"). Output stays `float`; nothing to migrate there. **Note:** despite the node's name suggesting a "grayscale color" op, it outputs a bare luminance/brightness value used as a mask, not a `vec3` grayscale color — worth flagging since the task brief's own examples assume a color-in/color-out grayscale. |
| `hsv_to_rgb` | — (`h:float`, `s:float`, `v:float` — three independent scalars, not a combined HSV vec3) | `rgb:vec3` | Generator | no alpha available; RGBA output defaults `a=1.0` | `glsl2rgb` builds `vec3 c = vec3(h,s,v)` **internally** inside the function body, but this is a local variable, not a port — there is no HSV `vec3` **port** anywhere in this node to misclassify. Only the `rgb` output port is a real color. |
| `invert` | `color:vec3` | `result:vec3` | Channel transform | edits all channels (`vec4(1.0) - color`, alpha included) | `vec3(1.0) - color` — trivially generalizes to `vec4(1.0) - color`. Spec's own canonical Channel-transform example. |
| `posterize` | `color:vec3` | `result:vec3` | Channel transform | edits all channels (`floor(color*levels)/(levels-1)` applies to `.a` too) | Per-component quantization; generalizes to vec4 directly. |
| `pixelate` | `source:vec3 (textureInput)` | `color:vec3` | Spatial | alpha rides with sample — **currently dropped**: `texture(sampler, uv).rgb` discards `.a` | Non-color port: `uv:vec2` output (frozen-ref UV for downstream nodes) — coordinate data, not color. Fallback (no source wired) is a checkerboard `vec3`, not real color data — still a legitimate color-typed port, just synthetic. |
| `polar_coords` | `source:vec3 (textureInput)` | `color:vec3` | Spatial | alpha rides with sample — **currently dropped**: `.rgb` only | Non-color ports: `coords:vec2` (input, UV), `polar:vec2` (output, `(r, theta)` polar coordinates) — both coordinate data, never color. |
| `tile` | `source:vec3 (textureInput)` | `color:vec3` | Spatial | alpha rides with sample — **currently dropped**: `.rgb` only | Non-color ports: `coords:vec2` (input, UV), `uv:vec2` (output, tiled/mirrored UV). No-source fallback outputs `vec3(uv, 0.5)` — a UV-debug visualization, still typed as the `color` port (synthetic, not real color data, but the port itself stays `color`). |
| `warp` | `source:vec3 (textureInput)`, `phase:float` (data, not color) | `color:vec3` | Spatial | alpha rides with sample — **currently dropped**: `.rgb` only | Non-color ports: `coords:vec2` (input, UV), `warped:vec2` (output, distorted UV), `warpedPhase:float` (output, distorted phase). `phase` input/`warpedPhase` output are float animation-phase data, not color. No-source fallback: `vec3(warped, 0.5)` distortion-visualization, same synthetic-but-color-typed situation as `tile`. |
| `color_constant` | — | `color:vec3` | Generator | swatch needs alpha slider added | Param `color` is `NodeParameter` type `'color'` (color-picker UI), default `[1,0,1]` (magenta) — a genuine RGB swatch. Straightforward RGBA candidate: add an alpha slider to the swatch UI + param shape `[r,g,b,a]`. |
| `float_constant` | — | — (`value:float`) | Non-color | N/A | Pure scalar constant. |
| `image` | `coords:vec2` (data, UV) | `color:vec3` **+ separate `alpha:float` output port** | Generator | **already splits color/alpha into two ports** rather than one vec4 | Samples `texture(...).rgb` into `color` and `.a` into a **separate `alpha` port**. This is the one existing place alpha already flows through the graph, just via a second port instead of `.a` on a single vec4 port. Later migration tasks should decide whether to collapse `color`+`alpha` into one `color:vec4` output (breaking existing save-file wiring / requiring a migration shim) or leave the two-port shape as-is and only add alpha to synthesize the vec4 downstream. Flagging for the design/migration task, not resolving here. |
| `random` | — | — (`value:float`) | Non-color | N/A | Deterministic pseudo-random float, no color ports. |
| `resolution` | — | — (`resolution:vec2`) | Non-color | N/A | Canvas resolution, vec2 data. |
| `time` | — | — (`time:float`) | Non-color | N/A | Scalar time uniform. |
| `uv_transform` | `coords:vec2` (data) | — (`uv:vec2`) | Non-color | N/A | SRT transform on UV coordinates; no color ports at all. |
| `vec2_constant` | — | — (`value:vec2`) | Non-color | N/A | Generic constant 2D vector (not UV-specific, but still not color-space — vec2 is outside the RGB(A) family entirely). |
| `arithmetic` | — (`in_0..in_7:float`) | — (`result:float`) | Generic math | N/A today | Dynamic 2–8 float inputs, `+ - * /`. No vec3 support currently — would need a vec3/vec4 variant to ever touch color, per spec's own "operate on whatever vec flows" framing. |
| `clamp` | — (`value:float`) | — (`result:float`) | Generic math | N/A today | Float-only `clamp(value, min, max)`. |
| `mix` | `a:vec3`, `b:vec3` | `result:vec3` | Blend | **blends alpha via the same `factor`** (`mix(a.a, b.a, factor)`) | Spec's canonical Blend example. `factor:float` param is not color — it's the blend weight. |
| `power` | — (`base:float`) | — (`result:float`) | Generic math | N/A today | `pow(base, exponent)`, float-only. |
| `remap` | — (`value/inMin/inMax/outMin/outMax:float`) | — (`result:float`) | Generic math | N/A today | All 5 ports float; range remap. |
| `ridged` | — (`value:float`) | — (`result:float`) | Non-color | N/A | `pow(1 - abs(value*2-1), 2)` — standalone remap of a scalar signal (noise/pattern post-process). File lives in `src/nodes/math/` but `category: 'Distort'` internally; still float-only, matches spec's explicit "ridged...scalar outputs" Non-color example. |
| `round` | — (`value:float`) | — (`result:float`) | Generic math | N/A today | `floor/ceil/fract/round/sign`, float-only. |
| `smoothstep` | — (`x:float`) | — (`result:float`) | Generic math | N/A today | `smoothstep(min, max, x)`, float-only. |
| `trig` | — (`value:float`) | — (`result:float`) | Generic math | N/A today | `sin/cos/tan/abs`, float-only. |
| `turbulence` | — (`value:float`) | — (`result:float`) | Non-color | N/A | `abs(value*2-1)` — same standalone-remap shape as `ridged`; `category: 'Distort'` internally, float-only. Matches spec's explicit "turbulence...scalar outputs" example. |
| `fbm` | `coords:vec2` (data), `phase:float` (data) | — (`value:float`) | Non-color | N/A | Multi-octave fractal noise; scalar output, matches spec's explicit "noise/fbm...scalar outputs" example. |
| `noise` | `coords:vec2` (data), `phase:float` (data) | — (`value:float`) | Non-color | N/A | Configurable noise (simplex/value/worley/box); scalar output. |
| `fragment_output` | `color:vec4` **(already vec4 — the only vec4 port in the codebase)** | — (terminal node, no outputs) | **Sink (special — pre-existing vec4)** | already computes `fo_a = clamp(alphaCombineExpr(color.a, alpha_param, alphaOp), 0, 1)`, then `fragColor = vec4(color.rgb * fo_a, fo_a)` | This is the anchor the whole RGBA migration flows toward — it already accepts `vec4` and already has alpha-combine logic (`alphaOp` param: replace/multiply/max/add/subtract/min/difference against the `alpha` param). Doesn't fit the 7-category taxonomy cleanly; called out separately so later tasks don't try to "migrate" it — it's already done. |
| `checkerboard` | `coords:vec2` (data) | — (`value:float`) | Non-color | N/A | Outputs hard 0/1 mask via `mod(floor(coords).x+.y, 2)`. Matches spec's "pattern nodes that output a scalar mask." |
| `dots` | `coords:vec2` (data) | — (`value:float`) | Non-color | N/A | Circle-grid scalar mask via `smoothstep` on cell distance. |
| `gradient` | `coords:vec2` (data) | — (`value:float`) | Non-color | N/A | linear/radial/angular/diamond — all scalar 0–1 outputs. |
| `stripes` | `coords:vec2` (data) | — (`value:float`) | Non-color | N/A | Repeating-band scalar mask via double `smoothstep`. |
| `dither` (file `postprocess/pixel-grid.ts`) | `color:vec3` | `result:vec3` | Spatial | mask should multiply alpha too (`result = color * mask` → `result.rgb = color.rgb*mask, result.a = color.a*mask`) | Explicitly named in the task brief's Spatial examples (`pixel_grid`). No `textureInput` port — doesn't resample a texture itself, just multiplies the already-sampled `color` by a computed Bayer-dither + shape-SDF mask (0 or 1, or dithered edge). Functionally closer to a channel-wise masking multiply than true resampling, but the brief classifies it as Spatial and the "mask rides through all channels incl. alpha" rule applies either way. |
| `reeded_glass` | `source:vec3 (textureInput)` | `color:vec3` | Spatial | alpha rides with sample — **currently dropped**: both the frost-blur accumulation loop and the plain sample path only read `.rgb` | Non-color port: `coords:vec2` output (distorted lens coordinates, always populated even without a texture source) — coordinate data, not color. Explicitly named in the brief's Spatial examples. |
| `combine_vec2` | — | — (`vector:vec2`) | Non-color | N/A | Compose two floats into a vec2 — outside the RGB(A) family entirely (vec2), no ambiguity. |
| `combine_vec3` | — | `vector:vec3` **(AMBIGUOUS — see below)** | Non-color (best guess) | N/A if left generic | Generic X/Y/Z→vec3 constructor. `vec3` output is freely coercible to `color`/`vec4` elsewhere in the graph (see `type-coercion.ts`: `vec3`↔`color` is a no-op cast), so a user could legitimately wire R/G/B float sliders through `combine_vec3` into a color-consuming node. Classifying as Non-color/generic per the task brief's explicit "vector split/combine" example, but flagging as genuinely dual-use — **do not** auto-migrate this port to `color` type, since it would also incorrectly relabel non-color vec3 uses (e.g. combining arbitrary XYZ data) as color. |
| `combine_vec2` / `split_vec2` | — | — | Non-color | N/A | vec2 only, never in the color family. |
| `split_vec3` | `vector:vec3` **(AMBIGUOUS — see below)** | — (`x/y/z:float`) | Non-color (best guess) | N/A | Mirror case of `combine_vec3` — decomposes any vec3, including one that happens to hold RGB. Same reasoning: leave as generic vec3, do not reclassify as `color`. |

---

## Summary — counts per category

| Category | Count | Nodes |
|---|---:|---|
| Generator | 4 | `color_constant`, `image`, `color_ramp`, `hsv_to_rgb` |
| Channel transform | 3 | `brightness_contrast`, `invert`, `posterize` |
| Color-space op | 1 | `grayscale` |
| Blend | 1 | `mix` |
| Spatial | 6 | `pixelate`, `polar_coords`, `tile`, `warp`, `dither`, `reeded_glass` |
| Generic math | 7 | `arithmetic`, `clamp`, `power`, `remap`, `round`, `smoothstep`, `trig` |
| Non-color | 18 | `float_constant`, `random`, `resolution`, `time`, `uv_transform`, `vec2_constant`, `ridged`, `turbulence`, `fbm`, `noise`, `checkerboard`, `dots`, `gradient`, `stripes`, `combine_vec2`, `combine_vec3`, `split_vec2`, `split_vec3` |
| Sink (special, already vec4) | 1 | `fragment_output` |
| **Total** | **41** | |

## `vec3` ports that are DATA, not color (must NOT be migrated to `color`/`vec4`)

Every `vec3` port in the 41-node set that is not listed here is a genuine RGB color port and
is a migration candidate. The following are the exceptions:

1. **`combine_vec3.vector` (output, vec3)** — generic X/Y/Z vector constructor. Reason: not
   color-specific; freely coercible into color-consuming ports via the existing `vec3`↔`color`
   coercion rule, so it's used for both color composition and arbitrary 3D data depending on
   graph context. Marked AMBIGUOUS below rather than a clean "data" call.
2. **`split_vec3.vector` (input, vec3)** — mirror of the above; decomposes any vec3, not
   specifically color.

That's it — no HSV-triple `vec3` port, no coordinate/direction `vec3` port, and no scalar-mask
`vec3` port exists anywhere in the current 41 nodes. (`hsv_to_rgb`'s H/S/V are three independent
`float` ports, not a combined `vec3`, so there's no HSV `vec3` port to worry about, contrary to
what the task brief's own example anticipated.)

## Ambiguous nodes

- **`combine_vec3`** and **`split_vec3`** (see above) — generic vec3 construct/decompose,
  dual-use for color or arbitrary vector data. Best-guess classification: **do not** migrate
  their ports to `color` type; leave as plain `vec3`. If a later task wants "compose a color
  from R/G/B(+A) sliders" as a first-class node, that should probably be a **new** node type
  (e.g. `combine_color`) rather than repurposing `combine_vec3`, to avoid breaking existing
  graphs that use `combine_vec3` for non-color vec3 data.
- **`grayscale`** — not ambiguous in classification (Color-space op, input color / output
  float), but flagged because its actual shape (color→scalar mask) surprised expectations set
  by the task brief's own phrasing ("Color-space op — preserves alpha (grayscale, hsv
  conversions) because alpha isn't in that space" reads as if grayscale outputs a color;
  in this codebase it outputs a bare `float`).
- **`image`** — not ambiguous in category (Generator), but flagged because it already
  represents color+alpha as **two separate ports** (`color:vec3` + `alpha:float`) rather than
  one `vec4`. Later migration tasks need to decide whether to collapse these into a single
  `color:vec4` output (a breaking wiring change) or leave the split and just synthesize vec4
  downstream from the two ports.

## Surprising findings

- **No node currently uses `PortType: 'color'`.** The type exists in `types.ts` as "alias for
  vec3, UI shows color picker" but is applied only to a `NodeParameter` (e.g. `color_constant`'s
  swatch param), never to an actual port. Every color port in the codebase today is declared
  `type: 'vec3'`.
- **`fragment_output` already takes `vec4`** and already has alpha-combine logic
  (`alphaCombineExpr` with 7 blend modes against a connectable `alpha` param). It's the only
  vec4 port anywhere and effectively previews what the rest of the graph needs to grow into.
- **The color-carrying subset is much cleaner than expected** — of all `vec3` ports in the
  41 nodes, only `combine_vec3`/`split_vec3` are generic (non-color) rather than genuine RGB.
  No coordinate, HSV, or direction data is ever packed into a `vec3` port in this codebase.
- **Alpha is silently dropped in every texture-sampling Spatial node** (`pixelate`,
  `polar_coords`, `tile`, `warp`, `reeded_glass` in texture mode) — all sample
  `texture(sampler, uv).rgb`, discarding `.a`. This is expected/by-design today since color
  is vec3-only, but it means the RGBA migration's Spatial-node pass has real work to do beyond
  a type rename: change every `.rgb` sample in these five nodes to a full `vec4` sample.
- **`image` is the sole existing alpha-carrier**, via a second `alpha:float` output port
  rather than a 4th vec4 component — worth resolving explicitly before/during node migration.
- **Math-category float nodes (`arithmetic`, `clamp`, `mix` aside, `power`, `remap`, `round`,
  `smoothstep`, `trig`, plus `ridged`/`turbulence`) have zero color ports today** — the task
  brief's "Generic math" category is aspirational (nodes that *could* operate on whatever vec
  flows through) rather than descriptive of current behavior; nothing to migrate on them now.
