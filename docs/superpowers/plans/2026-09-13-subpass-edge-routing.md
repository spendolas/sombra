# Per-Sub-Pass Edge Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `multiPass` node expand without a wired chain input, and choose which of its incoming edges reach which sub-pass — the two things the Stack node's accumulate chain needs from `expand-passes.ts`.

**Architecture:** `expandMultiPassNodes` turns a `multiPass` node into a chain of virtual nodes before partitioning. It makes two assumptions that are correct for blur and fatal for Stack: expansion is skipped when the chain input is unwired (`expand-passes.ts:70-71`), and **every** non-chain incoming edge is duplicated onto **every** sub-pass (`:111-113`). For Stack, the chain input is wired by the expansion itself and never by the user, and duplicating every layer's source onto every sub-pass would bind all N layer textures into all N passes — recreating the exact sampler explosion the accumulate chain exists to avoid.

**Tech Stack:** TypeScript (strict), `tsx` scripts as the test suite, GLSL ES 3.0 + WGSL codegen.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` §4 (the two extensions), §6.5

## Global Constraints

- **Both extensions are opt-in.** Blur, Kawase blur and Pyramid blur all depend on
  today's behaviour. A node that declares neither new field must expand
  byte-identically — `self-validate` must hold at 468/468 shaders.
- **A gate must be seen to fail**, and each extension must be distinguishable
  from the other when reverted alone. Two features in one file is exactly the
  shape that produces "half a fix, fully green".
- **Mechanism-engaged assertions.** Assert *which* edges reached *which*
  sub-pass, and the pass count — not that compilation succeeded. It succeeds
  today while routing everything everywhere.
- **Do not push.** `main` deploys to sombra.sh on push.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** Where a signature differs, the
  source wins — fix it and say so.
- **A line number is a pointer, not a description.** Read the code at every cited
  line before changing it.

## File Structure

| File | Responsibility |
|---|---|
| `src/nodes/types.ts` | **Modify.** Two optional fields on `multiPass`. |
| `src/compiler/expand-passes.ts` | **Modify.** Honour them near `:68-71` and `:101-105` — line numbers drift, locate by pattern. |
| `scripts/verify-subpass-routing.ts` | **Create.** The gate. |
| `package.json` | **Modify.** Register the gate, add to `verify:ci`. |

---

### Task 1: Declare the two extensions

**Files:**
- Modify: `src/nodes/types.ts` (the `multiPass` object, ~`:344-360`)

**Interfaces:**
- Produces: `multiPass.requiresWiredSource?: boolean` and
  `multiPass.routeEdge?: (targetHandle: string, passIndex: number, params: Record<string, unknown>) => boolean`

- [ ] **Step 1: Add the fields**

Inside the `multiPass` object type, after `to`:

```ts
    /**
     * Whether expansion requires the chain input to be wired. Default true.
     *
     * Blur filters an upstream texture, so with nothing wired there is nothing
     * to filter and extra passes would only re-read a blank target — hence the
     * default. A node that GENERATES its chain (compositing layers onto a
     * running result, where sub-pass 0 starts from transparent) sets this false:
     * its `to` port is wired by the expansion itself and never by the user.
     */
    requiresWiredSource?: boolean

    /**
     * Which of this node's incoming edges reach which sub-pass. Default: all
     * edges reach all sub-passes.
     *
     * That default is right for blur — a connectable radius must reach both
     * axes, or the two disagree and the result is anisotropic. It is wrong for a
     * node whose inputs belong to specific steps: duplicating every layer's
     * source onto every sub-pass binds all N textures into all N passes, which
     * is the sampler explosion a sequential chain exists to avoid.
     *
     * Called once per (edge, sub-pass) pair for sub-passes after the first.
     * Return false to withhold that edge from that sub-pass.
     */
    routeEdge?: (
      targetHandle: string,
      passIndex: number,
      params: Record<string, unknown>,
    ) => boolean
```

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b
git fetch origin && git checkout -b feat/subpass-routing origin/main
git add src/nodes/types.ts
git commit -m "feat(nodes): declare requiresWiredSource and routeEdge on multiPass

Inert until expand-passes honours them. Both default to today's behaviour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate proving both assumptions bite

**Files:**
- Create: `scripts/verify-subpass-routing.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `expandMultiPassNodes` from `src/compiler/expand-passes`
- Produces: `npm run verify:subpass-routing`

Testing `expandMultiPassNodes` directly rather than through the compiler is
deliberate: it returns `{nodes, edges, lastOf}`, so the gate can assert exactly
which edges reached which sub-pass. Going through `compileGraph` would only show
the consequences and would make a failure much harder to attribute.

- [ ] **Step 1: Write the failing gate**

```ts
/**
 * Can a multiPass node expand without a wired chain input, and route its
 * incoming edges per sub-pass?
 *
 * expandMultiPassNodes skips expansion when the chain input is unwired, and
 * duplicates every other incoming edge onto every sub-pass. Both are right for
 * blur and wrong for a node that composites a list: its chain input is wired by
 * the expansion itself, and its per-item inputs belong to one step each.
 *
 * Run: npx tsx scripts/verify-subpass-routing.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import { expandMultiPassNodes, SUB_PASS_PARAM } from '../src/compiler/expand-passes'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Node, Edge } from '@xyflow/react'
import type { NodeDefinition } from '../src/nodes/types'

initializeNodeLibrary()

const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

const layerPort = (i: number) => ({
  id: `layer_${i}`, label: `Layer ${i}`, type: 'color' as const,
  textureInput: true, default: [0, 0, 0, 0] as [number, number, number, number],
})

/**
 * Three sub-passes. `backdrop` is the chain input and is NEVER wired by the
 * fixture — the expansion wires it. Each layer_i belongs to sub-pass i only.
 */
const testNode: NodeDefinition = {
  type: 'test_stackish',
  label: 'Test Stackish',
  category: 'effect',
  inputs: [
    { id: 'backdrop', label: 'Backdrop', type: 'color', textureInput: true, default: [0, 0, 0, 0] },
    layerPort(0), layerPort(1), layerPort(2),
  ],
  outputs: [{ id: 'color', label: 'Color', type: 'color' }],
  params: [],
  multiPass: {
    count: () => 3,
    from: 'color',
    to: 'backdrop',
    requiresWiredSource: false,
    routeEdge: (targetHandle, passIndex) => targetHandle === `layer_${passIndex}`,
  },
  glsl: (ctx) => `vec4 ${ctx.outputs.color} = vec4(0.0);`,
  ir: () => ({ statements: [], uniforms: [], standardUniforms: new Set<string>() }),
}
nodeRegistry.register(testNode)

const nodes = [
  n('a', 'checkerboard'), n('b', 'gradient'), n('c', 'checkerboard'),
  n('fx', 'test_stackish'),
  n('out', 'fragment_output'),
]
const edges = [
  e('e0', 'a', 'color', 'fx', 'layer_0'),
  e('e1', 'b', 'color', 'fx', 'layer_1'),
  e('e2', 'c', 'color', 'fx', 'layer_2'),
  e('e3', 'fx', 'color', 'out', 'color'),
]

const subPassNodes = (out: { nodes: Node[] }) =>
  out.nodes.filter((x) => (x.data as { type: string }).type === 'test_stackish')

test('expansion happens even though the chain input is unwired', () => {
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const chain = subPassNodes(out as never)
  assert(chain.length === 3,
    `expected 3 sub-passes, got ${chain.length} — expansion was skipped because 'backdrop' is unwired`)
  const indices = chain
    .map((x) => Number((x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM] ?? 0))
    .sort()
  assert(JSON.stringify(indices) === '[0,1,2]', `sub-pass indices wrong: ${JSON.stringify(indices)}`)
})

test('each layer edge reaches only its own sub-pass', () => {
  const out = expandMultiPassNodes(nodes as never, edges as never)
  const chain = subPassNodes(out as never)
  const byIndex = new Map(chain.map((x) =>
    [Number((x.data as { params: Record<string, unknown> }).params[SUB_PASS_PARAM] ?? 0), x.id]))

  for (const passIndex of [0, 1, 2]) {
    const nodeId = byIndex.get(passIndex)!
    const incoming = (out as unknown as { edges: Edge[] }).edges
      .filter((x) => x.target === nodeId && x.targetHandle?.startsWith('layer_'))
      .map((x) => x.targetHandle)
    assert(incoming.length === 1,
      `sub-pass ${passIndex} received ${incoming.length} layer edges (${JSON.stringify(incoming)}) — every layer was duplicated onto every sub-pass`)
    assert(incoming[0] === `layer_${passIndex}`,
      `sub-pass ${passIndex} received ${incoming[0]}`)
  }
})

test('a node with neither field expands exactly as before', () => {
  // blur is the reference consumer: multiPass with a wired source and no routing.
  const bn = [n('src', 'checkerboard'), n('fx', 'blur'), n('out', 'fragment_output')]
  const be = [e('b0', 'src', 'color', 'fx', 'source'), e('b1', 'fx', 'color', 'out', 'color')]
  const out = expandMultiPassNodes(bn as never, be as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'blur')
  assert(chain.length === 2, `blur should expand to 2 sub-passes, got ${chain.length}`)
})

test('an unwired chain input still skips expansion when the field is absent', () => {
  const bn = [n('fx', 'blur'), n('out', 'fragment_output')]
  const be = [e('b1', 'fx', 'color', 'out', 'color')]
  const out = expandMultiPassNodes(bn as never, be as never)
  const chain = (out as unknown as { nodes: Node[] }).nodes
    .filter((x) => (x.data as { type: string }).type === 'blur')
  assert(chain.length === 1,
    'blur with nothing wired into `source` must NOT expand — extra passes would re-read a blank target')
})

run('subpass-routing')
```

- [ ] **Step 2: Register and run**

```json
"verify:subpass-routing": "tsx scripts/verify-subpass-routing.ts",
```

Run: `npm run verify:subpass-routing`
Expected: tests 1 and 2 FAIL (expansion skipped; every layer on every sub-pass),
tests 3 and 4 PASS. That split matters — it proves the gate can tell the new
behaviour from the old rather than just rejecting everything.

- [ ] **Step 3: Commit the failing gate**

```bash
git add scripts/verify-subpass-routing.ts package.json
git commit -m "test(verify): gate sourceless expansion and per-sub-pass routing

Fails on main: a multiPass node with an unwired chain input does not expand, and
every non-chain incoming edge is duplicated onto every sub-pass. Blur's existing
behaviour is asserted unchanged alongside, so the gate distinguishes the new
cases from a blanket change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Honour `requiresWiredSource`

**Files:**
- Modify: `src/compiler/expand-passes.ts:70-71`

- [ ] **Step 1: Make the skip conditional**

Replace:

```ts
    const hasSource = edges.some((e) => e.target === node.id && e.targetHandle === mp.to)
    if (!hasSource) continue
```

with:

```ts
    // A node that FILTERS an upstream texture has nothing to do without one, so
    // the default stands. A node that GENERATES its chain wires `to` during
    // expansion, so requiring it wired first would never let it start.
    if (mp.requiresWiredSource !== false) {
      const hasSource = edges.some((e) => e.target === node.id && e.targetHandle === mp.to)
      if (!hasSource) continue
    }
```

- [ ] **Step 2: Run the gate**

Run: `npm run verify:subpass-routing`
Expected: test 1 now PASSES; test 2 still fails; tests 3 and 4 still pass.
**If test 4 now fails, stop** — the default has changed and every blur in the app
with an unwired source would start expanding.

- [ ] **Step 3: Prove nothing moved**

Run: `npx tsc -b && npm run lint && npm run verify:ci && npm run self-validate`
Expected: all pass; `self-validate` **468/468 shaders unchanged**.

- [ ] **Step 4: Perturb and commit**

Revert, confirm test 1 fails again, restore.

```bash
git add src/compiler/expand-passes.ts
git commit -m "feat(compiler): allow multiPass expansion without a wired chain input

Opt-in via requiresWiredSource: false. The default is unchanged, because a node
that filters an upstream texture genuinely has nothing to filter without one —
but a node that generates its chain wires that port during expansion, so the
check would never let it start.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Honour `routeEdge`

**Files:**
- Modify: `src/compiler/expand-passes.ts:111-113`

- [ ] **Step 1: Filter the duplicated edges**

The loop currently reads:

```ts
        for (const e of edges) {
          if (e.target !== node.id) continue
          if (e.targetHandle === plan.to) continue // that is the chain input
          outEdges.push({ ...e, id: `${e.id}${SUFFIX}${k}`, target: id } as Edge<EdgeData>)
        }
```

Add the routing check before the push:

```ts
        for (const e of edges) {
          if (e.target !== node.id) continue
          if (e.targetHandle === plan.to) continue // that is the chain input
          // Without a routing function every edge reaches every sub-pass, which
          // is what a blur's connectable radius needs. With one, an input that
          // belongs to a single step stays there instead of binding into all.
          if (plan.routeEdge && e.targetHandle
              && !plan.routeEdge(e.targetHandle, k, node.data.params || {})) continue
          outEdges.push({ ...e, id: `${e.id}${SUFFIX}${k}`, target: id } as Edge<EdgeData>)
        }
```

`plan` is the entry built at `:73`; **it does not carry `routeEdge` yet** — extend
the `plans.set(...)` call and the `plans` map's type to include it, reading from
`mp.routeEdge`. Read `:66-73` and adapt; do not assume the shape.

- [ ] **Step 2: Sub-pass 0 — settled in pre-flight, not open**

Three lines decide it:

```
:76  const outEdges: Edge<EdgeData>[] = [...edges]            ← every original edge, kept
:87  const id = k === 0 ? node.id : `${node.id}${SUFFIX}${k}`  ← sub-pass 0 IS the authored node
:97  if (k > 0) { … duplication loop … }                       ← never runs for k = 0
```

The original `layer_*` edges target the authored id, which *is* sub-pass 0, and
the duplication loop — the only place Step 1 adds a filter — cannot reach them.
So Step 1 alone leaves **sub-pass 0 holding every layer edge**: test 2 fails for
sub-pass 0 while passing for 1 and 2.

**So the fix must also filter the initial `[...edges]` copy:** for each original
edge whose target has a plan, whose handle is not the chain input, and whose plan
declares `routeEdge`, keep it only if `routeEdge(handle, 0, params)`.

Without that, the extension is half-implemented in the "correct by luck" way —
`layer_0` lands right while the others leak into pass 0, reintroducing the exact
sampler explosion the extension exists to prevent.

- [ ] **Step 3: Run everything**

Run: `npm run verify:subpass-routing && npm run verify:ci && npm run self-validate`
Expected: 4/4, and 468/468 shaders unchanged.

- [ ] **Step 4: Distinguish "misplaced" from "vanished"**

A `routeEdge` that returns false at *every* sub-pass drops that wire from the
compiled graph entirely. Semantically that is the node saying "this input belongs
nowhere", so it is arguably correct — but an off-by-one in a routing function
then **silently discards a user's wire** rather than misplacing it, and the two
look identical to a pass-count assertion while being very different to the user.

Add a case asserting that every routed edge lands on exactly one sub-pass, and
that the total count of layer edges across all sub-passes equals the number
wired. A missing edge must fail differently from a misrouted one.

- [ ] **Step 5: Perturb each extension separately**

Revert `requiresWiredSource` alone → test 1 fails, test 2 passes.
Revert `routeEdge` alone → test 2 fails, test 1 passes.
If reverting one fails both, the gate cannot distinguish them and must be
extended before this ships.

- [ ] **Step 6: Commit**

```bash
git add src/compiler/expand-passes.ts
git commit -m "feat(compiler): route incoming edges per sub-pass

Opt-in via routeEdge. Default unchanged: every edge reaches every sub-pass,
which is what a blur's connectable radius needs — without it the two axes
disagree and the result is anisotropic. A node whose inputs belong to specific
steps can now keep them there, instead of binding every one into every pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Add to `verify:ci`, then stop

- [ ] **Step 1:** Append `&& npm run verify:subpass-routing` to `verify:ci`.
- [ ] **Step 2:** Run `npm run verify:ci`, expect exit 0.
- [ ] **Step 3:** Commit. **No push, no merge.**

Report with: the Task 2 failure output showing tests 1–2 failing while 3–4 pass,
what you found for sub-pass 0 in Task 4 Step 2, both separate perturbation
results, and `self-validate`'s shader counts.

---

## What this plan deliberately does NOT do

- **No Stack node.** The synthetic node lives only in the gate.
- **No changes to blur, kawase or pyramid.** Both extensions are opt-in and no
  shipped node sets either.
- **No liveness-based texture reuse.** Still unwritten, still waiting on the
  relay-pruning measurements.
