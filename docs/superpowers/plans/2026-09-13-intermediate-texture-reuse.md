# Intermediate Texture Reuse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop allocating one full-size intermediate texture per render pass.

**Corrected 2026-09-14 — this plan alone does NOT make layer count unbounded.** Measured on
compiler-produced plans: today costs 2N−1 textures for an N-layer Stack, and liveness costs
N+1. A near-halving, still linear. On the WebGL2 fallback's 8-intermediate cap that moves a
Stack from 4 layers to 7 — a higher ceiling, not no ceiling. **Constant memory needs the
companion plan** (`2026-09-14-consumer-ordered-emission.md`), which reorders passes so each
layer's source is produced next to the composite that reads it; the two together give 3
slots at any layer count. Ship them as a pair — liveness alone buys 6% on the real corpus
and is not worth touching both renderers for.

**Architecture:** Both renderers index their intermediate buffers by pass number — pass *i* renders into buffer *i*, and a consumer reads buffer *sourcePassIndex*. So an N-pass plan allocates N full-canvas textures that are each written once and then held for the life of the plan. The fix is a **liveness assignment** computed once in the compiler — a pure function over the finished plan — that gives each pass a *slot* rather than assuming its own index, reusing a slot once every pass that reads it has run. Both renderers then index by slot. Keeping the analysis in the compiler means it is testable in Node without a GPU and cannot drift between backends.

**Tech Stack:** TypeScript (strict), `tsx` scripts as the test suite, WebGPU + WebGL2.

**Spec:** `docs/superpowers/specs/2026-09-11-stack-compositing-node-design.md` §6.3
**Prior art:** `PHASE6-MULTIPASS.md` §P2 specifies exactly this ("2 textures for linear chains, grow for branches", graph-colouring / LRU).

## Read this before writing any code: it was tried, and it broke

`21d4477` — *"Fix preview ping-pong aliasing for deep multi-pass chains"*:

> With relay passes, a pass can read from a non-adjacent intermediate texture.
> The 2-texture ping-pong scheme caused read-write conflicts (same texture read
> and written in the same render pass).
>
> Fix: allocate one intermediate texture per non-final pass instead of
> ping-ponging. At 80x80 the memory cost is negligible.

Two things follow, and the plan is built on both.

**Simple alternation is known-broken, and this plan does not reinstate it.**
Two-texture ping-pong assumes each pass reads only the one before it. Relay
passes break that assumption, and a pass that reads and writes the same texture
is undefined behaviour. **Liveness assignment is a different thing**: a slot
becomes free only when the *last* pass that reads it has run, so a non-adjacent
read keeps its source alive by construction. That is what makes it safe where
alternation was not.

**The "negligible" judgement was about node thumbnails.** At 80×80 it is true.
The main renderer allocates at canvas device-pixel size — **132.7 MB per texture
at 4K/dpr2** — so the same call goes the other way. This plan changes the main
renderers; the preview renderers keep one-per-pass unless a later measurement
says otherwise.

## Global Constraints

- **Correctness outranks the saving, always.** A wrong assignment produces a
  read-write conflict: undefined pixels, a plausible wrong image, or a driver
  warning nobody reads. If in doubt, allocate more slots.
- **Both renderers, one source of truth.** The assignment is computed in the
  compiler and consumed by both. Do not implement liveness twice.
- **A gate must be seen to fail**, and it must include the shape from `21d4477`
  — relay passes reading non-adjacent textures — or this plan repeats history.
- **Mechanism-engaged assertions.** Assert *no live overlap* (no slot is written
  by a pass while a later pass still needs its previous contents) and *slot count
  below pass count*. Either alone is satisfiable by a wrong answer: a correct
  no-overlap result is "give everything its own slot", and a small slot count is
  "reuse everything immediately".
- **Do not push.** `main` deploys to sombra.sh on push.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **The code in this plan has never been run.** Where a signature differs, the
  source wins — fix it and say so.

## File Structure

| File | Responsibility |
|---|---|
| `src/compiler/texture-slots.ts` | **Create.** `assignTextureSlots(passes)` — the pure liveness analysis. |
| `src/compiler/glsl-generator.ts` | **Modify.** Call it; put `targetSlot` on each `RenderPass` and `slotCount` on the plan. |
| `src/compiler/ir-compiler.ts` | **Modify.** Same for the WGSL plan. |
| `src/webgpu/renderer.ts` | **Modify.** Allocate `slotCount` textures; index by slot. |
| `src/webgl/renderer.ts` | **Modify.** Same for the FBO pool. |
| `scripts/verify-texture-slots.ts` | **Create.** The gate. |

---

### Task 1: The liveness assignment

**Files:**
- Create: `src/compiler/texture-slots.ts`

**Interfaces:**
- Produces: `assignTextureSlots(passes: PassLiveness[]): { slotOfPass: number[]; slotCount: number }`
  where `PassLiveness = { index: number; readsPassIndices: number[]; sizeKey: string }`

Taking a minimal shape rather than the full `RenderPass` keeps this callable from
both compilers, whose pass types differ (`fragmentShader` vs `shaderCode`, and
`inputTextures` as a `Record` on one and an `Array` on the other — see the
cross-backend note in §Constraints of the relay-pruning plan).

- [ ] **Step 1: Write it**

```ts
/**
 * Which physical texture each pass renders into.
 *
 * Renderers index intermediates by pass number, so an N-pass plan holds N
 * full-canvas textures alive for the life of the plan. Most are dead long
 * before that: a slot is only needed until the LAST pass that reads it has run.
 *
 * Not ping-pong. Two-texture alternation assumes each pass reads the one before
 * it, which relay passes violate — that bug is why one-texture-per-pass exists
 * today (21d4477). Liveness handles a non-adjacent read by construction,
 * because the source stays alive until its final reader.
 *
 * Passes of different target sizes never share a slot: `sizeKey` buckets them.
 */
export interface PassLiveness {
  index: number
  /** Pass indices whose OUTPUT this pass samples. */
  readsPassIndices: number[]
  /** Passes sharing a key have identical target dimensions. */
  sizeKey: string
}

export function assignTextureSlots(
  passes: PassLiveness[],
): { slotOfPass: number[]; slotCount: number } {
  // lastReader[i] = the highest pass index that reads pass i's output.
  // -1 means nothing reads it (the final pass, which renders to the canvas).
  const lastReader = new Array<number>(passes.length).fill(-1)
  for (const p of passes) {
    for (const src of p.readsPassIndices) {
      if (src >= 0 && src < passes.length) {
        lastReader[src] = Math.max(lastReader[src], p.index)
      }
    }
  }

  const slotOfPass = new Array<number>(passes.length).fill(-1)
  const slotSizeKey: string[] = []
  // Which pass currently owns each slot, so we know when it frees.
  const slotOwner: number[] = []

  for (const p of passes) {
    // Free every slot whose owner has no reader left after this point.
    for (let s = 0; s < slotOwner.length; s++) {
      const owner = slotOwner[s]
      if (owner >= 0 && lastReader[owner] < p.index) slotOwner[s] = -1
    }

    // A pass nothing reads needs no intermediate at all.
    if (lastReader[p.index] === -1) continue

    // Reuse a free slot of the right size, else open a new one.
    let slot = slotOwner.findIndex((o, s) => o === -1 && slotSizeKey[s] === p.sizeKey)
    if (slot === -1) {
      slot = slotOwner.length
      slotOwner.push(-1)
      slotSizeKey.push(p.sizeKey)
    }
    slotOwner[slot] = p.index
    slotOfPass[p.index] = slot
  }

  return { slotOfPass, slotCount: slotOwner.length }
}
```

**The subtle line is `lastReader[owner] < p.index`.** A slot frees only once the
pass about to run is *past* its owner's final reader. Using `<=` would let a pass
write the slot it is reading this very moment — precisely the read-write conflict
`21d4477` describes.

- [ ] **Step 2: Typecheck and commit**

```bash
npx tsc -b
git fetch origin && git checkout -b perf/texture-slot-reuse origin/main
git add src/compiler/texture-slots.ts
git commit -m "feat(compiler): liveness assignment for intermediate textures

Pure, unused so far. Not ping-pong: a slot frees only after its last reader,
so a relay's non-adjacent read cannot alias — the bug that removed ping-pong
in 21d4477.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Gate the assignment, including the shape that broke before

**Files:**
- Create: `scripts/verify-texture-slots.ts`
- Modify: `package.json`

- [ ] **Step 1: Write it**

```ts
/**
 * Does slot assignment reuse textures without ever aliasing a live one?
 *
 * Asserts BOTH properties, because each alone is satisfied by a wrong answer:
 * "no overlap" is satisfied by giving every pass its own slot (today's
 * behaviour, zero saving), and "few slots" is satisfied by reusing immediately
 * (the 21d4477 bug, wrong pixels).
 *
 * Run: npx tsx scripts/verify-texture-slots.ts
 */
import { assignTextureSlots, type PassLiveness } from '../src/compiler/texture-slots'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

const chain = (n: number): PassLiveness[] =>
  Array.from({ length: n }, (_, i) => ({
    index: i, readsPassIndices: i === 0 ? [] : [i - 1], sizeKey: 'full',
  }))

/** Independent branches that all converge on the final pass — the Stack shape. */
const converge = (branches: number): PassLiveness[] => {
  const passes: PassLiveness[] = []
  for (let i = 0; i < branches; i++) passes.push({ index: i, readsPassIndices: [], sizeKey: 'full' })
  passes.push({ index: branches, readsPassIndices: passes.map((p) => p.index), sizeKey: 'full' })
  return passes
}

/** The 21d4477 shape: a late pass reads a NON-ADJACENT earlier one. */
const nonAdjacent = (): PassLiveness[] => [
  { index: 0, readsPassIndices: [], sizeKey: 'full' },
  { index: 1, readsPassIndices: [0], sizeKey: 'full' },
  { index: 2, readsPassIndices: [1], sizeKey: 'full' },
  { index: 3, readsPassIndices: [0, 2], sizeKey: 'full' },  // reaches back to pass 0
]

/** No slot may be overwritten while a later pass still needs its contents. */
function assertNoAliasing(passes: PassLiveness[], slotOfPass: number[]) {
  const lastReader = new Array<number>(passes.length).fill(-1)
  for (const p of passes) for (const s of p.readsPassIndices) {
    lastReader[s] = Math.max(lastReader[s], p.index)
  }
  for (const writer of passes) {
    const slot = slotOfPass[writer.index]
    if (slot === -1) continue
    for (const other of passes) {
      if (other.index >= writer.index) continue
      if (slotOfPass[other.index] !== slot) continue
      assert(lastReader[other.index] < writer.index,
        `pass ${writer.index} overwrites slot ${slot} while pass ${other.index}'s output is still read by pass ${lastReader[other.index]}`)
    }
  }
}

test('a linear chain needs far fewer slots than passes', () => {
  const passes = chain(8)
  const { slotOfPass, slotCount } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotCount <= 2, `a linear chain should need at most 2 slots, got ${slotCount}`)
})

// NOTE: `converge()` models N branches read by ONE pass — the architecture spec §4
// REJECTED. It is kept only to prove the analysis is correct on that shape; it is not the
// Stack. The Stack's real shape is N sources at one depth plus a sequential chain, which
// this plan's companion measures on compiler-produced plans rather than hand-built lists.
test('converging branches keep every source alive until the merge', () => {
  const passes = converge(5)
  const { slotOfPass, slotCount } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotCount === 5, `all 5 branches are read by the final pass, so all 5 must stay alive; got ${slotCount}`)
})

test('a non-adjacent read does not alias — the 21d4477 case', () => {
  const passes = nonAdjacent()
  const { slotOfPass } = assignTextureSlots(passes)
  assertNoAliasing(passes, slotOfPass)
  assert(slotOfPass[0] !== slotOfPass[1],
    'pass 0 is still read by pass 3, so pass 1 must not reuse its slot')
})

test('passes of different sizes never share a slot', () => {
  const passes: PassLiveness[] = [
    { index: 0, readsPassIndices: [], sizeKey: 'half' },
    { index: 1, readsPassIndices: [0], sizeKey: 'full' },
    { index: 2, readsPassIndices: [1], sizeKey: 'full' },
  ]
  const { slotOfPass } = assignTextureSlots(passes)
  const half = slotOfPass[0]
  assert(slotOfPass[1] !== half && slotOfPass[2] !== half,
    'a full-size pass reused a half-size slot')
})

test('the final pass needs no slot', () => {
  const passes = chain(4)
  const { slotOfPass } = assignTextureSlots(passes)
  assert(slotOfPass[3] === -1, 'the last pass renders to the canvas and should own no intermediate')
})

run('texture-slots')
```

- [ ] **Step 2: Register, run, and perturb**

```json
"verify:texture-slots": "tsx scripts/verify-texture-slots.ts",
```

Run it — expect 5/5. This gate cannot "fail on main" because the function is new;
its value is in the perturbations, so **do all three and report each**:

1. Change `lastReader[owner] < p.index` to `<=` → the non-adjacent test must fail.
2. Make the function return `{ slotOfPass: passes.map(p => p.index), slotCount: passes.length }`
   (today's behaviour) → the linear-chain test must fail, the aliasing tests must pass.
3. Drop the `sizeKey` check from the reuse search → the mixed-size test must fail.

If any perturbation leaves the suite green, that property is untested and the gate
needs extending before you go further.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-texture-slots.ts package.json
git commit -m "test(verify): gate texture slot assignment

Asserts no-aliasing AND slot reduction together; each alone is satisfied by a
wrong answer. Includes the 21d4477 non-adjacent-read shape that broke the
original ping-pong scheme. Three perturbations recorded in the report.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Emit slots from both compilers

**Files:**
- Modify: `src/compiler/glsl-generator.ts` (the `RenderPass` interface and plan assembly)
- Modify: `src/compiler/ir-compiler.ts` (the `WGSLPassOutput` interface and plan assembly)

- [ ] **Step 1: Extend both pass types**

Add to `RenderPass` and `WGSLPassOutput`:

```ts
  /**
   * Physical intermediate this pass renders into, or -1 for the final pass,
   * which targets the canvas. Renderers must index buffers by THIS, not by
   * pass index — see src/compiler/texture-slots.ts.
   */
  targetSlot?: number
```

and to both plan types: `slotCount?: number`.

Both stay optional so a renderer that has not been updated yet keeps working —
that is what lets Tasks 4 and 5 land separately.

- [ ] **Step 2: Compute after the passes are final**

At the end of plan assembly, once every pass (including relays) exists:

```ts
const liveness = passes.map((p) => ({
  index: p.index,
  readsPassIndices: <the source pass indices this pass samples>,
  sizeKey: `${p.resolution ?? 1}`,
}))
const { slotOfPass, slotCount } = assignTextureSlots(liveness)
```

then set `targetSlot` on each pass and `slotCount` on the plan.

**`readsPassIndices` differs per backend** — `Object.values(pass.inputTextures)`
on the GLSL path (`Record<samplerName, passIndex>`), and
`pass.inputTextures.map(t => t.passIndex)` on the IR path (`Array<{passIndex, samplerName}>`).
Read both before writing either.

**`sizeKey` must capture everything that affects target dimensions.** `resolution`
is the known one; check `passTargetSize` in `src/renderer/pass-size.ts` for
anything else, and report what you find. Getting this wrong means a pass writing
into a texture of the wrong size.

- [ ] **Step 3: Verify the plans carry sane slots**

Extend the gate with a case that compiles a real graph (a chain of pixelates)
and asserts `slotCount < passes.length` while `assertNoAliasing` holds over the
real plan. Run `verify:ci` and `self-validate` — nothing should change yet,
because no renderer reads the field.

- [ ] **Step 4: Commit**

```bash
git add src/compiler/glsl-generator.ts src/compiler/ir-compiler.ts scripts/verify-texture-slots.ts
git commit -m "feat(compiler): emit a target slot per pass on both backends

Optional fields, unread by any renderer yet, so this changes nothing on its own.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: WebGPU renderer honours slots

**Files:**
- Modify: `src/webgpu/renderer.ts` (allocation ~`:700-725`, target selection `:1211`, source binding `:778`)

- [ ] **Step 1: Allocate by slot**

Allocate `plan.slotCount` textures instead of one per pass, sizing each from the
passes assigned to it (they share a `sizeKey`, so any of them will do — assert
that rather than assuming it).

- [ ] **Step 2: Render and read by slot**

`:1211` — target `intermediateTextures[pass.targetSlot]` rather than `[i]`.
`:778` — a consumer binds the slot of its **source pass**, i.e.
`intermediateTextures[slotOfPass[srcPassIdx]]`, so the plan must carry that
lookup or the renderer must rebuild it from `targetSlot`.

**Fall back to the old behaviour when `targetSlot` is absent**, so an
un-migrated plan still renders.

- [ ] **Step 3: Verify on real hardware**

Run the dev server through `preview_start` (never `npm run dev` in a shell) and
check, on WebGPU:

1. A deep chain (5+ pixelates) renders identically to `main`. Screenshot both.
2. **The `21d4477` shape**: two blurred branches converging into a mix, which is
   where a relay reads a non-adjacent texture. This is the case that broke the
   original scheme — compare pixels, not just "it rendered".
3. `MAX_INTERMEDIATE_TEXTURES` is no longer the ceiling it was: build a graph
   that previously needed more than 32 intermediates and confirm it now compiles.

Report the slot counts alongside the pass counts for each.

- [ ] **Step 4: Commit**

---

### Task 5: WebGL2 renderer honours slots

**Files:**
- Modify: `src/webgl/renderer.ts` (FBO pool `:359-387`, `:937`, `:952`)

- [ ] **Step 1: Same change, same fallback.**

- [ ] **Step 2: Verify the same three cases on `?backend=webgl2`**, plus one
      more: the desktop cap is 8 intermediates, so a graph that previously hit
      "Graph needs 9 intermediate render targets" should now succeed. That error
      is Phase A's, and watching it stop firing is the clearest proof this
      plan worked.

- [ ] **Step 3: Full gate run, then commit and stop.**

Report with: all three perturbation results from Task 2, slot-vs-pass counts for
each verified graph, the before/after screenshots, and confirmation that the
WebGL2 over-cap error no longer fires on a graph that previously triggered it.

---

## What this plan deliberately does NOT do

- **The preview renderers keep one texture per pass.** At 80×80 the saving is
  negligible and the risk is not — that is exactly the judgement `21d4477` made,
  and it still holds there.
- **No preamble pruning.** Measured during relay pruning: the preamble is 57% of
  shader text at ten branches, and the next lever. Different axis (shader size,
  not memory), separate plan.
- **No change to `MAX_INTERMEDIATE_TEXTURES`.** It becomes a much looser bound
  once slots are reused; replacing it with a byte budget is its own change.
