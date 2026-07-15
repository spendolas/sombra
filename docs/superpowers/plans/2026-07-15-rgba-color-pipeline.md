# RGBA Color Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make alpha a first-class part of every color — redefine the `color` port type as RGBA, upgrade the swatch to an alpha-capable picker, and propagate alpha through generators, transforms, and effects to the screen.

**Architecture:** `color` (was an alias for `vec3`) becomes a 4-component RGBA type. Color-producing nodes emit RGBA; channel transforms edit all four channels; color-space ops preserve alpha; `mix` blends it; spatial nodes carry it along; `fragment_output` already consumes `.a`. Old `vec3` colors coerce to `a=1.0`, so existing graphs render opaque and unchanged.

**Tech Stack:** Vite, React 19 + TS (strict), Zustand, Tailwind v4, WebGPU (WGSL) + WebGL2 (GLSL ES 3.0), dual codegen (`glsl()` + `ir()`).

## Global Constraints

- TypeScript strict. Every node keeps BOTH `glsl()` and `ir()`, in parity (`scripts/verify-ir-poc.ts` enforces).
- Both WebGPU and WebGL2 backends must keep working; migrate both paths together per node.
- GLSL float literals need decimals (`1.0`). WGSL constructors are `vec4f(...)`; the WGSL backend mechanically translates `vec4(`→`vec4f(` in raw GLSL blocks, but explicit `raw(glsl, wgsl)` variants are needed for declaration lines.
- No unit-test framework. Verification = `verify-ir-poc.ts`, `validate-wgsl-multipass.ts`, `npm run lint`, `tsc -b`, and live browser via `window.__sombra` (`?backend=webgl2` / `?backend=webgpu`).
- Tailwind utility classes only; runtime-dynamic inline `style` is the sole exception; no raw hex outside `port-colors.ts`/`bg-black`; new DS visuals via `sombra.ds.json` → `npm run tokens` (or `.claude/ds-queue.md`).
- Branch `feat/transparent-output`. Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Backward compatibility is the top invariant:** an all-opaque legacy graph must render pixel-identical after every phase.

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `docs/superpowers/plans/rgba-node-audit.md` | Per-node color-port classification (artifact) | 1 |
| `src/compiler/glsl-generator.ts` | `paramGlslType`, `formatDefaultValue` | 1 |
| `src/nodes/type-coercion.ts` | GLSL `COERCION_RULES` | 1 |
| `src/compiler/ir-compiler.ts` | `coerceTypeForIR` | 1 |
| `src/components/RgbaColorPicker.tsx` | New alpha-capable picker | 2 |
| `src/components/NodeParameters.tsx` | Use the new picker for `color` params | 2 |
| `src/nodes/input/color-constant.ts` | RGBA swatch + output | 2 |
| `src/nodes/color/*`, `src/nodes/pattern/*`, generators | Emit RGBA | 3 |
| `src/nodes/color/*`, `src/nodes/distort/*`, `src/nodes/math/*`, effects | Alpha per category | 4 |
| `scripts/verify-ir-poc.ts` | Parity fixtures for migrated nodes | 1–4 |

---

## Phase 1 — Foundation

### Task 1: Audit & classify every node's color ports

**Files:**
- Create: `docs/superpowers/plans/rgba-node-audit.md`

**Interfaces:**
- Produces: a table every later task consumes — for each of the 41 nodes, its color-carrying input/output ports and its category (Generator / Channel transform / Color-space / Blend / Spatial / Non-color / Generic-math).

- [ ] **Step 1: Read every node file and classify**

For each file in `src/nodes/*/*.ts`, record: node `type`, each input/output port `{id, type}`, and whether each `vec3`/`color` port carries a *color* (RGB[A]) vs *data* (HSV triple, direction, coord, mask). Assign one category per the spec's table. Flag ambiguous ports explicitly.

- [ ] **Step 2: Write the artifact**

Write `docs/superpowers/plans/rgba-node-audit.md` as a table:

```markdown
| Node | Color inputs | Color outputs | Category | Alpha rule | Notes |
|------|-------------|--------------|----------|-----------|-------|
| color_constant | — | color(out) | Generator | swatch alpha | param color→RGBA |
| grayscale | color(in) | color(out) | Color-space | preserve .a | dot(rgb,luma) |
| ... | ... | ... | ... | ... | ... |
```

Include a summary: counts per category, and a list of `vec3` ports that are **data, not color** (must NOT be migrated) — e.g. `hsv_to_rgb` HSV input, any coordinate `vec3`, noise scalar outputs.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/rgba-node-audit.md
git commit -m "docs: RGBA migration node-port audit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Redefine `color` as RGBA (type + coercion + defaults)

**Files:**
- Modify: `src/compiler/glsl-generator.ts` (`paramGlslType` ~line 20, `formatDefaultValue` ~line 952)
- Modify: `src/nodes/type-coercion.ts` (`COERCION_RULES`)
- Modify: `src/compiler/ir-compiler.ts` (`coerceTypeForIR` ~line 36)
- Test: `scripts/verify-ir-poc.ts`

**Interfaces:**
- Produces: `color` compiles as a 4-component RGBA type on both paths; `vec3↔color` coercion adds/drops alpha (`a=1.0`).
- Consumes: nothing new.

- [ ] **Step 1: `paramGlslType` — color is vec4**

In `src/compiler/glsl-generator.ts`, change:

```ts
export function paramGlslType(paramType: string): 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (paramType === 'vec2') return 'vec2'
  if (paramType === 'vec3' || paramType === 'color') return 'vec3'
  if (paramType === 'vec4') return 'vec4'
  return 'float'
}
```

to:

```ts
export function paramGlslType(paramType: string): 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (paramType === 'vec2') return 'vec2'
  if (paramType === 'vec3') return 'vec3'
  if (paramType === 'color' || paramType === 'vec4') return 'vec4'
  return 'float'
}
```

- [ ] **Step 2: `formatDefaultValue` — add a `color` branch (4 floats, pad alpha)**

In the same file, add a `color` case to `formatDefaultValue` (before the vec4 case). It accepts a 3- or 4-length array (old saves are 3):

```ts
  if (type === 'color' && Array.isArray(value)) {
    const a = value.length > 3 ? safeFloat(value[3]) : '1.0'
    return `vec4(${safeFloat(value[0])}, ${safeFloat(value[1])}, ${safeFloat(value[2])}, ${a})`
  }
```

- [ ] **Step 3: GLSL `COERCION_RULES` — RGBA semantics for `color`**

In `src/nodes/type-coercion.ts`, replace the `color`-related rules so `color` is 4-component. Change the `color→vec3` and `vec3→color` identity rules and the `color→vec4`/`vec4→color` rules to:

```ts
  // color is RGBA (vec4-backed)
  { from: 'vec3', to: 'color', glsl: (v) => `vec4(${v}, 1.0)` },
  { from: 'color', to: 'vec3', glsl: (v) => `${v}.rgb` },
  { from: 'color', to: 'vec4', glsl: (v) => v },
  { from: 'vec4', to: 'color', glsl: (v) => v },
  { from: 'float', to: 'color', glsl: (v) => `vec4(vec3(${v}), 1.0)` },
  { from: 'color', to: 'float', glsl: (v) => `${v}.x` },
  { from: 'vec2', to: 'color', glsl: (v) => `vec4(${v}, 0.0, 1.0)` },
  { from: 'color', to: 'vec2', glsl: (v) => `${v}.xy` },
```

Remove the old `from:'color', to:'vec3', glsl: v=>v` and `from:'vec3', to:'color', glsl: v=>v` identity entries (they treated color as vec3). Keep all non-color rules unchanged.

- [ ] **Step 4: IR `coerceTypeForIR` — matching RGBA semantics**

In `src/compiler/ir-compiler.ts`, remove the special-case line treating color as vec3:

```ts
  // color is alias for vec3
  if ((from === 'color' && to === 'vec3') || (from === 'vec3' && to === 'color')) return varName
```

and update the `rules` object so `color` is vec4-backed:

```ts
    vec3: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec4: (v) => `vec4f(${v}, 1.0)`,
      color: (v) => `vec4f(${v}, 1.0)`,
    },
    color: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec3: (v) => `${v}.rgb`,
      vec4: (v) => v,
    },
    vec4: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec3: (v) => `${v}.rgb`,
      color: (v) => v,
    },
```

Also add `color: (v) => `vec4f(${v})`` to the `float` rule block and `color: (v) => `vec4f(${v}, 0.0, 1.0)`` to the `vec2` block (mirror the GLSL table).

- [ ] **Step 4b: Pad `color` uniform values to 4 floats**

Because `color` params are `updateMode: 'uniform'`, a `color` value now uploads as a **vec4** uniform (`paramGlslType` → vec4). Old saves store 3-tuples. In the uniform-emitting path (`resolveConnectableParam` / the uniform descriptor build in `glsl-generator.ts`, and wherever the renderer reads the uniform `value`), ensure a `color`-typed value is padded to length 4 with `a = 1.0` before upload — e.g. normalize `value = value.length >= 4 ? value : [...value, 1.0]` when `param.type === 'color'`. Verify both renderers upload a 4-component uniform for color (they already handle vec4 uniforms elsewhere). Without this, a legacy 3-tuple color uploads a truncated/garbage 4th component.

- [ ] **Step 5: Verify existing graphs still compile opaque**

Run: `npx tsx scripts/verify-ir-poc.ts 2>&1 | tail -3` → `0 failed`.
Run: `npx tsx scripts/validate-wgsl-multipass.ts 2>&1 | tail -3` → `0 failed`.
Run: `npx tsc -b` → clean. `npx eslint src/compiler/glsl-generator.ts src/nodes/type-coercion.ts src/compiler/ir-compiler.ts` → clean.

Note: at this phase no node declares a `color`-typed port yet (color_constant still outputs `vec3`), so behavior is unchanged — this step proves the type/coercion change is non-breaking.

- [ ] **Step 6: Commit**

```bash
git add src/compiler/glsl-generator.ts src/nodes/type-coercion.ts src/compiler/ir-compiler.ts
git commit -m "feat: redefine color port type as RGBA (vec4-backed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — RGBA picker + first generator

### Task 3: RGBA color picker component

**Files:**
- Create: `src/components/RgbaColorPicker.tsx`
- Modify: `src/components/NodeParameters.tsx` (the `color` param control)

**Interfaces:**
- Produces: `<RgbaColorPicker value={[r,g,b,a]} onChange={(rgba)=>void} label={string} />` — a self-contained popover with an RGB color area + hue slider + alpha slider, emitting normalized `[r,g,b,a]` (0–1). No external dependency.
- Consumes: `previewBackground`? No. Pure controlled component.

- [ ] **Step 1: Build the picker**

Create `src/components/RgbaColorPicker.tsx`. Requirements: a swatch button showing the current color over a mini checker (so alpha is visible); clicking opens a popover with (a) a saturation/value square, (b) a hue slider, (c) an alpha slider; all Tailwind/DS-styled; `nodrag nowheel` on the root so React Flow doesn't intercept. Value is `[r,g,b,a]` floats 0–1. Use HSV↔RGB helpers internally. Keep it under ~200 lines; if a suitable primitive exists in `src/components/ui/`, compose it.

(Implementation note for the engineer: use `<input type="range">` for hue/alpha and a pointer-drag div for SV; convert to/from `[r,g,b,a]`. The existing `ds.colorInput.*` tokens can style the swatch/label.)

- [ ] **Step 2: Wire into the `color` param control**

In `src/components/NodeParameters.tsx`, replace the `ColorInput` body (the `<input type="color">` block ~line 214–226) so it renders `<RgbaColorPicker>` instead, converting the stored value (3- or 4-length) to `[r,g,b,a]` (pad `a=1`) and calling `onChange([r,g,b,a])`. Keep the `ds.colorInput.root`/`label` layout.

- [ ] **Step 3: Verify**

Run: `npx tsc -b` → clean. `npx eslint src/components/RgbaColorPicker.tsx src/components/NodeParameters.tsx` → clean.
(Live verification happens after Task 4, when a node actually outputs the alpha.)

- [ ] **Step 4: Commit**

```bash
git add src/components/RgbaColorPicker.tsx src/components/NodeParameters.tsx
git commit -m "feat: RGBA color picker (color + alpha)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `color_constant` → RGBA

**Files:**
- Modify: `src/nodes/input/color-constant.ts`
- Test: `scripts/verify-ir-poc.ts`

**Interfaces:**
- Produces: `color_constant` outputs a `color` (RGBA) port; its `color` param default is `[1,0,1,1]`.

- [ ] **Step 1: Update the node**

In `src/nodes/input/color-constant.ts`: change the output port `type: 'vec3'` → `type: 'color'`; change the param default `[1.0, 0.0, 1.0]` → `[1.0, 0.0, 1.0, 1.0]`. Update codegen:

```ts
  glsl: (ctx) => {
    const { inputs, outputs } = ctx
    return `vec4 ${outputs.color} = ${inputs.color};`
  },

  ir: (ctx) => ({
    statements: [
      declare(ctx.outputs.color, 'color', variable(ctx.inputs.color)),
    ],
    uniforms: [],
    standardUniforms: new Set(),
  }),
```

(`inputs.color` is the RGBA uniform now, since `paramGlslType('color')` → vec4.)

- [ ] **Step 2: Update the parity fixture**

In `scripts/verify-ir-poc.ts`, the Color Constant case params `color: [1.0, 0.0, 1.0]` → `[1.0, 0.0, 1.0, 1.0]`.

- [ ] **Step 3: Verify (scripts)**

Run: `npx tsx scripts/verify-ir-poc.ts 2>&1 | tail -3` → `0 failed`.
Run: `npx tsx scripts/validate-wgsl-multipass.ts 2>&1 | tail -3` → `0 failed`.
Run: `npx tsc -b` → clean; eslint clean.

- [ ] **Step 4: Commit**

```bash
git add src/nodes/input/color-constant.ts scripts/verify-ir-poc.ts
git commit -m "feat: color_constant outputs RGBA (alpha from swatch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: CONTROLLER live-check (both backends)**

Empty a graph, `color_constant` → `fragment_output`, set swatch alpha via the new picker (or `setParams(colorId,{color:[1,0,1,0.4]})`), background = checker. Expect the magenta to show at 40% over the checker on `?backend=webgpu` and `?backend=webgl2`. Set alpha 1 → opaque. (This is the first visible transparency from a swatch.)

---

## Phase 3 — Generators emit RGBA

### Task 5: Migrate color-generator nodes (per audit)

**Files:** (confirm exact set from Task 1 audit)
- Modify: `src/nodes/color/color-ramp.ts`, `src/nodes/color/hsv-to-rgb.ts`, `src/nodes/pattern/gradient.ts`, and any pattern node the audit marks as color-output (`checkerboard`/`dots`/`stripes` only if they output color, not a scalar mask).
- Test: `scripts/verify-ir-poc.ts`

**Interfaces:**
- Produces: each generator's color output becomes a `color` (RGBA) port.

**Migration pattern (apply per node, reading its current code):**
- Change the color **output** port `type: 'vec3'|'vec4'` → `type: 'color'`.
- In `glsl()`/`ir()`, the final color assignment becomes 4-component:
  - If the node computes an `vec3 rgb`, emit `vec4 <out> = vec4(rgb, <alpha>);` where `<alpha>` is `1.0` for opaque generators, or the node's own alpha source (e.g. a color-ramp stop's alpha, if stops carry it).
  - IR: use `raw('vec4 <out> = vec4(rgb, a);', 'var <out>: vec4f = vec4f(rgb, a);')` or `declare(out, 'color', construct('vec4', [rgb, a]))`.
- **`color_ramp`/`gradient` stops:** if stops are stored as `[pos, r, g, b]`, extend to `[pos, r, g, b, a]` (default `a=1`), interpolate alpha alongside rgb, output RGBA. Update the param default + any stop-editor value shape (ColorRampEditor) to carry alpha; pad old saves to `a=1`.
- **`hsv_to_rgb`:** HSV **input** stays `vec3` (it is data, not a color — confirm in audit); the RGB **output** becomes `color` with `a=1.0`.

**Worked example — `hsv_to_rgb` (illustrative; adapt to real code):**
```ts
// output port: { id: 'color', type: 'color' }   (was vec3)
// glsl: after computing `vec3 rgb_x = ...;`
return `${existing}\n  vec4 ${outputs.color} = vec4(rgb_${id}, 1.0);`
// ir: raw('vec4 <out> = vec4(rgb, 1.0);', 'var <out>: vec4f = vec4f(rgb, 1.0);')
```

- [ ] **Step 1–N:** For each generator node in the audit list: apply the pattern, add/extend its `verify-ir-poc.ts` fixture, run `verify-ir-poc` + `validate-wgsl-multipass` + tsc + eslint (all clean/0 failed), commit per node (`feat: <node> outputs RGBA`). Keep commits one-node-each for reviewability.
- [ ] **Final Step: CONTROLLER live-check** — a gradient/color-ramp with a transparent stop shows the gradient fading to transparent over the checker, both backends.

---

## Phase 4 — Transforms & effects handle alpha

### Task 6: Migrate transform/effect nodes (per audit + category rules)

**Files:** (confirm from audit) `src/nodes/color/{invert,posterize,brightness-contrast,grayscale}.ts`, `src/nodes/math/{mix,remap,clamp,power,round,smoothstep,arithmetic}.ts`, `src/nodes/distort/*`, `src/nodes/transform/reeded-glass.ts`, `src/nodes/postprocess/pixel-grid.ts`.
- Test: `scripts/verify-ir-poc.ts`

**Category rules (from spec):**
- **Channel transform** (`invert`, `posterize`, `brightness_contrast`): color in/out become `color`; the op applies to **all four channels**. E.g. invert: `vec4 out = vec4(1.0) - c;` (inverts alpha too, by design). brightness/contrast: apply to the vec4.
- **Color-space op** (`grayscale`, hue/sat portions): color in/out `color`; compute on `.rgb`, **preserve `.a`**: `vec4 out = vec4(vec3(luma), c.a);`.
- **Blend** (`mix`): both color inputs `color`; interpolate the full vec4: `vec4 out = mix(a, b, t);` (blends alpha).
- **Generic math** (`remap`, `clamp`, `power`, `round`, `smoothstep`, `arithmetic`): these already operate on the vec type they receive. Change their color-typed ports (if any) to `color`; the math then covers all four channels automatically. Confirm no `.rgb`-only assumptions remain.
- **Spatial** (`warp`, `pixelate`, `tile`, `polar_coords`, `reeded_glass`, `pixel_grid`): color in/out become `color`; the sample/relay carries the full vec4 — change the sampled/passed variable from `vec3` to `vec4` and keep the spatial math on coords unchanged. Ports that are **UV coords `vec2`** are untouched.

**Worked example — `invert` (channel transform):**
```ts
// input/output color ports: type 'color'
glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(1.0) - ${ctx.inputs.color};`
ir:   raw(`vec4 ${out} = vec4(1.0) - ${cin};`, `var ${out}: vec4f = vec4f(1.0) - ${cin};`)
```

**Worked example — `grayscale` (color-space, preserve alpha):**
```ts
glsl: (ctx) => {
  const c = ctx.inputs.color, out = ctx.outputs.color
  return `float g_${id} = dot(${c}.rgb, vec3(0.299, 0.587, 0.114));\n  vec4 ${out} = vec4(vec3(g_${id}), ${c}.a);`
}
// ir: raw with `vec4f(vec3f(g), c.a)`
```

- [ ] **Step 1–N:** For each node in the audit list, apply its category rule, add/extend the `verify-ir-poc.ts` fixture (assert alpha handling: channel transforms change `.a`, color-space preserve `.a`, mix blends `.a`), run `verify-ir-poc` + `validate-wgsl-multipass` + tsc + eslint, commit per node.
- [ ] **Final Step: CONTROLLER live-check** — chain `color_constant`(a=0.5) → `invert` → `mix` → `output`; confirm alpha behaves per rules (invert flips it, mix blends it) over the checker, both backends. Confirm `grayscale` preserves alpha.

---

## Phase 5 — Verification sweep & compatibility

### Task 7: Cross-backend + backward-compat verification

**Files:**
- Modify (if gaps found): any node from Phases 3–4; `scripts/verify-ir-poc.ts`.

- [ ] **Step 1: Full script suite** — `verify-ir-poc.ts` (0 failed, fixtures cover every migrated node), `validate-wgsl-multipass.ts` (0 failed), `npm run lint`, `tsc -b` clean.
- [ ] **Step 2: Backward-compat** — load an existing preset / a pre-migration `.sombra` file and a compact-URL graph; confirm they import, compile, and render **pixel-identical (opaque)**. Confirm `color_constant` old 3-tuple params load as `a=1`.
- [ ] **Step 3: Cross-backend live matrix** — for a representative alpha graph, screenshot `?backend=webgpu` and `?backend=webgl2`; confirm they match and composite correctly over checker + solid backdrops.
- [ ] **Step 4: Commit any fixes**, then the branch is ready for whole-branch review.

## Self-review / spec coverage

- `color` = RGBA type → Task 2. Coercion both paths → Task 2. Default padding → Task 2 (formatDefaultValue) + Task 4/loader.
- RGBA picker (swatch alpha) → Task 3.
- Generators emit RGBA → Tasks 4–5.
- Channel transforms edit alpha; color-space preserve; mix blends; spatial carry; generic math covers all channels → Task 6.
- Backward compat (vec3→a=1, default merge) → Tasks 2, 4, 7.
- Both backends + parity + live → every task's verify steps + Task 7.
- Per-node classification (data vs color) → Task 1 audit (gates Tasks 5–6).
- Out of scope: composite/Porter-Duff node family; split/combine vec4 — not planned.

## Note on granularity

Phases 3–4 are intentionally pattern-driven with a per-node loop rather than 30 inlined node diffs: Task 1's audit produces the exact node list and each node is migrated + tested + committed individually using the documented category pattern. This keeps each commit reviewable and lets the migration stop/resume cleanly.
