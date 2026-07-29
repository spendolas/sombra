# `RenderPass.resolution` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a render pass rasterise at a fraction or multiple of canvas size, so a downstream change can build the blur bake-off's radius-adaptive pyramid and supersample effect passes.

**Architecture:** One optional `resolution?: number` scale factor on `RenderPass`, declared by a node through `multiPass.resolution`, resolved per pass by a shared compiler helper, and honoured by all four renderers through a single shared sizing helper. The sizing helper owns the load-bearing rule — `u_dpr` scales with the pass alongside `u_resolution` and `u_viewport` — which is what makes `auto_uv` invariant and keeps anchor pinning exact.

**Tech Stack:** TypeScript strict, Vite, WebGPU (WGSL) + WebGL2 (GLSL ES 3.0), Playwright + real Chrome for GPU verification. **No unit-test framework exists** — verification is `scripts/*.ts` executed with `npx tsx`, using the `test`/`assert`/`assertClose`/`run` helpers from `scripts/blur-bakeoff/lib/test-util.ts`.

**Spec:** `docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md` (commit `11be05c`). Read it before starting.

## Global Constraints

- **Plumbing only.** No shipped node may declare a scale when this lands. Do not modify `src/nodes/effect/blur.ts` behaviour, and do not wire quality-tier scaling.
- **`u_dpr` must scale with the pass.** Scaling `u_resolution`/`u_viewport` while leaving `u_dpr` alone gives a `1/s` zoom — the bug recorded at `src/webgl/renderer.ts:838`.
- **`u_dpr` derives from the actual integer texture width, never the requested float.** Same bug class.
- **Both backends, always.** Every change lands in WGSL and GLSL paths together. WebGL2 is a supported fallback, not legacy.
- **Scale range `(0, 4]`**, additionally clamped to `[1, maxTexture]` px in main renderers and `[4, maxTexture]` px in preview renderers.
- **Absent `resolution` must be byte-identical to today**, comparing each backend against itself. Never a cross-backend equality claim — WebGPU and WebGL2 differ on frost by up to 51 codes through hardware bilinear (`docs/research/2026-07-29-frost-backend-divergence.md`).
- TypeScript strict. `npm run lint` and `npx tsc -b` clean before every commit.
- Exact existing identifiers you will need: `SUB_PASS_PARAM` (`= '__subPass'`, exported from `src/compiler/expand-passes.ts:28`), `FBOSlot` (`{ framebuffer, texture, width, height }`), `nodeRegistry.register(def)`, `REFERENCE_SIZE = 512` from `src/renderer/constants.ts`.

---

### Task 1: The sizing helper — `passTargetSize`

The whole correctness argument lives here, and it is testable with no GPU. Do this first so every later task builds on a proven rule.

**Files:**
- Create: `src/renderer/pass-size.ts`
- Create: `scripts/verify-pass-size.ts`
- Modify: `package.json` (add the script)

**Interfaces:**
- Consumes: nothing.
- Produces: `passTargetSize(scale: number | undefined, canvasWidth: number, canvasHeight: number, baseDpr: number, maxTexture: number, minPx?: number): PassTargetSize` where `PassTargetSize = { width: number; height: number; dpr: number }`; plus `normalisePassScale(scale: number | undefined): number`, `PASS_SCALE_MIN`, `PASS_SCALE_MAX`. Tasks 3–5 all call `passTargetSize`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-pass-size.ts`:

```ts
/**
 * The per-pass sizing contract. Pure maths, no GPU — this is where the claim
 * "anchor pinning survives a scaled pass" becomes executable rather than a
 * paragraph in a spec.
 *
 * Run: npx tsx scripts/verify-pass-size.ts
 */
import { test, run, assert, assertClose } from './blur-bakeoff/lib/test-util'
import { passTargetSize, normalisePassScale, PASS_SCALE_MAX } from '../src/renderer/pass-size'

const REF = 512
const MAXTEX = 8192

/** auto_uv on one axis, exactly as the generator emits it. */
const autoUv = (frag: number, res: number, dpr: number, anchor: number) =>
  (frag - res * anchor) / (dpr * REF) + anchor

/** auto_uv on the Y axis, including the u_resolution.y flip. */
const autoUvY = (frag: number, res: number, dpr: number, anchor: number) =>
  (res - frag - res * anchor) / (dpr * REF) + anchor

test('absent scale is the identity', () => {
  const s = passTargetSize(undefined, 1024, 768, 2, MAXTEX)
  assert(s.width === 1024 && s.height === 768, `got ${s.width}x${s.height}`)
  assert(s.dpr === 2, `dpr ${s.dpr}`)
})

test('half scale halves the target and the dpr', () => {
  const s = passTargetSize(0.5, 1024, 768, 2, MAXTEX)
  assert(s.width === 512 && s.height === 384, `got ${s.width}x${s.height}`)
  assertClose(s.dpr, 1, 1e-12, 'dpr must halve with the pass')
})

test('supersampling above 1.0 is allowed', () => {
  const s = passTargetSize(2, 800, 600, 1, MAXTEX)
  assert(s.width === 1600 && s.height === 1200, `got ${s.width}x${s.height}`)
  assertClose(s.dpr, 2, 1e-12, 'dpr must grow with the pass')
})

test('auto_uv is invariant across scale — X axis', () => {
  const W = 1024, H = 768, D = 2, a = 0.5
  for (const scale of [0.25, 0.5, 1, 2, 3]) {
    const s = passTargetSize(scale, W, H, D, MAXTEX)
    for (const p of [0, 0.1, 0.37, 0.5, 0.75, 1]) {
      const full = autoUv(p * W, W, D, a)
      const scaled = autoUv(p * s.width, s.width, s.dpr, a)
      assertClose(scaled, full, 1e-9, `scale ${scale} at p=${p}`)
    }
  }
})

test('auto_uv is invariant across scale — Y axis, including the flip', () => {
  const W = 1024, H = 768, D = 2
  for (const scale of [0.25, 0.5, 2]) {
    for (const a of [0, 0.5, 1]) {
      const s = passTargetSize(scale, W, H, D, MAXTEX)
      for (const p of [0, 0.37, 1]) {
        const full = autoUvY(p * H, H, D, a)
        const scaled = autoUvY(p * s.height, s.height, s.dpr, a)
        assertClose(scaled, full, 1e-9, `scale ${scale} anchor ${a} at p=${p}`)
      }
    }
  }
})

test('a px-authored param keeps its cell index', () => {
  // pixelate: size = floor(pixelSize * u_dpr + 0.5); cell = floor(centred / size)
  const W = 1024, H = 1024, D = 2, a = 0.5, pixelSize = 8
  const cellAt = (res: number, dpr: number, p: number) => {
    const size = Math.max(1, Math.floor(pixelSize * dpr + 0.5))
    return Math.floor((p * res - res * a) / size)
  }
  const s = passTargetSize(0.5, W, H, D, MAXTEX)
  for (const p of [0.1, 0.3, 0.5, 0.9]) {
    assert(cellAt(s.width, s.dpr, p) === cellAt(W, D, p),
      `cell index moved at p=${p}: ${cellAt(s.width, s.dpr, p)} vs ${cellAt(W, D, p)}`)
  }
})

test('dpr comes from the integer width, not the requested float', () => {
  // 1001 * 0.5 = 500.5 -> rounds to 501, so dpr must be 501/1001, not 0.5.
  const s = passTargetSize(0.5, 1001, 1001, 1, MAXTEX)
  assert(s.width === 501, `width ${s.width}`)
  assertClose(s.dpr, 501 / 1001, 1e-12, 'dpr must track the actual texture width')
  assert(s.dpr !== 0.5, 'dpr must not be the requested float')
})

test('degenerate scales fall back to 1.0', () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert(normalisePassScale(bad) === 1, `${bad} should normalise to 1`)
  }
})

test('scale is clamped to PASS_SCALE_MAX and to maxTexture', () => {
  assert(normalisePassScale(1000) === PASS_SCALE_MAX, 'scale must clamp')
  const s = passTargetSize(4, 4096, 4096, 1, 8192)
  assert(s.width === 8192, `width ${s.width}`)
  const capped = passTargetSize(4, 4096, 4096, 1, 4096)
  assert(capped.width === 4096, `maxTexture must cap: ${capped.width}`)
})

test('minPx floor applies (preview renderers use 4)', () => {
  const s = passTargetSize(0.01, 80, 80, 1, MAXTEX, 4)
  assert(s.width === 4 && s.height === 4, `got ${s.width}x${s.height}`)
})

await run('pass-size')
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx tsx scripts/verify-pass-size.ts
```

Expected: failure resolving `../src/renderer/pass-size` — the module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/pass-size.ts`:

```ts
/**
 * Per-pass render-target sizing for `RenderPass.resolution`.
 *
 * ONE implementation, shared by both main renderers and both preview renderers.
 * The `dpr` rule below is the entire correctness argument for per-pass
 * resolution, and two copies of it would drift apart — which is exactly how the
 * two halves of reeded-glass diverged.
 *
 * Spec: docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md
 */

/** Smallest supported scale. Below this a pass carries no usable signal. */
export const PASS_SCALE_MIN = 1 / 64
/** Largest supported scale. Above 1.0 is supersampling. */
export const PASS_SCALE_MAX = 4

export interface PassTargetSize {
  /** Target width in device px. */
  width: number
  /** Target height in device px. */
  height: number
  /**
   * `u_dpr` for this pass. Derived from the ACTUAL integer width, never the
   * requested float: rounding otherwise desynchronises the uniforms from the
   * rasteriser, giving a whole-frame scale error plus an anchor offset — the bug
   * recorded at src/webgl/renderer.ts:838.
   */
  dpr: number
}

/** Clamp a declared scale into range, falling back to 1.0 for nonsense. */
export function normalisePassScale(scale: number | undefined): number {
  if (scale === undefined) return 1
  if (!Number.isFinite(scale) || scale <= 0) {
    console.warn(`[Sombra] pass resolution ${scale} is not a positive finite number — using 1.0`)
    return 1
  }
  return Math.min(PASS_SCALE_MAX, Math.max(PASS_SCALE_MIN, scale))
}

/**
 * Target size and matching `u_dpr` for one pass.
 *
 * `canvasWidth`/`canvasHeight` are the FULL render size in device px (i.e.
 * already dpr-multiplied), and `baseDpr` is the `u_dpr` a full-resolution pass
 * would receive.
 */
export function passTargetSize(
  scale: number | undefined,
  canvasWidth: number,
  canvasHeight: number,
  baseDpr: number,
  maxTexture: number,
  minPx = 1,
): PassTargetSize {
  const s = normalisePassScale(scale)
  const lo = Math.max(1, Math.floor(minPx))
  const hi = Math.max(lo, Math.floor(maxTexture))
  const clamp = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)))
  const width = clamp(canvasWidth * s)
  const height = clamp(canvasHeight * s)
  return { width, height, dpr: baseDpr * (width / Math.max(1, canvasWidth)) }
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
npx tsx scripts/verify-pass-size.ts
```

Expected: `SUMMARY: 10 passed, 0 failed`.

- [ ] **Step 5: Register the script**

In `package.json`, after the `"verify:wired-branch"` line, add:

```json
    "verify:pass-size": "tsx scripts/verify-pass-size.ts",
```

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc -b && npm run lint && npx tsx scripts/verify-pass-size.ts
git add src/renderer/pass-size.ts scripts/verify-pass-size.ts package.json
git commit -m "feat(renderer): per-pass target sizing, with the u_dpr rule under test

u_dpr must scale with a pass alongside u_resolution and u_viewport, or auto_uv
picks up a 1/s zoom. The test makes that executable: auto_uv is evaluated at
several scales on both axes (including the u_resolution.y flip) and required to
agree to 1e-9, and a pixelate cell index is required to land in the same cell.
Also pins dpr to the ACTUAL integer texture width — 1001 at scale 0.5 rounds to
501, so dpr is 501/1001, not 0.5."
```

---

### Task 2: The field and its producer

**Files:**
- Create: `src/compiler/pass-resolution.ts`
- Create: `scripts/verify-pass-resolution.ts`
- Modify: `src/compiler/glsl-generator.ts` (the `RenderPass` interface at :51, the `wgsl.passes` element type at ~:84, and three `passes.push` sites at :876, :897, :913)
- Modify: `src/compiler/ir-compiler.ts` (three `passes.push` sites at :685, :703, :716)
- Modify: `src/nodes/types.ts:329` (`multiPass`)
- Modify: `package.json`

**Interfaces:**
- Consumes: `SUB_PASS_PARAM` from `src/compiler/expand-passes.ts`.
- Produces: `RenderPass.resolution?: number`; `plan.wgsl.passes[i].resolution?: number`; `multiPass.resolution?: (passIndex: number, params: Record<string, unknown>) => number`; and `resolvePassResolution(passNodeIds: string[], nodeMap: Map<string, Node<NodeData>>): number | undefined`. Tasks 3–5 read `pass.resolution`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-pass-resolution.ts`:

```ts
/**
 * Does a node's declared per-pass scale reach the RenderPlan, on BOTH codegen
 * paths?
 *
 * No shipped node declares a scale (that is deliberate — this change is
 * plumbing), so the producer is a synthetic node registered here. A data field
 * nothing can write cannot be verified, and an unverifiable field is how a
 * harness ends up silently vacuous.
 *
 * Run: npx tsx scripts/verify-pass-resolution.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

// A three-pass node whose sub-passes ask for 1, 0.5 and 0.25. Modelled on
// src/nodes/effect/blur.ts, which is the real multiPass consumer.
const PYRAMID_SCALES = [1, 0.5, 0.25]
const testNode: NodeDefinition = {
  type: 'test_pyramid',
  label: 'Test Pyramid',
  category: 'effect',
  multiPass: {
    count: () => 3,
    from: 'color',
    to: 'source',
    resolution: (passIndex) => PYRAMID_SCALES[passIndex] ?? 1,
  },
  inputs: [{ id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [],
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = ${ctx.inputs.source};`,
  ir: (ctx) => ({
    outputs: [{ kind: 'declare', name: ctx.outputs.color, type: 'vec4', init: { kind: 'variable', name: ctx.inputs.source } }],
  }),
} as unknown as NodeDefinition

nodeRegistry.register(testNode)

const nodes = [n('src', 'checkerboard'), n('fx', 'test_pyramid'), n('out', 'fragment_output')]
const edges = [
  e('e1', 'src', 'color', 'fx', 'source'),
  e('e2', 'fx', 'color', 'out', 'color'),
]

test('GLSL plan carries a resolution per pass', () => {
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const scales = plan.passes.map((p) => p.resolution)
  assert(scales.includes(0.5), `expected a 0.5 pass, got ${JSON.stringify(scales)}`)
  assert(scales.includes(0.25), `expected a 0.25 pass, got ${JSON.stringify(scales)}`)
  const last = plan.passes[plan.passes.length - 1]
  assert(last.resolution === undefined || last.resolution === 1,
    `final pass must be full resolution, got ${last.resolution}`)
})

test('WGSL plan carries the same resolutions', () => {
  const plan = compileGraph(nodes, edges)
  assert(!!plan.wgsl, 'no wgsl half in the plan')
  const glsl = plan.passes.map((p) => p.resolution ?? 1)
  const wgsl = plan.wgsl!.passes.map((p) => p.resolution ?? 1)
  assert(JSON.stringify(glsl) === JSON.stringify(wgsl),
    `backends disagree: GLSL ${JSON.stringify(glsl)} vs WGSL ${JSON.stringify(wgsl)}`)
})

test('IR compiler emits resolution directly', () => {
  const res = compileGraphIR(nodes, edges)
  const scales = res.passes.map((p) => p.resolution ?? 1)
  assert(scales.includes(0.5) && scales.includes(0.25),
    `expected 0.5 and 0.25, got ${JSON.stringify(scales)}`)
})

test('a graph with no declaring node has no resolution anywhere', () => {
  const plain = [n('s', 'checkerboard'), n('o', 'fragment_output')]
  const plainEdges = [e('pe', 's', 'color', 'o', 'color')]
  const plan = compileGraph(plain, plainEdges)
  assert(plan.passes.every((p) => p.resolution === undefined),
    'an undeclared graph must leave the field absent, not default it to 1')
})

await run('pass-resolution')
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx tsx scripts/verify-pass-resolution.ts
```

Expected: TypeScript/runtime failure — `resolution` is not a property of `RenderPass`, and `multiPass.resolution` is not in the type.

- [ ] **Step 3: Add the type fields**

In `src/compiler/glsl-generator.ts`, inside `interface RenderPass` (after `textureFilter`):

```ts
  /**
   * Target size for this pass's render target, as a fraction of canvas size.
   * Absent means 1.0. Above 1.0 supersamples. Honoured by all four renderers via
   * `passTargetSize()` in src/renderer/pass-size.ts, which also scales `u_dpr` —
   * that is what keeps `auto_uv` and anchor pinning invariant.
   */
  resolution?: number
```

In the same file, inside the `wgsl.passes` element type (after its `textureFilter`):

```ts
      /** Mirrors RenderPass.resolution — see there. */
      resolution?: number
```

In `src/nodes/types.ts`, inside `multiPass`, after `to: string`:

```ts
    /**
     * Target scale for sub-pass `passIndex`, as a fraction of canvas size.
     * Default 1.0; above 1.0 supersamples. A pyramid returns something like
     * `[1, 0.5, 0.25][passIndex]`. Range is clamped to (0, 4] downstream.
     */
    resolution?: (passIndex: number, params: Record<string, unknown>) => number
```

- [ ] **Step 4: Write the resolver**

Create `src/compiler/pass-resolution.ts`:

```ts
/**
 * Resolve the scale a render pass should rasterise at from the nodes it holds.
 *
 * Shared by the GLSL and IR compilers so the two paths cannot disagree about
 * pass geometry — the failure mode this whole feature is most exposed to.
 */
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { SUB_PASS_PARAM } from './expand-passes'

/**
 * A pass is a DEPTH GROUP, not a single node (see `partitionIntoPasses`), so
 * several nodes can land in one pass and declare different scales. The rule is
 * MAX, because downscaling a pass on one node's behalf would silently degrade
 * every sibling that wanted full resolution. Max can only cost memory: a pyramid
 * whose sibling pins the pass to 1.0 loses its optimisation but still renders
 * correctly, which is the right direction to fail in.
 *
 * Returns `undefined` when no node in the pass declares anything, so an
 * unaffected graph produces a plan with the field absent rather than defaulted.
 */
export function resolvePassResolution(
  passNodeIds: string[],
  nodeMap: Map<string, Node<NodeData>>,
): number | undefined {
  let best: number | undefined
  const declared: number[] = []

  for (const id of passNodeIds) {
    const node = nodeMap.get(id)
    if (!node) continue
    const fn = nodeRegistry.get(node.data.type)?.multiPass?.resolution
    if (!fn) continue

    const params = node.data.params || {}
    const rawIndex = Number(params[SUB_PASS_PARAM] ?? 0)
    const passIndex = Number.isFinite(rawIndex) ? rawIndex : 0

    let scale: number
    try {
      scale = fn(passIndex, params)
    } catch (err) {
      console.warn(`[Sombra] ${node.data.type}.multiPass.resolution threw — ignoring`, err)
      continue
    }
    if (!Number.isFinite(scale) || scale <= 0) continue

    declared.push(scale)
    best = best === undefined ? scale : Math.max(best, scale)
  }

  if (new Set(declared).size > 1) {
    console.warn(
      `[Sombra] one pass declares conflicting resolutions (${declared.join(', ')}) — using ${best}`,
    )
  }
  return best
}
```

- [ ] **Step 5: Emit it from the GLSL compiler**

In `src/compiler/glsl-generator.ts`, add the import at the top:

```ts
import { resolvePassResolution } from './pass-resolution'
```

Inside the `for (let passIdx = 0; ...)` loop in `generateMultiPass`, immediately after `const isLastPass = passIdx === passPartition.length - 1`:

```ts
    // Resolved once per pass: relay passes below share the primary's geometry,
    // because they render the same fragment into a same-sized target.
    const passResolution = resolvePassResolution(passNodeIds, nodeMap)
```

Then add `resolution: passResolution,` to the object literal at **all three** `passes.push` sites (primary at :876, relay at :897, last-pass at :913). For example the primary becomes:

```ts
      passes.push({
        index: primaryIdx,
        fragmentShader,
        vertexShader: VERTEX_SHADER,
        userUniforms: passUserUniforms,
        inputTextures,
        isTimeLive: uniforms.has('u_time'),
        textureFilter: primaryResolved?.textureFilter,
        resolution: passResolution,
      })
```

- [ ] **Step 6: Emit it from the IR compiler**

In `src/compiler/ir-compiler.ts`, add the same import:

```ts
import { resolvePassResolution } from './pass-resolution'
```

In `compileMultiPassIR`, inside its per-pass loop and mirroring the GLSL placement, add:

```ts
    const passResolution = resolvePassResolution(passNodeIds, nodeMap)
```

Then add `resolution: passResolution,` to all three `passes.push` object literals (:685, :703, :716).

- [ ] **Step 7: Run the test to confirm it passes**

```bash
npx tsx scripts/verify-pass-resolution.ts
```

Expected: `SUMMARY: 4 passed, 0 failed`.

- [ ] **Step 8: Confirm nothing else moved**

```bash
npx tsx scripts/verify-ir-poc.ts && npx tsx scripts/validate-wgsl-multipass.ts && npm run self-validate
```

Expected: `85 passed`, `159 passed`, and `0 FAIL / 0 WARN` across 433 shaders. If self-validate reports a shader-count change, stop — a field addition must not alter generated source.

- [ ] **Step 9: Register, typecheck, lint, commit**

Add to `package.json` after `verify:pass-size`:

```json
    "verify:pass-resolution": "tsx scripts/verify-pass-resolution.ts",
```

```bash
npx tsc -b && npm run lint
git add src/compiler/pass-resolution.ts src/compiler/glsl-generator.ts src/compiler/ir-compiler.ts src/nodes/types.ts scripts/verify-pass-resolution.ts package.json
git commit -m "feat(compiler): RenderPass.resolution and the multiPass producer that sets it

A pass is a depth group, not one node, so several nodes can land in it and
disagree about scale. resolvePassResolution takes the MAX: downscaling a pass on
one node's behalf would silently degrade every sibling that wanted full
resolution, whereas max can only cost memory — a pyramid pinned to 1.0 by a
sibling loses its optimisation and still renders correctly.

Shared by both codegen paths rather than written twice, because the two halves
disagreeing about pass geometry is the failure this feature is most exposed to.

Verified with a synthetic three-pass node registered in the test, since no
shipped node declares a scale yet; a field nothing can write cannot be checked.
Also asserts an undeclared graph leaves the field ABSENT rather than defaulting
it to 1, so the no-op path stays provably a no-op."
```

---

### Task 3: WebGL2 main renderer

**Files:**
- Modify: `src/webgl/renderer.ts` — `PassState`, `detectGPUCaps` (~:182), `allocateFBOs` (:337), `resizeFBOs` (:369), the multi-pass install site (~:528), `renderMultiPass` (:831), and the `uploadBuiltinUniforms` call at :880

**Interfaces:**
- Consumes: `passTargetSize`, `PassTargetSize` from Task 1; `RenderPass.resolution` from Task 2.
- Produces: `private passTargetSizes(w: number, h: number): PassTargetSize[]` on the renderer class. Task 4 mirrors its shape, and Task 6's thrash gate depends on the per-pass staleness comparison landing here.

- [ ] **Step 1: Store the texture-size limit**

`detectGPUCaps` already reads `const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number` at ~:182 but does not keep it. Add a field beside `maxIntermediateTextures` (:122):

```ts
  private maxTextureSize = 4096
```

and inside `detectGPUCaps`, right after that `maxTexSize` local is read:

```ts
    this.maxTextureSize = maxTexSize
```

- [ ] **Step 2: Carry `resolution` on `PassState` and add the sizing helper**

Add to the `PassState` interface (beside `textureFilter`):

```ts
  /** Target scale for this pass. Undefined = full canvas resolution. */
  resolution?: number
```

At the `newPassStates.push({...})` site (~:502), add:

```ts
          resolution: pass.resolution,
```

Add the import at the top of the file:

```ts
import { passTargetSize, type PassTargetSize } from '../renderer/pass-size'
```

Add this private method next to `allocateFBOs`:

```ts
  /**
   * Target size and matching u_dpr for every pass, honouring
   * RenderPass.resolution. `w`/`h` are the full render size in device px.
   */
  private passTargetSizes(w: number, h: number): PassTargetSize[] {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    return this.passStates.map((ps) =>
      passTargetSize(ps.resolution, w, h, dpr, this.maxTextureSize))
  }
```

- [ ] **Step 3: Take per-pass sizes in `allocateFBOs`**

Change the signature and the loop:

```ts
  /** Allocate FBO slots for intermediate passes, one per requested size. */
  private allocateFBOs(sizes: Array<{ width: number; height: number }>) {
    const gl = this.gl

    // Clean up existing
    this.destroyFBOs()

    const cappedCount = Math.min(sizes.length, this.maxIntermediateTextures)
    if (sizes.length > cappedCount) {
      console.warn(`[Sombra] Graph needs ${sizes.length} intermediate textures but cap is ${this.maxIntermediateTextures}. Some passes may not render.`)
    }

    for (let i = 0; i < cappedCount; i++) {
      const { width, height } = sizes[i]
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      // Default to LINEAR; per-pass filtering applied at bind time
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.bindTexture(gl.TEXTURE_2D, null)

      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)

      this.fboPool.push({ framebuffer: fb, texture: tex, width, height })
    }
  }
```

At the call site (~:528), replace `this.allocateFBOs(intermediateCount, w, h)` with:

```ts
      // passStates is already assigned above, so passTargetSizes sees this plan.
      this.allocateFBOs(this.passTargetSizes(w, h).slice(0, intermediateCount))
```

- [ ] **Step 4: Make `resizeFBOs` per-pass**

Replace its body:

```ts
  /** Resize FBO textures to each pass's own target size. */
  private resizeFBOs() {
    const gl = this.gl
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const w = Math.floor(this.canvas.clientWidth * dpr)
    const h = Math.floor(this.canvas.clientHeight * dpr)
    const sizes = this.passTargetSizes(w, h)

    let resized = false
    for (let i = 0; i < this.fboPool.length; i++) {
      const fbo = this.fboPool[i]
      const want = sizes[i]
      if (!want) continue
      if (fbo.width === want.width && fbo.height === want.height) continue
      gl.bindTexture(gl.TEXTURE_2D, fbo.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, want.width, want.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      fbo.width = want.width
      fbo.height = want.height
      resized = true
    }

    // Only invalidate cached passes when something actually changed. This is now
    // also called as a per-frame revalidation from renderMultiPass, and marking
    // every pass dirty unconditionally would defeat the [P3] clean-pass skip and
    // re-render the whole chain every frame.
    if (resized) {
      for (const ps of this.passStates) ps.dirty = true
    }
  }
```

- [ ] **Step 5: Make the per-frame staleness guard per-pass**

In `renderMultiPass`, replace the `if (this.fboPool.length > 0 && (this.fboPool[0].width !== w || this.fboPool[0].height !== h))` guard with:

```ts
    // Compare EVERY pass, not just fboPool[0]. With mixed scales a single
    // comparison mis-fires and the pool is destroyed and recreated every frame —
    // the bug already recorded at src/webgpu/renderer.ts:456.
    if (this.fboPool.length > 0) {
      const want = this.passTargetSizes(w, h)
      const stale = this.fboPool.some((f, i) =>
        !!want[i] && (f.width !== want[i].width || f.height !== want[i].height))
      if (stale) this.resizeFBOs()
    }
```

- [ ] **Step 6: Upload per-pass uniforms**

Still in `renderMultiPass`, add `const sizes = this.passTargetSizes(w, h)` just after that guard. Then replace the target-binding block plus the two lines that follow it:

```ts
      let tw = w, th = h, tdpr = dpr
      if (isLast) {
        // Render to screen — always full canvas resolution.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        const fbo = this.fboPool[i]
        if (!fbo) continue
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer)
        tw = fbo.width
        th = fbo.height
        tdpr = sizes[i]?.dpr ?? dpr
      }
      gl.viewport(0, 0, tw, th)

      gl.useProgram(ps.program)
      this.uploadBuiltinUniforms(ps.uniforms, tw, th, tdpr, time)
```

`uploadBuiltinUniforms` needs no change: it already writes `u_resolution` and `u_viewport` from its `w`/`h` arguments and `u_dpr` from `dpr`.

- [ ] **Step 7: Verify no regression on the default path**

```bash
npx tsc -b && npm run lint && npm run self-validate
```

Expected: `0 FAIL / 0 WARN`, 433 shaders — unchanged, since no shipped node declares a scale.

- [ ] **Step 8: Commit**

```bash
git add src/webgl/renderer.ts
git commit -m "feat(webgl): honour RenderPass.resolution per pass

Intermediate FBOs are sized per pass, and each pass now gets u_resolution,
u_viewport and u_dpr for ITS OWN target rather than the canvas. u_dpr scaling
alongside is what keeps auto_uv invariant; without it a scaled pass renders a 1/s
zoom, which is the bug at renderer.ts:838.

The per-frame staleness guard now compares every pass instead of fboPool[0].
That is not tidying: with mixed sizes a single comparison mis-fires and the pool
is destroyed and recreated every frame, exactly as recorded at
webgpu/renderer.ts:456. Task 6's thrash gate holds this down."
```

---

### Task 4: WebGPU main renderer

**Files:**
- Modify: `src/webgpu/renderer.ts` — `PassState`, the pass-install site (~:409), `ensureIntermediateTextures` (:449), `resizeIntermediateTextures` (:498), `writeMultiPassBuiltinUniforms` (:756)

**Interfaces:**
- Consumes: `passTargetSize`, `PassTargetSize` (Task 1); `plan.wgsl.passes[i].resolution` (Task 2).
- Produces: nothing new for later tasks; mirrors Task 3.

- [ ] **Step 1: Carry `resolution` and add the sizing helper**

Add the import:

```ts
import { passTargetSize, type PassTargetSize } from '../renderer/pass-size'
```

Add to the `PassState` interface (beside `textureFilter`):

```ts
  /** Target scale for this pass. Undefined = full canvas resolution. */
  resolution?: number
```

At the `passStates.push({...})` site (~:409), add:

```ts
        resolution: wgslPasses[i].resolution,
```

Add this private method beside `ensureIntermediateTextures`:

```ts
  /**
   * Target size and matching u_dpr for every pass, honouring
   * RenderPass.resolution. `w`/`h` are the full render size in device px.
   */
  private passTargetSizes(w: number, h: number): PassTargetSize[] {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.currentDprScale
    const maxTex = this.device.limits.maxTextureDimension2D
    return this.passStates.map((ps) => passTargetSize(ps.resolution, w, h, dpr, maxTex))
  }

  /** Pool identity: sizes, not one width/height pair. */
  private passSizeKey(sizes: PassTargetSize[]): string {
    return sizes.map((s) => `${s.width}x${s.height}`).join(',')
  }
```

- [ ] **Step 2: Replace the single-pair staleness fields**

Replace the `lastIntermediateWidth` / `lastIntermediateHeight` fields (~:98) with:

```ts
  /** Last allocated intermediate sizes, as a comparable key. */
  private lastIntermediateKey = ''
```

Then fix the three places that touch the old fields:
- `cleanupMultiPassState` (~:444): replace both assignments with `this.lastIntermediateKey = ''`.
- `ensureIntermediateTextures`: see the next step.
- Any other reference the compiler flags — `npx tsc -b` will list them.

- [ ] **Step 3: Size intermediates per pass**

Replace the guard and allocation loop in `ensureIntermediateTextures`:

```ts
  /** Ensure intermediate textures exist and match each pass's target size. */
  private ensureIntermediateTextures(width: number, height: number): void {
    const numIntermediate = this.passStates.length - 1
    if (numIntermediate <= 0) return

    // Compare against the ALLOCATED count: comparing against the uncapped
    // pass count made this mismatch permanently for over-cap graphs — the
    // pool was destroyed and recreated every single frame.
    const cap = Math.min(numIntermediate, WebGPUShaderRenderer.MAX_INTERMEDIATE_TEXTURES)
    const sizes = this.passTargetSizes(width, height).slice(0, cap)
    const key = this.passSizeKey(sizes)
    if (this.intermediateTextures.length === cap && this.lastIntermediateKey === key) {
      return
    }

    // Destroy old
    for (const tex of this.intermediateTextures) tex.destroy()
    this.intermediateTextures = []
    this.intermediateSamplers = []

    for (let i = 0; i < cap; i++) {
      const texture = this.device.createTexture({
        size: [sizes[i].width, sizes[i].height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.intermediateTextures.push(texture)

      // Sampler with per-pass filter hint
      const filterMode = this.passStates[i].textureFilter === 'nearest' ? 'nearest' : 'linear'
      const sampler = this.device.createSampler({
        minFilter: filterMode as GPUFilterMode,
        magFilter: filterMode as GPUFilterMode,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
      this.intermediateSamplers.push(sampler)
    }

    this.lastIntermediateKey = key

    // Rebuild bind groups since texture views changed
    this.rebuildMultiPassBindGroups()
  }
```

`resizeIntermediateTextures` needs no change — it forwards canvas size to `ensureIntermediateTextures`, which now derives per-pass sizes itself.

`renderMultiPass` needs no viewport change: `beginRenderPass` defaults the viewport to the attachment size, so a smaller texture is already rasterised correctly.

- [ ] **Step 4: Write per-pass uniforms**

Replace `writeMultiPassBuiltinUniforms`:

```ts
  private writeMultiPassBuiltinUniforms(w: number, h: number, dpr: number, time: number): void {
    const sizes = this.passTargetSizes(w, h)
    for (let i = 0; i < this.passStates.length; i++) {
      const ps = this.passStates[i]
      const set = (name: string, ...values: number[]) => {
        const offset = ps.uniformLayout.offsets.get(name)
        if (offset === undefined) return
        const base = offset / 4
        for (let j = 0; j < values.length; j++) {
          ps.uniformFloat32[base + j] = values[j]
        }
      }

      // The LAST pass draws to the swap-chain texture, which is always full
      // canvas size regardless of what it declared.
      const isLast = i === this.passStates.length - 1
      const tw = isLast ? w : (sizes[i]?.width ?? w)
      const th = isLast ? h : (sizes[i]?.height ?? h)
      const tdpr = isLast ? dpr : (sizes[i]?.dpr ?? dpr)

      set('u_time', time)
      set('u_resolution', tw, th)
      set('u_dpr', tdpr)
      set('u_ref_size', WebGPUShaderRenderer.REFERENCE_SIZE)
      set('u_viewport', tw, th)
      set('u_anchor', this.anchor[0], this.anchor[1])

      this.device.queue.writeBuffer(ps.uniformBuffer, 0, ps.uniformData)
    }
  }
```

- [ ] **Step 5: Apply the same last-pass rule to WebGL2**

Task 3 Step 6 already does this structurally — the `isLast` branch leaves `tw`/`th`/`tdpr` at the canvas values. Re-read that block and confirm it matches this reasoning; if a scale-declaring final pass were ever allowed to shrink, the canvas would be rasterised short.

- [ ] **Step 6: Verify**

```bash
npx tsc -b && npm run lint && npm run self-validate && npx tsx scripts/validate-wgsl-multipass.ts
```

Expected: `0 FAIL / 0 WARN` across 433 shaders; `159 passed`.

- [ ] **Step 7: Commit**

```bash
git add src/webgpu/renderer.ts
git commit -m "feat(webgpu): honour RenderPass.resolution per pass

Mirrors the WebGL2 change. Intermediate textures are sized per pass and each
pass's u_resolution/u_viewport/u_dpr describe its own target.

lastIntermediateWidth/Height become a single size KEY, because one width/height
pair cannot describe a pool of differently-sized targets and would mis-compare
every frame — the recreate-every-frame bug this file already documents at :456.

The final pass is pinned to canvas size on both backends: it draws to the swap
chain, so honouring a declared shrink there would rasterise the canvas short.
beginRenderPass needs no viewport call — it defaults to the attachment size."
```

---

### Task 5: Preview renderers

**Files:**
- Modify: `src/renderer/types.ts:94` (`PreviewPassSource`)
- Modify: `src/compiler/subgraph-compiler.ts` (three `passes.push` sites at :298, :310, :324)
- Modify: `src/compiler/ir-subgraph-compiler.ts` (three `passes.push` sites at :343, :364, :392)
- Modify: `src/renderer/preview-scheduler.ts:30` (the inline pass type) and `:282` (the map)
- Modify: `src/webgl/preview-renderer.ts` — `ensurePassFBOs` (:432), `renderMultiPassPreview` (:313)
- Modify: `src/webgpu/preview-renderer.ts` — its intermediate texture creation (~:294) and uniform write (~:462)

**Interfaces:**
- Consumes: `passTargetSize` (Task 1); `resolvePassResolution` (Task 2).
- Produces: `PreviewPassSource.resolution?: number`.

- [ ] **Step 1: Widen the preview pass type**

In `src/renderer/types.ts`:

```ts
/** Pass data for multi-pass preview rendering. */
export interface PreviewPassSource {
  fragmentShader: string
  uniforms: UniformUpload[]
  inputTextures: Record<string, number>
  /**
   * Target scale for this pass, relative to PREVIEW_SIZE. Mirrors
   * RenderPass.resolution so a thumbnail matches what the main canvas shows.
   */
  resolution?: number
}
```

- [ ] **Step 2: Emit it from both subgraph compilers**

In `src/compiler/subgraph-compiler.ts`, import the resolver and compute it per pass exactly as Task 2 did in `glsl-generator.ts`:

```ts
import { resolvePassResolution } from './pass-resolution'
```

```ts
    const passResolution = resolvePassResolution(passNodeIds, nodeMap)
```

Add `resolution: passResolution` to all three `passes.push` literals. The primary becomes:

```ts
      passes.push({ fragmentShader, userUniforms: passUserUniforms, inputTextures, resolution: passResolution })
```

Do the same in `src/compiler/ir-subgraph-compiler.ts` at its three push sites. If the local variable holding the pass's node ids is named differently there, use that name — read the enclosing loop rather than assuming.

- [ ] **Step 3: Carry it through the scheduler**

In `src/renderer/preview-scheduler.ts`, extend the inline type at :30:

```ts
    passes?: Array<{ fragmentShader: string; uniforms: UniformUpload[]; inputTextures: Record<string, number>; resolution?: number }>
```

and add `resolution: p.resolution,` to the `.map()` at :282.

- [ ] **Step 4: Size preview FBOs per pass (WebGL2)**

In `src/webgl/preview-renderer.ts`, add the import:

```ts
import { passTargetSize } from '../renderer/pass-size'
```

Replace `ensurePassFBOs` — it is currently grow-only and never resizes, so a changed scale would silently keep the old size:

```ts
  /**
   * One FBO per intermediate pass, at that pass's own size.
   *
   * Grows on demand AND resizes in place: a pass whose declared scale changed
   * needs a new texture, and the previous grow-only version would have kept
   * rendering into the old one.
   */
  private ensurePassFBOs(sizes: Array<{ width: number; height: number }>) {
    const gl = this.gl
    while (this.passFBOs.length < sizes.length) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PREVIEW_SIZE, PREVIEW_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)

      const fb = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      this.passFBOs.push({ framebuffer: fb, texture: tex, width: PREVIEW_SIZE, height: PREVIEW_SIZE })
    }

    for (let i = 0; i < sizes.length; i++) {
      const slot = this.passFBOs[i]
      const want = sizes[i]
      if (slot.width === want.width && slot.height === want.height) continue
      gl.bindTexture(gl.TEXTURE_2D, slot.texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, want.width, want.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      slot.width = want.width
      slot.height = want.height
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
```

If the existing `passFBOs` element type has no `width`/`height`, add them to it.

- [ ] **Step 5: Use per-pass sizes and uniforms in the preview render loop**

In `renderMultiPassPreview`, replace `this.ensurePassFBOs(passes.length - 1)` with:

```ts
    // Preview floors at 4px rather than the main renderer's 1px: a 1x1
    // intermediate carries no usable signal at thumbnail scale, and previews are
    // advisory. Deliberate divergence from the main renderers.
    const sizes = passes.map((p) =>
      passTargetSize(p.resolution, PREVIEW_SIZE, PREVIEW_SIZE, 1, PREVIEW_SIZE * 4, 4))
    this.ensurePassFBOs(sizes.slice(0, passes.length - 1))
```

Then, in the per-pass body, replace the fixed target/viewport/uniform lines:

```ts
      let tw = PREVIEW_SIZE, th = PREVIEW_SIZE, tdpr = 1
      if (isLast) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.passFBOs[i].framebuffer)
        tw = this.passFBOs[i].width
        th = this.passFBOs[i].height
        tdpr = sizes[i]?.dpr ?? 1
      }

      gl.viewport(0, 0, tw, th)
      gl.useProgram(program)
```

and change the three built-in uploads that follow to use them:

```ts
      const uRes = gl.getUniformLocation(program, 'u_resolution')
      if (uRes) gl.uniform2f(uRes, tw, th)
      const uRefSize = gl.getUniformLocation(program, 'u_ref_size')
      if (uRefSize) gl.uniform1f(uRefSize, REFERENCE_SIZE)
      const uDpr = gl.getUniformLocation(program, 'u_dpr')
      if (uDpr) gl.uniform1f(uDpr, tdpr)
      const uVp = gl.getUniformLocation(program, 'u_viewport')
      if (uVp) gl.uniform2f(uVp, tw, th)
```

Leave `u_time` and `u_anchor` exactly as they are.

- [ ] **Step 6: Mirror it in the WebGPU preview**

In `src/webgpu/preview-renderer.ts`, apply the same three changes: compute `sizes` with `passTargetSize(p.resolution, PREVIEW_SIZE, PREVIEW_SIZE, 1, PREVIEW_SIZE * 4, 4)`; create each intermediate texture at `sizes[i]` instead of `[PREVIEW_SIZE, PREVIEW_SIZE]` (~:294); and set `u_resolution`, `u_viewport`, `u_dpr` per pass at ~:462, pinning the last pass to `PREVIEW_SIZE` with `u_dpr` 1.

Do **not** touch the final 80×80 readback target or `BYTES_PER_ROW` — intermediates are never read back, so the 256-byte alignment is irrelevant to them, and the final target is never scaled.

- [ ] **Step 7: Verify preview parity is intact**

```bash
npx tsc -b && npm run lint && npm run self-validate
```

Expected: `0 FAIL / 0 WARN`. Then in the app, with the dev server running, check thumbnails still render for a multi-pass graph:

```bash
npm run dev
```

Open a graph containing a Blur node and confirm its thumbnail is not blank. No shipped node declares a scale, so every preview must look exactly as before.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/types.ts src/renderer/preview-scheduler.ts src/compiler/subgraph-compiler.ts src/compiler/ir-subgraph-compiler.ts src/webgl/preview-renderer.ts src/webgpu/preview-renderer.ts
git commit -m "feat(preview): honour RenderPass.resolution in node thumbnails

Both preview renderers already allocate one target per pass — ping-pong was
removed because relay passes read non-adjacent sources and it aliased into GL
feedback loops — so this is per-pass SIZING only.

ensurePassFBOs was grow-only and never resized, so a changed scale would have
kept rendering into the old texture. It now resizes in place.

Previews floor at 4px where the main renderers floor at 1px: a 1x1 intermediate
carries no signal at thumbnail scale and previews are advisory. Deliberate, and
recorded at the call site. The 80x80 readback target and its 256-byte
BYTES_PER_ROW alignment are untouched — intermediates are never read back."
```

---

### Task 6: The GPU gates — pinning, invariance, thrash

The point of the whole change is that pinning survives. Task 1 proved the algebra; this proves the engine implements it.

**Files:**
- Create: `scripts/verify-pass-resolution-gpu.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: everything from Tasks 1–5. `createRig()` from `scripts/blur-bakeoff/lib/gpu-rig.ts`, whose `PassSpec` **already has** `scale?: number` ("Output resolution scale for this pass (1 = full). Prototypes pyramids") — the research rig prototyped this, so it is an independent reference for the engine to agree with.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the gate script**

Create `scripts/verify-pass-resolution-gpu.ts`. Model the browser plumbing on `scripts/verify-wired-texture-branch.ts`, which already launches Chrome via `playwright-core` with `channel: 'chrome'` and serves the repo over `http`.

```ts
/**
 * Does the ENGINE implement the per-pass resolution contract, on real GPUs?
 *
 * scripts/verify-pass-size.ts proves the arithmetic. This proves the renderers
 * apply it: that a scaled intermediate leaves anchor pinning where it was, that
 * pattern PHASE does not drift, and that a mixed-scale plan does not thrash the
 * texture pool.
 *
 * Run: npx tsx scripts/verify-pass-resolution-gpu.ts
 */
import { createRig } from './blur-bakeoff/lib/gpu-rig'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const rig = await createRig()

/** Brightness centroid along X. Catches a SHIFT that a mean would hide. */
function centroidX(img: { width: number; height: number; data: Uint8Array }): number {
  let wsum = 0, w = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const l = img.data[(y * img.width + x) * 4]
      wsum += l * (x / img.width)
      w += l
    }
  }
  return w > 0 ? wsum / w : 0
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  if (!rig.available[backend]) {
    console.log(`  [SKIP] ${backend} unavailable on this machine`)
    continue
  }

  test(`${backend}: a scaled pass does not move the anchor`, async () => {
    // A hard quadrant split: its corner sits exactly at the anchor, so any
    // pinning error moves a high-contrast edge and shows up immediately.
    const body = `
      vec2 p = gl_FragCoord.xy / u_viewport;
      float q = (p.x < 0.5 ? 0.0 : 1.0) + (p.y < 0.5 ? 0.0 : 1.0);
      return vec4(vec3(q * 0.5), 1.0);
    `
    const full = await rig.capture({ backend, width: 256, height: 256, passes: [{ body }, { body: 'return texture(u_src, v_uv);' }] })
    for (const scale of [0.5, 2]) {
      const scaled = await rig.capture({
        backend, width: 256, height: 256,
        passes: [{ body, scale }, { body: 'return texture(u_src, v_uv);' }],
      })
      const d = Math.abs(centroidX(scaled) - centroidX(full))
      assert(d < 0.005, `${backend} scale ${scale}: centroid moved by ${d.toFixed(5)}`)
    }
  })

  test(`${backend}: scale 1 is identical to no scale at all`, async () => {
    const body = 'return vec4(v_uv, 0.5, 1.0);'
    const a = await rig.capture({ backend, width: 128, height: 128, passes: [{ body }, { body: 'return texture(u_src, v_uv);' }] })
    const b = await rig.capture({ backend, width: 128, height: 128, passes: [{ body, scale: 1 }, { body: 'return texture(u_src, v_uv);' }] })
    let max = 0
    for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]))
    assert(max === 0, `${backend}: scale 1 differed by ${max} codes — the no-op path is not a no-op`)
  })
}

await rig.close()
await run('pass-resolution-gpu')
```

- [ ] **Step 2: Run it and confirm it exercises real GPUs**

```bash
npx tsx scripts/verify-pass-resolution-gpu.ts
```

Expected: passes on both backends. If it reports `[SKIP]` for both, the gate proved nothing — fix the rig availability before continuing. Treat a `SKIP`-only run as a failure.

- [ ] **Step 3: Add the engine-level pinning gate**

Append a test that drives the real renderer rather than the rig, using the same Playwright + local-server pattern as `scripts/verify-wired-texture-branch.ts` and the `window.__sombra` bridge documented in `BROWSER-AUTOMATION.md`. For each of the 9 anchors, build `checkerboard → test_pyramid → fragment_output`, register the synthetic scale-declaring node from Task 2 through the bridge, render, and require the anchor-adjacent edge to land within 1 px of the unscaled render. Write the two captures to `reports/pass-resolution/anchor-<name>-{full,scaled}.png` so the result is reviewable by eye, not only by number.

- [ ] **Step 4: Add the pool-thrash gate**

In the same script, add a test that counts allocations across 60 frames of a mixed-scale plan. Patch the context in-page before the plan is installed:

```ts
await page.evaluate(() => {
  const w = window as unknown as { __allocCount: number }
  w.__allocCount = 0
  const proto = WebGLRenderingContext.prototype as unknown as Record<string, unknown>
  const orig = proto.texImage2D as (...a: unknown[]) => unknown
  proto.texImage2D = function (...a: unknown[]) { w.__allocCount++; return orig.apply(this, a) }
})
```

Render 60 frames, read `__allocCount` after a 10-frame warmup, and assert it stays at 0. A non-zero count is the recreate-every-frame bug the per-pass staleness guards in Tasks 3 and 4 exist to prevent.

- [ ] **Step 5: Register and commit**

Add to `package.json`:

```json
    "verify:pass-resolution:gpu": "tsx scripts/verify-pass-resolution-gpu.ts",
```

```bash
npx tsc -b && npm run lint && npx tsx scripts/verify-pass-resolution-gpu.ts
git add scripts/verify-pass-resolution-gpu.ts package.json
git commit -m "test(pass-resolution): pinning, phase and pool-thrash gates on real GPUs

verify-pass-size proves the arithmetic; this proves the renderers apply it.
Measures a brightness CENTROID rather than a mean, because a mean happily passes
a pattern that has shifted — the same trap that made an earlier frost harness
report clean numbers while comparing a shader to itself.

Also asserts scale 1 is byte-identical to no scale, so the no-op path is provably
a no-op, and counts texImage2D calls across 60 frames of a mixed-scale plan to
hold down the recreate-every-frame bug. A run that SKIPs both backends is a
failure, not a pass."
```

---

### Task 7: Round-trip, docs, and the false claim

**Files:**
- Modify: `scripts/verify-artifact-roundtrip.ts`
- Modify: `PHASE6-MULTIPASS.md:368`
- Modify: `CLAUDE.md` (the multi-pass paragraph under "Compile pipeline")
- Modify: `NODE_AUTHORING_GUIDE.md` (the `multiPass` section)
- Modify: `docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md` (status line)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Assert the codec carries the field**

`src/embed/artifact.ts` needs no change — it spreads pass fields via `passes.map(({ vertexShader: _pv, ...p }) => p)`. Prove that rather than trusting it. In `scripts/verify-artifact-roundtrip.ts`, add a case that builds a plan with `resolution` set on a pass, encodes, decodes, and asserts the value survives:

```ts
test('resolution survives the artifact round-trip', () => {
  const plan = makeMinimalPlan()          // reuse whatever this file already uses
  plan.passes[0].resolution = 0.25
  const decoded = decodeArtifact(encodeArtifact({ plan, manifest: [], images: {} }))
  assert(decoded.plan.passes[0].resolution === 0.25,
    `resolution lost in the codec: ${decoded.plan.passes[0].resolution}`)
})
```

Match the helper names this file already uses; read it first.

- [ ] **Step 2: Run the embed suite**

```bash
npm run verify:embed
```

Expected: one more test than before, all passing.

- [ ] **Step 3: Fix the false claim in PHASE6-MULTIPASS.md**

Replace line 368:

```markdown
Per-node resolution override (`RenderPass.resolution`) is implemented as of
2026-07-29 — an optional scale factor honoured by both main renderers and both
preview renderers. See `docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md`.
No shipped node declares a scale yet, and there is no UI for it. The quality-tier
scaling in the table above remains unimplemented.
```

The old text claimed the field "is supported in the data structure but not exposed in UI until Phase 2", which was never true — the field did not exist.

- [ ] **Step 4: Document the authoring surface**

In `NODE_AUTHORING_GUIDE.md`, in the `multiPass` section, add:

````markdown
### Per-pass resolution

A `multiPass` node can render a sub-pass at a fraction (or multiple) of canvas size:

```ts
multiPass: {
  count: () => 3,
  from: 'color',
  to: 'source',
  resolution: (passIndex) => [1, 0.5, 0.25][passIndex] ?? 1,
}
```

Range is `(0, 4]`; above 1.0 supersamples. The framework scales `u_resolution`,
`u_viewport` **and `u_dpr`** together, so `auto_uv`, anchor pinning and every
px-authored param (anything you multiply by `u_dpr`) are unchanged — a scaled pass
sees the same pattern, sampled more or less finely. Author in reference px and
multiply by `u_dpr` as usual and scaling is free.

Two caveats. A pass is a depth group, so if another node shares the pass the
larger scale wins and a warning is logged. And the `Resolution` node reports the
*pass* size inside a scaled pass, not the canvas size.
````

In `CLAUDE.md`, add one sentence to the multi-pass bullet: `Passes may declare RenderPass.resolution (a scale factor) to rasterise at a fraction or multiple of canvas size; the framework scales u_dpr with it so auto_uv stays invariant.`

- [ ] **Step 5: Mark the spec implemented**

Change the spec's status line to:

```markdown
**Date:** 2026-07-29 · **Status:** IMPLEMENTED · **Scope:** plumbing only
```

- [ ] **Step 6: Full suite, then commit**

```bash
npx tsc -b && npm run lint && npm run build \
  && npx tsx scripts/verify-pass-size.ts \
  && npx tsx scripts/verify-pass-resolution.ts \
  && npx tsx scripts/verify-pass-resolution-gpu.ts \
  && npx tsx scripts/verify-ir-poc.ts \
  && npx tsx scripts/validate-wgsl-multipass.ts \
  && npx tsx scripts/verify-wired-texture-branch.ts \
  && npm run verify:embed \
  && npm run self-validate
```

Expected: tsc and lint clean, build succeeds, `85 passed`, `159 passed`, `53/53`, embed suite green, and self-validate `0 FAIL / 0 WARN` across **433** shaders. A changed shader count means codegen moved, which this change must not do.

```bash
git add scripts/verify-artifact-roundtrip.ts PHASE6-MULTIPASS.md CLAUDE.md NODE_AUTHORING_GUIDE.md docs/superpowers/specs/2026-07-29-renderpass-resolution-design.md
git commit -m "docs(multipass): per-pass resolution is real now, and PHASE6 was wrong

PHASE6-MULTIPASS.md:368 claimed RenderPass.resolution was 'supported in the data
structure but not exposed in UI until Phase 2'. It was not: no such field
existed. Corrected to describe what actually ships, and to keep the quality-tier
scaling in the same section marked unimplemented, since that is a separate
feature.

Documents the authoring surface with the rule that makes it safe — author px in
reference units and multiply by u_dpr, and scaling is free — plus the two
caveats: max wins when a pass holds several declaring nodes, and the Resolution
node reports pass size inside a scaled pass.

Asserts the embed codec carries the field rather than trusting its rest-spread."
```

---

## Self-Review

**Spec coverage.** Uniform contract → Task 1. Field, range, producer, conflict rule → Task 2. Main renderers, per-pass staleness → Tasks 3–4. Preview renderers, the 4px floor, `ensurePassFBOs` grow-only bug → Task 5. Gates 1–4 → Tasks 3–6 (gate 1 is the `scale === 1` byte-identity test in Task 6 plus the self-validate count check in every task). Gate 5 → Task 7 Step 1. Gate 6 → Task 5 Step 7. Gate 7 → Task 7 Step 6. Limitations documented → Task 7 Step 4. `PHASE6` correction → Task 7 Step 3.

**Deliberately out of scope**, per the spec: the `u_canvas_size` fix for the `Resolution` node; raising the WebGL intermediate cap; rewriting `blur.ts`; quality-tier scaling.

**Type consistency.** `passTargetSize`/`PassTargetSize`/`normalisePassScale` are defined in Task 1 and used with the same signature in Tasks 3, 4, 5. `resolvePassResolution(passNodeIds, nodeMap)` is defined in Task 2 and called identically in Tasks 2 and 5. `PassState.resolution` and `PreviewPassSource.resolution` are both `number | undefined`. `SUB_PASS_PARAM` is the real exported name (verified at `expand-passes.ts:28`), not `SUBPASS_PARAM_KEY`.

**Known softness.** Task 6 Steps 3–4 describe the engine-level pinning and thrash gates in prose plus one code fragment each, rather than complete scripts, because both depend on `window.__sombra` bridge calls whose exact shape must be read from `BROWSER-AUTOMATION.md` at implementation time. Everything else contains the literal code to write. Whoever implements Task 6 should expect to spend most of it there.
