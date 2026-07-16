# Pattern Nodes — Params + Built-in Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Stripes, Dots, Checkerboard, Gradient proper real-value (pixel) params for every procedural feature plus built-in colors, each outputting `color` (primary) + `value` (float).

**Architecture:** Each node is one file in `src/nodes/pattern/` (gradient stays in `pattern/`) with parity `glsl()` + `ir()` generators. Pixel sizes convert to isotropic coord units via `u_dpr * u_ref_size` (frozen-reference → resize-stable). Colors are `type:'color'` params (vec4 uniforms) blended with `mix()`; Gradient reuses the Color Ramp stops mechanism.

**Tech Stack:** TypeScript strict, IR builders from `src/compiler/ir/types` (`variable, call, binary, literal, declare, assign, construct, swizzle`), WGSL + GLSL codegen, `@/components/ColorRampEditor` for stops.

## Global Constraints

- **WebGPU first, both backends.** Author/verify the WGSL (`ir/wgsl-backend`) path first (it renders WebGPU), then confirm both GLSL paths (`ir/glsl-backend`, legacy `glsl-generator`) via parity. Every node keeps `glsl()` + `ir()` in lockstep.
- **Pixel units** (Width, Gap, Gap X/Y, Cell Size) convert as `px / (u_dpr * u_ref_size)`. Add `u_dpr` and `u_ref_size` to the node's `standardUniforms` (IR) and `uniforms.add(...)` (GLSL). Reference as `variable('u_ref_size')` in IR, `u_ref_size` in GLSL (WGSL assembler rewrites to `uniforms.u_ref_size`).
- **Output shape:** each node's outputs are `[{id:'color', type:'color'}, {id:'value', type:'float'}]` in that order (color = primary/default). **The `value` output id is preserved** on every node so existing edges stay valid; `color→float` coercion also remains valid. Default colors are B/W so `value`/`.x` reproduces the old 0/1 field.
- **Param update modes:** numeric px/size/shape params → `connectable:true, updateMode:'uniform'`. Enums (Tile Mode) and stop-count changes → `updateMode:'recompile'`. Color params → `type:'color', connectable:true, updateMode:'uniform'`.
- **Color param defaults** are RGBA: Color A `[1,1,1,1]`, Color B `[0,0,0,1]`.
- **Verification per task (the test suite — there are no unit tests):**
  `npx tsx scripts/verify-ir-poc.ts` (GLSL↔IR parity), `npx tsx scripts/validate-wgsl-multipass.ts` (WGSL GPU compile), `npx tsc -b`, `npm run lint`, then a live check via `window.__sombra` on the running dev server (create node, `setParams`, `compile`, inspect/sample; **never** `clearGraph`). Commit at task end.
- Spec: `docs/superpowers/specs/2026-07-16-pattern-nodes-params-colors-design.md` (source of truth for ranges/defaults).

## File Structure

- Modify: `src/nodes/pattern/stripes.ts`, `dots.ts`, `checkerboard.ts`, `gradient.ts`
- Modify: `src/nodes/index.ts` (attach `ColorRampEditor` to `gradient`, mirroring the `color_ram` wiring at lines ~149-153)
- Modify (docs, final task): `BROWSER-AUTOMATION.md` (node param/output tables), `.figma/wiki/templates/node-templates.md`

Reference implementations to mirror: `color-ramp.ts` (stops param + mix-chain), `pixelate.ts` (`u_dpr`/`u_ref_size` in IR: `binary('*', variable('u_dpr'), variable('u_ref_size'), 'float')`), `warp.ts` (multi-output), `time.ts` (standard uniform in own math).

---

### Task 1: Stripes — Width/Gap (px), duty, Color A/B, dual output

**Files:** Modify `src/nodes/pattern/stripes.ts`

**Interfaces:**
- Produces: outputs `color` (color) + `value` (float). Params `width`,`gap`,`softness`,`colorA`,`colorB` + spatial.

**Params block (replace the current params):**
```ts
params: [
  ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
  { id: 'width', label: 'Width', type: 'float', default: 40, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
  { id: 'gap', label: 'Gap', type: 'float', default: 40, min: 0, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
  { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.01, connectable: true, updateMode: 'uniform' },
  { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], connectable: true, updateMode: 'uniform' },
  { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], connectable: true, updateMode: 'uniform' },
],
outputs: [
  { id: 'color', label: 'Color', type: 'color' },
  { id: 'value', label: 'Value', type: 'float' },
],
```

**Core math (GLSL; mirror in IR).** Read px inputs via `ctx.inputs.width` etc. Add `u_dpr`,`u_ref_size`.
```glsl
float period_px = max(width + gap, 0.0001);
float period    = period_px / (u_dpr * u_ref_size);        // coord units
float duty      = clamp(width / period_px, 0.0, 1.0);
float t   = fract(coords.x / period + 0.5) - 0.5;          // stripe centered at 0
float hw  = duty * 0.5;                                     // half stripe (fraction of period)
float aa  = max(softness * 0.5, 0.0001);
float band = smoothstep(hw + aa, hw - aa, abs(t));         // 1 inside stripe, 0 in gap
// outputs
float value = band;
vec4  color = mix(colorB, colorA, band);
```
Notes: `colorA`/`colorB` are vec4 (color params). `value` output = `band`.

- [ ] **Step 1:** Rewrite `stripes.ts` params + outputs + `glsl()` per above.
- [ ] **Step 2:** Mirror identically in `ir()` (build `color` via `construct`/`call('mix',...)`, `value` via the band var; `standardUniforms: new Set(['u_dpr','u_ref_size'])`).
- [ ] **Step 3:** `npx tsc -b` → passes.
- [ ] **Step 4:** `npx tsx scripts/verify-ir-poc.ts` → GLSL↔IR parity passes (stripes included).
- [ ] **Step 5:** `npx tsx scripts/validate-wgsl-multipass.ts` → stripes WGSL compiles.
- [ ] **Step 6:** `npm run lint` → clean.
- [ ] **Step 7:** Live (dev server, `window.__sombra`): create `stripes`, wire `color`→Fragment Output, set `width`/`gap`/`softness`/`colorA`/`colorB`, `compile`, confirm bands + colors render; set width=gap and confirm 50% duty. Remove the test node (no `clearGraph`).
- [ ] **Step 8:** Commit `feat: stripes — width/gap px + duty + A/B colors + color output`.

---

### Task 2: Dots — Gap X/Y (px), Aspect (shape-only), Color A/B, dual output

**Files:** Modify `src/nodes/pattern/dots.ts`

**Params block:**
```ts
params: [
  ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
  { id: 'gapX', label: 'Gap X', type: 'float', default: 60, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
  { id: 'gapY', label: 'Gap Y', type: 'float', default: 60, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform' },
  { id: 'radius', label: 'Radius', type: 'float', default: 0.3, min: 0.01, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  { id: 'aspect', label: 'Aspect', type: 'float', default: 1.0, min: 0.25, max: 4.0, step: 0.01, connectable: true, updateMode: 'uniform' },
  { id: 'softness', label: 'Softness', type: 'float', default: 0.05, min: 0.0, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], connectable: true, updateMode: 'uniform' },
  { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], connectable: true, updateMode: 'uniform' },
],
outputs: [ { id: 'color', label: 'Color', type: 'color' }, { id: 'value', label: 'Value', type: 'float' } ],
```

**Core math — dot stays round regardless of gap; Aspect stretches shape only; Gap X/Y are spacing only.** Add `u_dpr`,`u_ref_size`.
```glsl
vec2 gap_u = vec2(gapX, gapY) / (u_dpr * u_ref_size);            // per-axis period, isotropic coord units
vec2 rel   = coords - (floor(coords / gap_u) + 0.5) * gap_u;     // vector to nearest dot center (isotropic)
float rpx  = radius * min(gap_u.x, gap_u.y);                     // dot radius in coord units (round)
float d    = length(vec2(rel.x * aspect, rel.y));                // aspect stretches shape only
float value = 1.0 - smoothstep(rpx - softness * rpx, rpx + softness * rpx, d);
vec4  color = mix(colorB, colorA, value);
```

- [ ] **Step 1:** Rewrite `dots.ts` params/outputs/`glsl()`.
- [ ] **Step 2:** Mirror in `ir()` (`standardUniforms: new Set(['u_dpr','u_ref_size'])`).
- [ ] **Step 3:** `tsc -b`. **Step 4:** `verify-ir-poc.ts`. **Step 5:** `validate-wgsl-multipass.ts`. **Step 6:** `lint`.
- [ ] **Step 7:** Live: create `dots`, set Gap X≠Gap Y and confirm **dots stay round** (spacing changes, shape doesn't); set Aspect≠1 and confirm only the **dot shape** stretches, spacing unchanged; verify colors. Remove test node.
- [ ] **Step 8:** Commit `feat: dots — gap x/y px + shape-only aspect + A/B colors + color output`.

---

### Task 3: Checkerboard — Tile Mode (Cell Size ⟷ Density), Softness, Color A/B, dual output

**Files:** Modify `src/nodes/pattern/checkerboard.ts`

**Params block:**
```ts
params: [
  ...getSpatialParams({ transforms: ['scale', 'rotate', 'translate'] }),
  { id: 'tileMode', label: 'Tile Mode', type: 'enum', default: 'cellSize',
    options: [ { value: 'cellSize', label: 'Cell Size' }, { value: 'density', label: 'Density' } ],
    updateMode: 'recompile' },
  { id: 'cellSize', label: 'Cell Size', type: 'float', default: 40, min: 1, max: 512, step: 1, connectable: true, updateMode: 'uniform', showWhen: { tileMode: 'cellSize' } },
  { id: 'density', label: 'Density', type: 'float', default: 8, min: 1, max: 128, step: 1, connectable: true, updateMode: 'uniform', showWhen: { tileMode: 'density' } },
  { id: 'softness', label: 'Softness', type: 'float', default: 0.0, min: 0.0, max: 0.5, step: 0.01, connectable: true, updateMode: 'uniform' },
  { id: 'colorA', label: 'Color A', type: 'color', default: [1, 1, 1, 1], connectable: true, updateMode: 'uniform' },
  { id: 'colorB', label: 'Color B', type: 'color', default: [0, 0, 0, 1], connectable: true, updateMode: 'uniform' },
],
outputs: [ { id: 'color', label: 'Color', type: 'color' }, { id: 'value', label: 'Value', type: 'float' } ],
```
Confirm `showWhen` is supported (it is — see `NODE_AUTHORING_GUIDE.md`; used for conditional param visibility). Verify the exact `showWhen` shape against an existing user before coding.

**Core math.** `tileMode` is a compile-time branch (read `ctx.params.tileMode`). Add `u_dpr`,`u_ref_size` (cellSize mode only, but adding always is harmless).
```glsl
// cell size in coord units:
//   cellSize mode:  cell = cellSize / (u_dpr * u_ref_size)
//   density  mode:  cell = 1.0 / density         // cells per coord unit (calibrate live so ~N across reference)
vec2 g = coords / cell;
// Soft XOR of per-axis square waves — seamless, no fwidth dependence.
// f.x/f.y are triangle waves (period = 2 cells) so the smoothstep edge lands
// exactly on the cell boundary; soft XOR reproduces the checker.
vec2 f = abs(fract(g * 0.5) - 0.5) * 2.0;         // 0..1 per axis, period 2 cells
float e = softness + 0.0001;
float a = smoothstep(0.5 - e, 0.5 + e, f.x);
float b = smoothstep(0.5 - e, 0.5 + e, f.y);
float value = a * (1.0 - b) + (1.0 - a) * b;      // soft XOR; softness=0 → hard checker
vec4  color = mix(colorB, colorA, value);
```
Correctness constraint: at `softness = 0` the result must match the original hard
`mod(floor(g).x + floor(g).y, 2.0)` **including phase** (no half-cell offset). The
`g*0.5` / triangle-wave form above is phase-aligned to `floor(g)`; the implementer
verifies this live (softness 0 looks identical to the old checkerboard) and that
raised softness softens borders with no seams.

- [ ] **Step 1:** Rewrite `checkerboard.ts` params/outputs/`glsl()` with the `tileMode` branch.
- [ ] **Step 2:** Mirror in `ir()`.
- [ ] **Step 3–6:** `tsc -b`, `verify-ir-poc.ts`, `validate-wgsl-multipass.ts`, `lint`.
- [ ] **Step 7:** Live: toggle Tile Mode — confirm Cell Size (px) and Density each drive tiling and the inactive control hides (`showWhen`); confirm softness softens edges (0 = hard); verify colors. Remove test node.
- [ ] **Step 8:** Commit `feat: checkerboard — tile modes (cell size/density) + softness + A/B colors`.

---

### Task 4: Gradient — built-in stops (outputs color), spatial, dual output

**Files:** Modify `src/nodes/pattern/gradient.ts`, `src/nodes/index.ts`

**Changes:**
- Add `spatial: { transforms: ['scale', 'rotate', 'translate'] }` + `...getSpatialParams(...)` to params (the compiler injects the SRT on `coords`, same as the other patterns).
- Add a `stops` param mirroring `color-ramp.ts` (hidden float, `updateMode:'recompile'`) and an `interpolation` enum (reuse color-ramp's three modes) — or reuse the same `stops`/`interpolation` shape verbatim.
- Attach the editor in `index.ts`: after the existing `colorRamp.component = ColorRampEditor` block, add `if (gradient) gradient.component = ColorRampEditor` (import already present).
- Outputs become `[{id:'color', type:'color'}, {id:'value', type:'float'}]`.

**Core math.** Keep the existing per-Type float field as `value` (the `switch` you already have, writing to a local `field` var). Then map `field` → `color` with the color-ramp mix-chain (copy the stop-reading + fallback + mix-chain from `color-ramp.ts`, using `field` as `t`).
```glsl
float field = /* existing linear/radial/angular/diamond expression */;
float value = field;
// then: vec4 color = <color-ramp mix chain over `stops`/`interpolation`, with t = field>
```

- [ ] **Step 1:** Add spatial config + params to `gradient.ts`; change outputs to color+value; keep the Type field math as `value`.
- [ ] **Step 2:** Port the stops mix-chain (GLSL + IR) from `color-ramp.ts` to produce `color` from `value`; add `stops`+`interpolation` params.
- [ ] **Step 3:** Wire `gradient.component = ColorRampEditor` in `index.ts`.
- [ ] **Step 4–7:** `tsc -b`, `verify-ir-poc.ts`, `validate-wgsl-multipass.ts`, `lint`.
- [ ] **Step 8:** Live: create `gradient`, confirm the stops editor renders in the node body, editing stops recolors the gradient, Type switches shape, and spatial rotate/scale/translate now transform it. Remove test node.
- [ ] **Step 9:** Commit `feat: gradient — built-in color stops (outputs color) + spatial transforms`.

---

### Task 5: Docs + system-wide checklist

**Files:** Modify `BROWSER-AUTOMATION.md`, `.figma/wiki/templates/node-templates.md`

- [ ] **Step 1:** Update the four nodes' rows in `BROWSER-AUTOMATION.md` param/output tables (new params, new `color`+`value` outputs).
- [ ] **Step 2:** Update `.figma/wiki/templates/node-templates.md` entries for the four nodes.
- [ ] **Step 3:** Grep docs for any listing of these nodes' outputs as float-only; correct to color+value. (Node count unchanged; no Figma template regen required unless a reviewer flags it.)
- [ ] **Step 4:** `npm run lint` (in case of any code-doc drift), commit `docs: pattern node params/colors tables`.
```
