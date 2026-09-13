# Per-Instance Params (`dynamicParams`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a node declare a varying number of parameters per instance, so per-layer opacity can be a real animatable uniform instead of a baked literal.

**Architecture:** `NodeDefinition.params` is a static array. `dynamicInputs` already exists as its port-side counterpart, so this adds the mirror — `dynamicParams?: (params) => NodeParameter[]` — and a single shared resolver used everywhere `definition.params` is iterated. Nine sites, verified by reading the source rather than trusting the spec. The three change-detection keys live inside `useMemo`s in a React hook and cannot be tested without rendering, so they are extracted into pure functions first; that extraction is what makes the rest gate-able.

**Tech Stack:** TypeScript (strict), React 19, Zustand, `tsx` scripts as the test suite, GLSL ES 3.0 + WGSL codegen.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` (§6.2, §11 B3)

## Global Constraints

- **Both backends, always.** Uniform emission is duplicated in `ir-compiler.ts` and `glsl-generator.ts`; a fix to one is half a fix.
- **A gate must be seen to fail.** Run each new gate before the change it guards and paste the failure into the report.
- **Mechanism-engaged assertions.** Assert the emitted uniform *names and values*, and that a key *changes* when a dynamic param changes. "It compiled" is not evidence — it compiles today, with the params missing.
- **Backwards compatible by construction.** Every existing node has no `dynamicParams`, so the resolver must return `def.params` unchanged for them. `self-validate` must stay 0 FAIL / 0 WARN and shader counts must not move.
- **One concern per commit.** No drive-by cleanups.
- **Do not push.** `main` deploys to sombra.sh on push. Work on a branch and stop.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** It was written against the source and checked by eye, not by `tsc`. Treat it as precise intent: where a signature differs, the source wins — fix it and say so in your report.

## The nine call sites (verified 2026-09-13)

> **Line numbers in `glsl-generator.ts` shifted by roughly +13** when plan 1
> landed, which this plan predates: sites 4/5/6 are near `:202`, `:513` and
> `:551`. **Locate every site by pattern, not by line number.** `ir-compiler.ts`
> and `ShaderNode.tsx` are unaffected.

| # | File:line | What it does | Needs resolving? |
|---|---|---|---|
| 1 | `use-live-compiler.ts:239` | `semanticKey` — recompile params | Yes |
| 2 | `use-live-compiler.ts:262` | `uniformKey` — uniform params | Yes |
| 3 | `use-live-compiler.ts:280` | `rendererKey` — renderer params | Yes |
| 4 | `glsl-generator.ts:196` | `partitionPasses` — connectable params are same-pass | Yes |
| 5 | `glsl-generator.ts:500` | `generateNodeGlsl` — resolve connectable params | Yes |
| 6 | `glsl-generator.ts:538` | `generateNodeGlsl` — non-connectable uniform params | Yes |
| 7 | `ir-compiler.ts:208` | `generateNodeIR` — resolve connectable params | Yes |
| 8 | `ir-compiler.ts:242` | `generateNodeIR` — non-connectable uniform params | Yes |
| 9 | `ShaderNode.tsx:273` | `allParams` — what the node body renders | Yes |

**Not a site:** `use-live-compiler.ts:105` (`collectCurrentUniformValues`) iterates the
uniform *specs* codegen already produced and reads `node.data.params?.[spec.paramId]`.
It handles dynamic params for free. The spec claimed otherwise; the spec is wrong.

Site 4 is the one the spec missed, and it matters: without it, a connectable
*dynamic* param would not contribute to pass depth, so a node driven by an
upstream branch could be scheduled into the wrong pass.

## File Structure

| File | Responsibility |
|---|---|
| `src/nodes/resolve-dynamic.ts` | **Create.** `resolveParams(def, nodeParams)` — the single place dynamic params are resolved. |
| `src/nodes/types.ts` | **Modify.** Add the `dynamicParams` field to `NodeDefinition`. |
| `src/compiler/param-keys.ts` | **Create.** `buildSemanticKey` / `buildUniformKey` / `buildRendererKey`, extracted verbatim from the hook so they can be tested. |
| `src/compiler/use-live-compiler.ts` | **Modify.** Call the extracted builders instead of inlining them. |
| `src/compiler/glsl-generator.ts` | **Modify** sites 4, 5, 6. |
| `src/compiler/ir-compiler.ts` | **Modify** sites 7, 8. |
| `src/components/ShaderNode.tsx` | **Modify** site 9. |
| `scripts/verify-dynamic-params.ts` | **Create.** The gate. |

---

### Task 1: Extract the change-detection keys so they can be tested

**Files:**
- Create: `src/compiler/param-keys.ts`
- Modify: `src/compiler/use-live-compiler.ts:234-290`

**Interfaces:**
- Produces: `buildSemanticKey(nodes: Node<NodeData>[], edges: Edge[]): string`,
  `buildUniformKey(nodes: Node<NodeData>[]): string`,
  `buildRendererKey(nodes: Node<NodeData>[]): string`

This is a pure refactor with **no behaviour change**. Doing it first means every
later task has something to assert against; leaving the keys inside `useMemo`
would make the most important half of this feature untestable.

- [ ] **Step 1: Read the three `useMemo` bodies**

Open `src/compiler/use-live-compiler.ts` and read `semanticKey` (~:234),
`uniformKey` (~:258) and `rendererKey` (~:276) in full. Note exactly what each
includes besides params — `semanticKey` also folds in structure (node types and
edges); the others do not. **Copy the bodies verbatim.** Any behaviour change
here will look like a recompile bug later and be very hard to attribute.

- [ ] **Step 2: Create `src/compiler/param-keys.ts`**

Move the three bodies into exported functions, taking `nodes` (and `edges` for
the semantic key) as arguments instead of closing over them. Keep the logic
character-for-character; only the surrounding function signature changes.

- [ ] **Step 3: Call them from the hook**

Replace each `useMemo` body with a call, preserving the existing dependency
arrays:

```ts
const semanticKey = useMemo(() => buildSemanticKey(nodes, edges), [nodes, edges])
const uniformKey  = useMemo(() => buildUniformKey(nodes), [nodes])
const rendererKey = useMemo(() => buildRendererKey(nodes), [nodes])
```

- [ ] **Step 4: Prove the refactor changed nothing**

Run: `npx tsc -b && npm run lint && npm run verify:ci && npm run self-validate`
Expected: all pass, `self-validate` 0 FAIL / 0 WARN.

Then in the browser, with the dev server running (`preview_start`, never
`npm run dev` in a shell): load a graph, drag a slider, and confirm the preview
updates without a recompile spinner. That is the uniform fast path, and it is
what a broken `uniformKey` would silently destroy.

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/dynamic-params
git add src/compiler/param-keys.ts src/compiler/use-live-compiler.ts
git commit -m "refactor(compiler): extract the change-detection key builders

Pure move, no behaviour change. semanticKey, uniformKey and rendererKey lived
inside useMemos in a React hook, so nothing could assert on them without
rendering — which is what made the dynamicParams work untestable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Add `dynamicParams` and the shared resolver

**Files:**
- Create: `src/nodes/resolve-dynamic.ts`
- Modify: `src/nodes/types.ts` (the `NodeDefinition` interface, beside `dynamicInputs`)

**Interfaces:**
- Produces: `resolveParams(def: NodeDefinition, nodeParams: Record<string, unknown> | undefined): NodeParameter[]`
- Consumes: `NodeDefinition`, `NodeParameter` from `src/nodes/types`

- [ ] **Step 1: Add the field to `NodeDefinition`**

In `src/nodes/types.ts`, directly beneath `dynamicInputs`:

```ts
  /**
   * Per-instance parameters, the counterpart to `dynamicInputs`.
   *
   * A node whose parameter COUNT varies per instance (one opacity per layer,
   * say) cannot express that with the static `params` array. Declaring them here
   * makes them real params: connectable, uniform-backed, and animatable, rather
   * than literals baked into the shader on every edit.
   *
   * As with `dynamicInputs`, a static `params` array must ALSO be provided as a
   * fallback — several call sites read it before a node instance exists.
   */
  dynamicParams?: (params: Record<string, unknown>) => NodeParameter[]
```

- [ ] **Step 2: Create the resolver**

`src/nodes/resolve-dynamic.ts`:

```ts
import type { NodeDefinition, NodeParameter } from './types'

/**
 * The parameters a specific node instance actually has.
 *
 * Every site that iterates `definition.params` must go through this, or it sees
 * a different parameter set than codegen does. That divergence is silent: the
 * shader compiles, the uniform is simply absent, and the control does nothing.
 *
 * Returns `def.params` unchanged for nodes without `dynamicParams`, which is
 * every shipped node — so existing behaviour is untouched by construction.
 */
export function resolveParams(
  def: NodeDefinition,
  nodeParams: Record<string, unknown> | undefined,
): NodeParameter[] {
  if (!def.dynamicParams) return def.params ?? []
  return def.dynamicParams(nodeParams ?? {})
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: PASS. Nothing consumes the resolver yet; this only proves the types fit.

- [ ] **Step 4: Commit**

```bash
git add src/nodes/types.ts src/nodes/resolve-dynamic.ts
git commit -m "feat(nodes): dynamicParams, the per-instance counterpart to dynamicInputs

Adds the field and a single shared resolver. Inert until call sites adopt it:
resolveParams returns def.params unchanged when dynamicParams is absent, which
is every shipped node.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Gate proving dynamic params are invisible

**Files:**
- Create: `scripts/verify-dynamic-params.ts`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Consumes: `resolveParams` (Task 2), `buildSemanticKey`/`buildUniformKey` (Task 1), `compileGraph`, `compileGraphIR`
- Produces: `npm run verify:dynamic-params`

- [ ] **Step 1: Write the failing gate**

Create `scripts/verify-dynamic-params.ts`:

```ts
/**
 * Do parameters declared through `dynamicParams` reach codegen and change
 * detection?
 *
 * Nine call sites iterate `definition.params` directly. Any one of them left
 * unresolved makes a dynamic param silently absent: the shader compiles, the
 * uniform is never declared, and the control does nothing. The failure is
 * invisible, which is why this gate asserts uniform NAMES rather than success.
 *
 * Run: npx tsx scripts/verify-dynamic-params.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import { buildSemanticKey, buildUniformKey } from '../src/compiler/param-keys'
import { declare, variable, binary } from '../src/compiler/ir/types'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition, NodeParameter } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const gain = (i: number): NodeParameter => ({
  id: `gain_${i}`, label: `Gain ${i}`, type: 'float', default: 0.5,
  min: 0, max: 1, step: 0.01, connectable: true, updateMode: 'uniform',
})

/** Multiplies its colour input by the product of N per-instance gains. */
const testNode: NodeDefinition = {
  type: 'test_dyn_params',
  label: 'Test Dynamic Params',
  category: 'effect',
  inputs: [{ id: 'color', label: 'Color', type: 'color', default: [1, 1, 1, 1] }],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  // Static fallback, as dynamicInputs requires of ports.
  params: [gain(0)],
  dynamicParams: (params) => {
    const count = Math.max(1, Math.min(8, Number(params.gainCount) || 1))
    return Array.from({ length: count }, (_, i) => gain(i))
  },
  glsl: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    const product = gains.map((g) => ctx.inputs[g]).join(' * ')
    return `vec4 ${ctx.outputs.color} = ${ctx.inputs.color} * (${product});`
  },
  ir: (ctx) => {
    const gains = Object.keys(ctx.inputs).filter((k) => k.startsWith('gain_'))
    let acc = variable(ctx.inputs[gains[0]])
    for (const g of gains.slice(1)) acc = binary('*', acc, variable(ctx.inputs[g]), 'float')
    return {
      statements: [declare(ctx.outputs.color, 'vec4',
        binary('*', variable(ctx.inputs.color), acc, 'vec4'))],
      uniforms: [], standardUniforms: new Set<string>(),
    }
  },
}
nodeRegistry.register(testNode)

const graph = (gainCount: number, overrides: Record<string, unknown> = {}) => {
  const nodes = [
    n('src', 'checkerboard'),
    n('fx', 'test_dyn_params', { gainCount, ...overrides }),
    n('out', 'fragment_output'),
  ]
  const edges = [e('e1', 'src', 'color', 'fx', 'color'), e('e2', 'fx', 'color', 'out', 'color')]
  return { nodes, edges }
}

test('GLSL: every dynamic param becomes a uniform', () => {
  const { nodes, edges } = graph(3)
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `compile failed: ${JSON.stringify(plan.errors)}`)
  const names = plan.passes.flatMap((p) => p.userUniforms.map((u) => u.name))
  for (const i of [0, 1, 2]) {
    assert(names.some((nm) => nm.includes(`gain_${i}`)),
      `gain_${i} never became a uniform. Got: ${JSON.stringify(names)}`)
  }
})

test('WGSL: every dynamic param becomes a uniform', () => {
  const { nodes, edges } = graph(3)
  const plan = compileGraphIR(nodes, edges)
  // compileGraphIR returns WGSLMultiPassOutput | null — it has NO `success` or
  // `errors` field (ir-compiler.ts:483). null is its only failure signal.
  assert(plan !== null, 'IR compile returned null')
  const names = plan!.passes.flatMap((p) => p.userUniforms.map((u) => u.name))
  for (const i of [0, 1, 2]) {
    assert(names.some((nm) => nm.includes(`gain_${i}`)),
      `gain_${i} never became a uniform on the IR path. Got: ${JSON.stringify(names)}`)
  }
})

test('uniformKey reacts to a dynamic param value', () => {
  const a = buildUniformKey(graph(3).nodes)
  const b = buildUniformKey(graph(3, { gain_2: 0.25 }).nodes)
  assert(a !== b,
    'uniformKey ignored a dynamic param — dragging that slider would not reach the GPU')
})

test('semanticKey reacts to the param COUNT', () => {
  const a = buildSemanticKey(graph(2).nodes, graph(2).edges)
  const b = buildSemanticKey(graph(3).nodes, graph(3).edges)
  assert(a !== b,
    'semanticKey ignored the param count — adding a layer would not recompile')
})

test('a node without dynamicParams is unaffected', () => {
  const nodes = [n('src', 'noise'), n('out', 'fragment_output')]
  const edges = [e('e1', 'src', 'color', 'out', 'color')]
  const plan = compileGraph(nodes, edges)
  assert(plan.success, `static-param node regressed: ${JSON.stringify(plan.errors)}`)
})

run('dynamic-params')
```

- [ ] **Step 2: Register it**

In `package.json`:

```json
"verify:dynamic-params": "tsx scripts/verify-dynamic-params.ts",
```

- [ ] **Step 3: Run it and confirm it FAILS**

Run: `npm run verify:dynamic-params`
Expected: the first four tests FAIL — no `gain_1` / `gain_2` uniforms, and both
keys blind to dynamic params. Paste the output into the commit.

If the GLSL/WGSL tests *pass* at this point, stop and report: it would mean
codegen already resolves dynamic params somewhere this plan hasn't found, and
the site table above is wrong.

- [ ] **Step 4: Commit the failing gate**

```bash
git add scripts/verify-dynamic-params.ts package.json
git commit -m "test(verify): gate dynamic params

Fails before the call sites adopt resolveParams: params declared through
dynamicParams never become uniforms, and neither uniformKey nor semanticKey
reacts to them. Asserts uniform names and key changes, not compile success —
it compiles today with the params missing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Adopt the resolver at all nine sites

**Files:**
- Modify: `src/compiler/param-keys.ts` (sites 1–3)
- Modify: `src/compiler/glsl-generator.ts:196,500,538` (sites 4–6)
- Modify: `src/compiler/ir-compiler.ts:208,242` (sites 7–8)
- Modify: `src/components/ShaderNode.tsx:273` (site 9)

**Interfaces:**
- Consumes: `resolveParams` from `src/nodes/resolve-dynamic`

The mechanical change at every site is the same: replace the direct read of
`def.params` / `definition.params` with `resolveParams(def, <that node's params>)`.
The node's own params object is already in scope at each site — `n.data.params`
in the key builders, `node.data.params` in the compilers, `currentValues` in
ShaderNode.

- [ ] **Step 1: Sites 1–3, the key builders**

In `src/compiler/param-keys.ts`, in each of the three functions, replace
`def?.params` / `def.params` with:

```ts
const params = resolveParams(def, n.data.params)
```

and iterate `params`. Keep each function's existing filter (`recompile`,
`uniform`, `renderer` respectively) untouched.

**`buildSemanticKey` needs one addition beyond the swap:** it must also fold in
the *count*, because two instances can have the same recompile-param values while
differing in how many params exist. Include `params.length` in that node's key
fragment. Without it, adding a layer would not trigger a recompile — which the
fourth gate test checks.

- [ ] **Step 2: Site 4, `partitionPasses`**

`src/compiler/glsl-generator.ts:196`, replace:

```ts
    if (def.params) {
      for (const param of def.params) {
        if (!param.connectable) continue
```

with:

```ts
    // Dynamic params can be connectable too, and a connectable param feeding
    // this node contributes to its pass depth. Missing them here schedules the
    // node into the wrong pass.
    for (const param of resolveParams(def, node.data.params)) {
      if (!param.connectable) continue
```

- [ ] **Step 3: Sites 5–8, the two codegen paths**

In `glsl-generator.ts:500` and `:538`, and `ir-compiler.ts:208` and `:242`,
replace each `if (definition.params) { for (const param of definition.params) {`
with:

```ts
    for (const param of resolveParams(definition, node.data.params)) {
```

removing the now-redundant `if` and its closing brace. Keep each loop's existing
`continue` filters exactly as they are.

- [ ] **Step 4: Site 9, the node body**

`src/components/ShaderNode.tsx:273`, replace:

```ts
  const allParams = definition.params || []
```

with:

```ts
  const allParams = resolveParams(definition, currentValues)
```

Confirm `currentValues` is the node's params record at that point in the file; if
it is named differently, use the correct name and note it in your report.

- [ ] **Step 5: Run the gate**

Run: `npm run verify:dynamic-params`
Expected: 5 passed, 0 failed.

- [ ] **Step 6: Prove no existing node moved**

Run: `npx tsc -b && npm run lint && npm run verify:ci && npm run self-validate`
Expected: all pass. `self-validate` must report **0 FAIL / 0 WARN and the same
shader counts as before this branch** — every shipped node lacks `dynamicParams`,
so its output must be byte-identical. A changed count means the resolver is not
returning `def.params` unchanged.

- [ ] **Step 7: Perturb, one site at a time**

Revert site 6 (`glsl-generator.ts:538`) alone and re-run the gate: the GLSL
uniform test must fail while the WGSL one still passes. Restore it. Then revert
site 2 alone: the `uniformKey` test must fail while the uniform tests pass.
Restore. This proves the gate distinguishes sites rather than passing wholesale.

- [ ] **Step 8: Commit**

```bash
git add src/compiler/param-keys.ts src/compiler/glsl-generator.ts src/compiler/ir-compiler.ts src/components/ShaderNode.tsx
git commit -m "feat(compiler): resolve dynamicParams at every param call site

Nine sites iterated definition.params directly: three change-detection keys,
partitionPasses' connectable-depth loop, two codegen paths x two loops each, and
the node body. Any one left unresolved makes a dynamic param silently absent —
the shader compiles, the uniform is never declared, the control does nothing.

semanticKey additionally folds in the param COUNT, or adding a layer would not
recompile.

collectCurrentUniformValues is deliberately untouched: it iterates the uniform
specs codegen produced and reads node.data.params by id, so it handles dynamic
params already.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Add the gate to `verify:ci`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append to the chain**

Add `&& npm run verify:dynamic-params` to `verify:ci`. It is node-only.

- [ ] **Step 2: Run**

Run: `npm run verify:ci`
Expected: exit 0, with the five new tests in the output.

- [ ] **Step 3: Commit and stop**

```bash
git add package.json
git commit -m "test(verify): run the dynamic-params gate in CI

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**Do not push and do not merge.** Report with: the Task 3 failure output, the
per-site perturbation results from Task 4 Step 7, and `self-validate`'s
FAIL/WARN and shader counts before and after.

---

## What this plan deliberately does NOT do

- **No UI for dynamic params.** `ShaderNode` renders whatever `resolveParams`
  returns using the existing controls. A layer-list body is Phase D.
- **No Stack node.** The synthetic node lives only in the gate.
- **No relay pruning or liveness reuse.** Separate plan.
- **No `dynamicInputs` refactor.** That resolution stays inline where it is;
  unifying the two is a cleanup, not part of this feature.
