# Transparent Output + Background Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Sombra shader render on a transparent background (for overlaying over other page elements) and add a view-only background-modes panel (checker / solid) to the editor preview.

**Architecture:** Transparency is *emergent* — both renderers always clear to `a=0`, and final alpha comes from the shader. The Fragment Output node gains a `vec4` Color input (alpha auto-derives via existing coercion), a connectable `Alpha` float input, and an `Alpha op` enum that combines the two (7 boolean ops), then writes a premultiplied `vec4(rgb*a, a)`. Existing graphs emit `a=1`, so premult is a no-op and they stay opaque. The background panel is CSS behind the canvas, never baked into output.

**Tech Stack:** Vite, React 19 + TypeScript (strict), Zustand, Tailwind v4, WebGPU (WGSL) + WebGL2 (GLSL ES 3.0), dual codegen (`glsl()` + `ir()`).

## Global Constraints

- TypeScript strict mode everywhere.
- Every node needs BOTH `glsl()` and `ir()` generators, kept in parity (`scripts/verify-ir-poc.ts` enforces this).
- Both WebGPU and WebGL2 backends must keep working.
- No unit-test framework. Verification = `scripts/verify-ir-poc.ts` (GLSL↔IR parity), `scripts/validate-wgsl-multipass.ts` (WGSL GPU compile), `npm run lint`, `tsc -b`, and live browser via `window.__sombra` (`?backend=webgl2` / `?backend=webgpu`).
- Tailwind utility classes only; no per-component CSS; no raw hex outside `port-colors.ts` / `bg-black`. New DS visuals go through `sombra.ds.json` → `npm run tokens` → `ds.*` (or a `.claude/ds-queue.md` entry for interim inline classes).
- Work on branch `feat/transparent-output`. Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- GLSL float literals must have decimals (`1.0`, not `1`).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/nodes/output/fragment-output.ts` | Master output node: color/alpha inputs, alpha op, premultiplied write | Modify |
| `src/webgl/renderer.ts` | WebGL2 main renderer | Modify (transparent clear + explicit context flags) |
| `src/webgpu/renderer.ts` | WebGPU main renderer | Modify (transparent clear values) |
| `src/stores/settingsStore.ts` | Persisted editor settings | Modify (add `previewBackground`) |
| `src/components/PreviewToolbar.tsx` | Preview toolbar controls | Modify (add bg-mode popover) |
| `src/components/PreviewPanel.tsx` | Hosts the preview canvas | Modify (CSS backdrop layer) |
| `scripts/verify-ir-poc.ts` | GLSL↔IR parity harness | Modify (add fragment-output alpha-op case) |
| `BROWSER-AUTOMATION.md` | Dev-bridge/node reference | Modify (document new input/param) |

---

### Task 1: Fragment Output — alpha ops + premultiplied write

**Files:**
- Modify: `src/nodes/output/fragment-output.ts`
- Test: `scripts/verify-ir-poc.ts` (add a case)

**Interfaces:**
- Produces: `fragmentOutputNode` with input `color: vec4` (default `[0,0,0,1]`), connectable param `alpha: float` (default `1.0`), enum param `alphaOp` (default `'multiply'`); exported helper `alphaCombineExpr(d: string, a: string, op: string): string`.
- Consumes: `raw`, `NodeDefinition` (already imported / from `../types`).

- [ ] **Step 1: Add the alpha-op enum, Alpha input, and vec4 Color input**

In `src/nodes/output/fragment-output.ts`, replace the `inputs` array and add the two params. The `inputs` array becomes:

```ts
  inputs: [
    {
      id: 'color',
      label: 'Color',
      type: 'vec4',
      default: [0.0, 0.0, 0.0, 1.0], // opaque black; alpha auto-derives from a wired vec4
    },
  ],
```

Add these two entries to the **start** of the `params` array (before `quality`):

```ts
    {
      id: 'alpha',
      label: 'Alpha',
      type: 'float',
      default: 1.0,
      min: 0, max: 1, step: 0.01,
      connectable: true,
      updateMode: 'uniform',
    },
    {
      id: 'alphaOp',
      label: 'Alpha Op',
      type: 'enum',
      default: 'multiply',
      options: [
        { value: 'replace', label: 'Replace' },
        { value: 'multiply', label: 'Multiply (Intersect)' },
        { value: 'max', label: 'Union / Max' },
        { value: 'add', label: 'Add' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'min', label: 'Min' },
        { value: 'difference', label: 'Difference' },
      ],
      updateMode: 'recompile',
    },
```

- [ ] **Step 2: Add the combine-expression helper**

Add this exported function near the top of the file (after the imports, before `fragmentOutputNode`):

```ts
/**
 * GLSL/WGSL expression combining derived alpha `d` (from Color.a) with the
 * Alpha input `a`. Syntax is identical in both shading languages; the caller
 * clamps the result to 0..1. `d` and `a` are already-formatted expressions.
 */
export function alphaCombineExpr(d: string, a: string, op: string): string {
  switch (op) {
    case 'replace': return a
    case 'max': return `max(${d}, ${a})`
    case 'add': return `${d} + ${a}`
    case 'subtract': return `${d} - ${a}`
    case 'min': return `min(${d}, ${a})`
    case 'difference': return `abs(${d} - ${a})`
    case 'multiply':
    default: return `${d} * ${a}`
  }
}
```

- [ ] **Step 3: Rewrite `glsl()`**

Replace the existing `glsl` generator with:

```ts
  glsl: (ctx) => {
    const { inputs, params } = ctx
    const id = ctx.nodeId.replace(/-/g, '_')
    const col = `fo_col_${id}`
    const af = `fo_a_${id}`
    const op = (params.alphaOp as string) || 'multiply'
    const combine = alphaCombineExpr(`${col}.a`, inputs.alpha, op)
    return [
      `vec4 ${col} = ${inputs.color};`,
      `float ${af} = clamp(${combine}, 0.0, 1.0);`,
      `fragColor = vec4(${col}.rgb * ${af}, ${af});`,
    ].join('\n  ')
  },
```

- [ ] **Step 4: Rewrite `ir()`**

Ensure `raw` is imported from `'../../compiler/ir/types'` (add it to the existing import line alongside `variable, literal, construct, assign`). Replace the existing `ir` generator with:

```ts
  ir: (ctx) => {
    const id = ctx.nodeId.replace(/-/g, '_')
    const col = `fo_col_${id}`
    const af = `fo_a_${id}`
    const op = (ctx.params.alphaOp as string) || 'multiply'
    const combine = alphaCombineExpr(`${col}.a`, ctx.inputs.alpha, op)
    return {
      statements: [
        raw(
          `vec4 ${col} = ${ctx.inputs.color};`,
          `var ${col}: vec4f = ${ctx.inputs.color};`,
        ),
        raw(
          `float ${af} = clamp(${combine}, 0.0, 1.0);`,
          `let ${af}: f32 = clamp(${combine}, 0.0, 1.0);`,
        ),
        raw(
          `fragColor = vec4(${col}.rgb * ${af}, ${af});`,
          `fragColor = vec4f(${col}.rgb * ${af}, ${af});`,
        ),
      ],
      uniforms: [],
      standardUniforms: new Set(),
    }
  },
```

Note: the WGSL assembler rewrites the `fragColor = …;` line into `return …;` automatically; the two declaration lines pass through, hence the explicit WGSL variants.

- [ ] **Step 5: Add a parity test case**

In `scripts/verify-ir-poc.ts`, add the import at the top with the other node imports:

```ts
import { fragmentOutputNode } from '../src/nodes/output/fragment-output'
```

Add this case near the other node cases (e.g. after the Color Constant block around line 654):

```ts
// Fragment Output — alpha op (subtract) + premultiplied write
{
  const [g, i] = ctx({
    nodeId: 'fo-eee555',
    inputs: { color: 'node_src_color', alpha: 'u_fo_eee555_alpha' },
    outputs: {},
    params: { alphaOp: 'subtract', quality: 'adaptive', anchor: 'center', alpha: 0.5 },
  })
  verify('Fragment Output (alpha subtract)', fragmentOutputNode, g, i)
}
```

- [ ] **Step 6: Run parity + WGSL + type checks**

Run: `npx tsx scripts/verify-ir-poc.ts 2>&1 | tail -3`
Expected: `SUMMARY: N passed, 0 failed` (N = previous + 1).

Run: `npx tsx scripts/validate-wgsl-multipass.ts 2>&1 | tail -3`
Expected: `SUMMARY: 159 passed, 0 failed` (or higher; 0 failed).

Run: `npx tsc -b 2>&1 | tail -3`
Expected: no output (clean).

Run: `npx eslint src/nodes/output/fragment-output.ts scripts/verify-ir-poc.ts 2>&1 | tail -3`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add src/nodes/output/fragment-output.ts scripts/verify-ir-poc.ts
git commit -m "feat: Fragment Output alpha ops + premultiplied write

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Confirm connection validity + coercion for vec4 Color

**Files:**
- Read/verify: `src/components/FlowCanvas.tsx` (`isValidConnection`), `src/nodes/type-coercion.ts`, `src/compiler/ir-compiler.ts` (`coerceTypeForIR`)
- Modify only if a gap is found.

**Interfaces:**
- Consumes: `areTypesCompatible(from, to)` and `coerceType` / `coerceTypeForIR` (already exist).
- Produces: nothing new — this task guarantees vec3/color/vec4 sources connect to the vec4 Color input and coerce correctly on both backends.

- [ ] **Step 1: Verify coercion rules exist (read-only)**

Run: `grep -n "to: 'vec4'" src/nodes/type-coercion.ts`
Expected: entries for `from: 'vec3'`, `from: 'color'`, `from: 'float'`, `from: 'vec2'` → `to: 'vec4'` all present (they are). No edit needed here.

- [ ] **Step 2: Confirm `coerceTypeForIR` covers the same rules**

Run: `grep -n "vec4\|COERCION\|findCoercionRule\|case" src/compiler/ir-compiler.ts | head -20`
Expected: `coerceTypeForIR` reuses the shared rule table (emitting `vec4f(...)` names). If it does NOT handle `vec3→vec4` / `color→vec4`, add the missing mapping mirroring `coerceType` but with WGSL constructor `vec4f`. If it delegates to the shared table + WGSL backend translation, no edit needed.

- [ ] **Step 3: Live-verify connection validity — vec3 and vec4 into Color**

Start dev server if not running: `npm run dev` (background). In a browser tab at `http://localhost:5173/sombra/?backend=webgpu`, run via console / `window.__sombra`:

```js
const s = window.__sombra
s.clearGraph()
const out = s.createNode('fragment_output', { x: 600, y: 200 })
const col = s.createNode('color', { x: 200, y: 200 })   // vec3/color source
s.connect(col, 'color', out, 'color')                    // should succeed
const r = await s.compile()
JSON.stringify({ ok: r?.success ?? true })
```

Expected: connection succeeds and compile reports success. Repeat with a `vec4`-output source if one exists (else this vec3/color case is sufficient — coercion adds `a=1.0`).

- [ ] **Step 4: Re-run parity (guards against a coercion regression)**

Run: `npx tsx scripts/verify-ir-poc.ts 2>&1 | tail -3`
Expected: `0 failed`.

- [ ] **Step 5: Commit (only if an edit was needed)**

```bash
git add -A
git commit -m "fix: vec3/color→vec4 coercion parity for Fragment Output Color input

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no edit was needed, skip the commit and note it in the task handoff.

---

### Task 3: Transparent clears in both renderers

**Files:**
- Modify: `src/webgl/renderer.ts` (context flags ~line 135; `clearColor` ~line 957)
- Modify: `src/webgpu/renderer.ts` (`clearValue` at ~lines 874, 919, 946)

**Interfaces:**
- Consumes: nothing new.
- Produces: canvases that clear to transparent; premultiplied output from Task 1 composites over the page.

- [ ] **Step 1: WebGL — explicit alpha context flags**

In `src/webgl/renderer.ts` change the context acquisition (~line 135) from:

```ts
    const gl = canvas.getContext('webgl2')
```

to:

```ts
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true })
```

- [ ] **Step 2: WebGL — transparent clear**

Change (~line 957):

```ts
    gl.clearColor(0, 0, 0, 1)
```

to:

```ts
    gl.clearColor(0, 0, 0, 0)
```

- [ ] **Step 3: WebGPU — transparent clear values**

In `src/webgpu/renderer.ts`, change every canvas-target `clearValue: { r: 0, g: 0, b: 0, a: 1 }` to `a: 0` (the three sites near lines 874, 919, 946). Use a targeted replace:

Run: `grep -n "clearValue: { r: 0, g: 0, b: 0, a: 1 }" src/webgpu/renderer.ts`
Then edit each occurrence to `clearValue: { r: 0, g: 0, b: 0, a: 0 }`.

- [ ] **Step 4: Type check + lint**

Run: `npx tsc -b 2>&1 | tail -3` → clean.
Run: `npx eslint src/webgl/renderer.ts src/webgpu/renderer.ts 2>&1 | tail -3` → clean.

- [ ] **Step 5: Live-verify transparency on both backends**

Build a graph whose output alpha < 1 and confirm the page shows through. In the browser console at `?backend=webgpu`:

```js
const s = window.__sombra
s.clearGraph()
const out = s.createNode('fragment_output', { x: 600, y: 200 })
const col = s.createNode('color', { x: 200, y: 120 })
s.setParams(col, { color: [1.0, 0.2, 0.4] })
s.connect(col, 'color', out, 'color')
s.setParams(out, { alpha: 0.0, alphaOp: 'replace' })  // fully transparent
await s.compile()
document.body.style.background = 'lime'   // temporary: prove see-through
'done'
```

Expected: the preview canvas shows lime (page) through the fully-transparent output. Set `alpha: 1.0` → canvas becomes solid pink again. Repeat at `?backend=webgl2`. Then reset: `document.body.style.background = ''`.

- [ ] **Step 6: Confirm existing opaque graphs unchanged**

```js
const s = window.__sombra
s.importGraph(/* any existing preset, or */ undefined)
s.clearGraph()
const out = s.createNode('fragment_output', { x: 600, y: 200 })
const col = s.createNode('color', { x: 200, y: 120 })
s.connect(col, 'color', out, 'color')   // default alpha 1.0, op multiply
await s.compile()
'opaque graph compiles; canvas fully opaque'
```

Expected: fully opaque render (alpha defaults to 1 → premult no-op).

- [ ] **Step 7: Commit**

```bash
git add src/webgl/renderer.ts src/webgpu/renderer.ts
git commit -m "feat: clear canvas transparent on both backends

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: settingsStore — previewBackground state

**Files:**
- Modify: `src/stores/settingsStore.ts`

**Interfaces:**
- Produces: `previewBackground: { mode: 'checker' | 'solid' | 'none'; color: string }` on the store (default `{ mode: 'checker', color: '#1a1a2e' }`), and `setPreviewBackground(bg: Partial<{ mode; color }>): void`. Persisted alongside existing settings.
- Consumes: existing Zustand `persist` config pattern in the file.

- [ ] **Step 1: Add the type + state + setter**

In `src/stores/settingsStore.ts`, add to the state interface (near `previewMode`/`splitDirection`):

```ts
  previewBackground: { mode: 'checker' | 'solid' | 'none'; color: string }
  setPreviewBackground: (bg: Partial<{ mode: 'checker' | 'solid' | 'none'; color: string }>) => void
```

Add to the store defaults (near `previewMode: 'docked'`):

```ts
      previewBackground: { mode: 'checker', color: '#1a1a2e' },
```

Add the setter (near `setPreviewMode`):

```ts
      setPreviewBackground: (bg) =>
        set((s) => ({ previewBackground: { ...s.previewBackground, ...bg } })),
```

If the file uses an explicit `partialize` in its `persist` options, ensure `previewBackground` is included so it survives reloads.

- [ ] **Step 2: Type check + lint**

Run: `npx tsc -b 2>&1 | tail -3` → clean.
Run: `npx eslint src/stores/settingsStore.ts 2>&1 | tail -3` → clean.

- [ ] **Step 3: Live-verify default + persistence**

```js
const s = window.__sombra
s.stores.settings.getState().previewBackground        // → {mode:'checker', color:'#1a1a2e'}
s.stores.settings.getState().setPreviewBackground({ mode: 'solid', color: '#000000' })
s.stores.settings.getState().previewBackground        // → {mode:'solid', color:'#000000'}
```

Then reload the page and re-read `previewBackground` — expected `{mode:'solid', color:'#000000'}` (persisted).

- [ ] **Step 4: Commit**

```bash
git add src/stores/settingsStore.ts
git commit -m "feat: previewBackground setting (checker/solid/none)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Background panel UI (toolbar control + backdrop layer)

**Files:**
- Modify: `src/components/PreviewToolbar.tsx` (mode control)
- Modify: `src/components/PreviewPanel.tsx` (CSS backdrop behind canvas)

**Interfaces:**
- Consumes: `previewBackground` + `setPreviewBackground` from `settingsStore` (Task 4).
- Produces: a visible backdrop behind the transparent canvas; a toolbar control to switch modes and pick the solid color. View-only — does not touch rendering.

- [ ] **Step 1: Backdrop layer in PreviewPanel**

In `src/components/PreviewPanel.tsx`, read the setting and render a layer *behind* the canvas host. Add near the top of the component:

```tsx
  const previewBackground = useSettingsStore((s) => s.previewBackground)
```

Render an absolutely-positioned backdrop as the first child of the panel's positioned container, behind the canvas (`z-0`; canvas host stays above it). Checker uses a CSS conic/gradient tile; solid uses the picked color; none is transparent:

```tsx
  const checkerStyle = {
    backgroundImage:
      'linear-gradient(45deg,#0000 75%,#00000022 0),linear-gradient(45deg,#00000022 25%,#0000 0),linear-gradient(-45deg,#0000 75%,#00000022 0),linear-gradient(-45deg,#00000022 25%,#0000 0)',
    backgroundSize: '16px 16px',
    backgroundPosition: '0 0,8px 0,8px -8px,0 8px',
  }
```

```tsx
  {previewBackground.mode !== 'none' && (
    <div
      aria-hidden
      className="absolute inset-0 z-0 pointer-events-none"
      style={
        previewBackground.mode === 'checker'
          ? checkerStyle
          : { background: previewBackground.color }
      }
    />
  )}
```

Note: React Flow / canvas hosts accept `style` for runtime-dynamic values (allowed exception in CLAUDE.md). The checker tile and solid color are runtime values, so inline `style` is acceptable here; no new DS token needed. If a reusable checker utility is later wanted, queue it in `.claude/ds-queue.md`.

- [ ] **Step 2: Mode control in PreviewToolbar**

In `src/components/PreviewToolbar.tsx`, add a small control group (mirroring the existing preview-mode buttons) with three options — Checker / Solid / None — plus an `<input type="color">` shown only when mode is `solid`:

```tsx
  const { previewBackground, setPreviewBackground } = useSettingsStore(
    (s) => ({ previewBackground: s.previewBackground, setPreviewBackground: s.setPreviewBackground }),
  )
```

```tsx
  {(['checker', 'solid', 'none'] as const).map((m) => (
    <button
      key={m}
      type="button"
      onClick={() => setPreviewBackground({ mode: m })}
      className={
        previewBackground.mode === m
          ? 'bg-indigo text-fg rounded px-sm py-xs text-xs'
          : 'text-fg-dim hover:bg-surface-elevated rounded px-sm py-xs text-xs'
      }
      title={`Background: ${m}`}
    >
      {m === 'checker' ? '▦' : m === 'solid' ? '■' : '◌'}
    </button>
  ))}
  {previewBackground.mode === 'solid' && (
    <input
      type="color"
      value={previewBackground.color}
      onChange={(e) => setPreviewBackground({ color: e.target.value })}
      className="h-6 w-6 rounded border border-edge bg-transparent"
      title="Background color"
    />
  )}
```

Match the surrounding toolbar's existing class conventions if they differ from the above (reuse the exact classes the existing mode buttons use).

- [ ] **Step 3: Type check + lint**

Run: `npx tsc -b 2>&1 | tail -3` → clean.
Run: `npx eslint src/components/PreviewToolbar.tsx src/components/PreviewPanel.tsx 2>&1 | tail -3` → clean.

- [ ] **Step 4: Live-verify the panel**

At `?backend=webgpu` with the transparent graph from Task 3 (alpha 0):
- Toolbar shows three bg buttons; default = checker → transparent areas show the checkerboard.
- Click Solid → color swatch appears; pick a color → backdrop fills with it; transparent shader areas show that color.
- Click None → backdrop disappears (page/app background shows).
- Switching modes does NOT trigger a recompile (watch console — no compile logs). Confirm on `?backend=webgl2` too.

- [ ] **Step 5: Commit**

```bash
git add src/components/PreviewToolbar.tsx src/components/PreviewPanel.tsx
git commit -m "feat: preview background panel (checker/solid/none)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs — BROWSER-AUTOMATION.md

**Files:**
- Modify: `BROWSER-AUTOMATION.md`

**Interfaces:**
- Consumes: the final shapes from Tasks 1 and 4.
- Produces: accurate reference for the new Fragment Output input/param and the `previewBackground` setting.

- [ ] **Step 1: Update the Fragment Output entry**

In `BROWSER-AUTOMATION.md`, find the Fragment Output node row/section and document: Color input is now `vec4` (alpha auto-derives; vec3/color sources coerce with `a=1`), new connectable `alpha` float input (default 1.0), new `alphaOp` enum (`replace|multiply|max|add|subtract|min|difference`, default `multiply`), and that output is premultiplied `vec4(rgb*a, a)`.

- [ ] **Step 2: Document the settings-store shape change**

Add `previewBackground: { mode: 'checker'|'solid'|'none'; color: string }` + `setPreviewBackground` to the `sombra.stores.settings` reference section.

- [ ] **Step 3: Commit**

```bash
git add BROWSER-AUTOMATION.md
git commit -m "docs: transparent output + background panel in automation reference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npx tsx scripts/verify-ir-poc.ts 2>&1 | tail -3` → `0 failed`
- [ ] `npx tsx scripts/validate-wgsl-multipass.ts 2>&1 | tail -3` → `0 failed`
- [ ] `npm run lint` → clean
- [ ] `npx tsc -b` → clean
- [ ] Live, both backends: transparent graph overlays a page color through checker/solid backdrops; an opaque graph is pixel-unchanged from before this feature; a shared/embed URL (`viewer.html`) of a transparent graph renders see-through over a host page.

## Spec coverage check

- Emergent transparency (no toggle) → Task 3.
- Premultiplied final write → Task 1 (Steps 3–4).
- Color vec4 + auto-derive → Task 1 (Step 1) + Task 2.
- Alpha input + 7-op dropdown → Task 1 (Steps 1–2).
- Both codegen paths in parity → Task 1 (Steps 5–6).
- Transparent clears both backends + explicit WebGL flags → Task 3.
- View-only background panel (checker/solid + picker) persisted → Tasks 4–5.
- Viewer/embed transparent → covered by Task 3 (shared canvas path); verified in Final verification.
- Docs → Task 6.
- Out of scope (Composite node, baked background) → not planned, per spec.
