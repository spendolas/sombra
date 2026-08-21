# Unifying GLSL codegen on the IR — decision document

**Date:** 2026-07-29 · **Status:** NO-GO as proposed; GO on a scoped alternative
**Subject:** deleting the 43 `glsl()` functions and feeding WebGL2 from `src/compiler/ir/glsl-backend.ts`

**Recommendation: do not switch the WebGL2 path to a new IR→GLSL pipeline. Do adopt a
~25-line fallback that makes `glsl()` optional and lowers `ir()` to GLSL inside the
existing driver.** The single most important reason: the two blockers that make the
proposed migration expensive — `coerceTypeForIR` emitting `vec4f` and `screen_uv`
resolving to `in.v_uv` — live in the IR *driver*, not in any node, and the fallback
never executes either one. I built the fallback in a scratch probe and GPU-compiled it:
**130/130 unique fragment shaders compiled on real WebGL2, byte-identical or
cosmetically-identical to production, with zero RenderPass metadata divergence.** The
proposed migration path, measured by a separate agent on the same driver, fails 45 of
191. The cheap version delivers the authoring benefit at roughly a fifth of the cost and
keeps the 43 `glsl()` functions alive as the parity oracle.

---

## 1. What the parity evidence actually proves

`verify-ir-poc.ts` reports **"85 passed, 0 failed, 0 warnings out of 85 tests"**, exit 0.
That number is not 85 parity comparisons. Measured by counting its own log lines:

| what the 85 is made of | count | compares anything? |
|---|---:|---|
| `[PASS] GLSL match` — normalized string comparison | 37 | yes |
| `[PASS] IR→GLSL lowering succeeded (loose mode)` | 24 | **no** |
| standalone inline regex assertion blocks | 24 | partially |

Loose mode is defined at `scripts/verify-ir-poc.ts:272-276` — the comment reads
`// Loose mode — IR runs successfully is already a pass`. The pass condition is that
lowering did not throw. Forcing every call site to exact mode turns 0 failures into
**10 failures** (gradient ×5, warp ×1, pixelate ×2, dither ×2).

Coverage, stated precisely:

| dimension | reality |
|---|---|
| nodes touched at all | 42 / 43 — `blur` is not even imported |
| nodes given any GLSL-vs-GLSL comparison | **32 / 43** |
| enum/bool configurations exercised | ~58 of 303 codegen-relevant |
| shared function *bodies* compared | none — `[PASS] N IRFunction(s) lowered` increments no counter (`:350`) |
| uniform sets compared | none — `glslCtx.uniforms` is created at `:133` and never read |
| full assembled shader compared | none — no IR→GLSL assembler exists |
| IR-lowered GLSL ever compiled | **never**, on any driver, anywhere in the repo |

Two fixtures emit reference GLSL containing the literal token `undefined` and pass:
dither omits the connectable `threshold` (`scripts/verify-ir-poc.ts:1592-1600`), and the
gradient `stretch` fixture omits five connectable control points (`:864-869`), yielding
`vec2 grad_C = vec2(undefined, undefined);`. Under `--verbose` the token `undefined`
appears 106 times and the suite still exits 0.

The 42-of-43 headline and the 32-of-43 reality diverge because the uncompared 11 are
exactly the hard half: `blur`, `gradient`, `noise`, `fbm`, `color_ramp`, `hsv_to_rgb`,
`pixelate`, `warp`, `dither`, `reeded_glass`, `image`. Loose mode was introduced *for*
`raw()`-heavy nodes, so the known-hazard nodes are precisely the unverified ones.

One correction to the coverage denominator that circulated during the investigation: the
figure "548 configurations" is inflated by a single node. `fragment_output`'s `quality`
(4 options) and `anchor` (9) are `updateMode: 'renderer'`
(`src/nodes/output/fragment-output.ts:92-112`) and never reach codegen, so its real space
is `alphaOp` = 7, not 252. Library-wide the codegen-relevant space is **303**, not 548,
and `fragment_output` is the only node where the two differ. Size a replacement gate off
303.

## 2. What I measured myself

I simulated the proposed change the cheap way — patch the in-memory registry so every
node's `glsl()` delegates to `lowerNodeOutputToGLSL(definition.ir(ctx))`, merging
`standardUniforms` into `ctx.uniforms` and `functions` into `ctx.functionRegistry` — then
ran the real `compileGraph` over one graph per node per capped enum combination, wired
into `fragment_output`, plus a texture-mode case per `textureInput` node. Repo untouched.

| measurement | result |
|---|---:|
| nodes patched (all have `ir()`) | 43 / 43 |
| cases | 164 (+7 texture-mode = 171) |
| byte-identical GLSL vs production | 80 |
| textually different | 84 |
| **WGSL-token leaks (`vec4f`, `in.v_uv`, `in.position`)** | **0** |
| compile-fail / throw | 0 |
| **RenderPass metadata divergences** (`isTimeLive`, `textureFilter`, pass count, `userUniforms`) | **0** |
| unique assembled fragment shaders | 130 (identical count both paths) |
| **GPU compile, production GLSL** | **130 / 130** |
| **GPU compile, `ir()`→GLSL fallback** | **130 / 130** |

Driver: ANGLE Metal Renderer, AMD Radeon Pro W5700X, via `playwright-core` + `channel:
'chrome'`, reusing the harness shape at `scripts/self-validate/index.ts:436-503`.

The 84 textual differences are the known cosmetic set and nothing else:

| divergence | example | nodes |
|---|---|---|
| float formatting | `1e-6` → `0.000001`, `0.0` → `0.000000` | gradient, random |
| unary minus (IRExpr has no unary node) | `-x` → `-1.0 * x` | gradient, random |
| scalar broadcast made explicit | `(cell + 0.5)` → `(cell + vec2(0.5, 0.5))` | pixelate, dither |
| clamp vector args | `clamp(v, 0.0, 1.0)` → `clamp(v, vec2(0.0), vec2(1.0))` | warp |
| folded constant | `1.0` → `(1.0 - 0.0)` | color_ramp |
| SRT temp naming | `srt_rad_<id>` vs `srt_<id>_rad` | every spatial node |
| extra unused uniform | `+uniform vec2 u_viewport;` | reeded_glass only |

All are legal GLSL with identical semantics, and all 130 shaders compile. `1e-6` and
`0.000001` are the same float32 bit pattern; so are `1e-4` and `0.0001`. This matters for
gate design: **a byte-equality gate would reject a correct change.** Whatever compares
the paths needs token-level normalisation, not the whitespace-collapse comparator at
`scripts/verify-ir-poc.ts:126-128` — and it must not answer brittleness by re-introducing
a loose escape hatch, which is what hid the real bugs.

Note what the zero in the metadata row does and does not cover. `reeded_glass`'s `ir()`
really does over-declare `u_viewport` unconditionally (`reeded-glass.ts:1443`) where
`glsl()` adds it per-branch (`:1033`) — that is the `+uniform vec2 u_viewport;` line
above. It does not move `isTimeLive`, because that flag keys specifically on `u_time`
(`glsl-generator.ts:715`). The general hazard is still real and still ungated: `isTimeLive`
is derived from a uniform *set*, never from shader text, and it drives `currentDprScale`
0.75 vs 1.0 (`src/webgl/renderer.ts:740-774`). A node whose `ir()` lists one extra
standard uniform emits byte-identical GLSL and silently softens the whole canvas. On the
fallback path this measured clean across 164 cases; it needs an assertion regardless.

## 3. Blockers

These produce wrong output if unaddressed. The first two apply **only to the proposed
full migration** — the fallback bypasses both, which is the core of the recommendation.

**B1 — `coerceTypeForIR` emits WGSL constructors.** `src/compiler/ir-compiler.ts:38-81`,
whose own doc comment says the choice is deliberate: `float→color` becomes
`vec4f(vec3f(v), 1.0)`. Applied at `:174` and `:220`, i.e. in the driver's input
resolution. 22–23 of 43 node types emit non-compiling GLSL on any type-coerced edge;
measured 39 of 191 GPU failures on the migration path. *Closing it (full migration):*
make coercion backend-aware and thread the target through `generateNodeIR` and
`generateNodeIRPreview`, or stop carrying coercions as pre-rendered strings and represent
them as `IRConstruct`/`IRSwizzle`. *Closing it (fallback):* nothing — the GLSL driver
already resolved inputs with `coerceType` (`glsl-generator.ts:461,:511`), so this line
never runs. Verified: 0 leaks in 164 cases.

**B2 — `screen_uv` resolves to `in.v_uv`.** `ir-compiler.ts:371` writes the WGSL-only
identifier where `glsl-generator.ts:341` writes `v_uv`. The Image node is the only
consumer (`src/nodes/input/image.ts:31`); emitted GLSL is `vec2 srt_X = in.v_uv -
u_anchor;` → `'in' : syntax error`. The repo is internally inconsistent here —
`gradient.ts:440,626` and `reeded-glass.ts:1254` use bare `v_uv` correctly and rely on
the assembler rewrite at `wgsl-assembler.ts:197-203`. Same closure story as B1.

**B3 — there is no IR→GLSL program assembler.** `glsl-backend.ts`'s highest export is
`lowerNodeOutputToGLSL` (`:186`), returning statements for one node. Nothing emits
`#version 300 es`, `precision highp float;`, `in vec2 v_uv`, `out vec4 fragColor`,
uniform or sampler declarations, or `main()`. That exists only in `assembleFragmentShader`
(`glsl-generator.ts:1011-1080`), inside the file the proposal deletes. A replacement must
also reproduce the exact string `uniform sampler2D u_<id>_image`, because
`src/webgl/preview-renderer.ts:143-150` regexes it to decide whether an image texture has
arrived; a different spelling makes the guard return false and renders thumbnails with an
unbound sampler — black, permanently, no error. *The fallback reuses the production
assembler unmodified, so B3 does not arise.*

**B4 — `compileGraphIR` cannot produce a RenderPlan.** `WGSLMultiPassOutput` is
`{ passes }` (`ir-compiler.ts:433-435`) and the function returns bare `null` on cycles, a
missing `ir()`, or any error (`:451,:474-475,:489-490`). There is no producer for
`success`, `errors` with nodeIds, `userUniforms` carrying value/nodeId/paramId,
`qualityTier`, `isTimeLiveAtOutput`, or `vertexShader`. Without them the app loses error
highlighting, the uniform fast path, quality tiers, the animation gate and the embed knob
manifest — and `src/webgpu/renderer.ts:274-280` rejects any plan unless `plan.success` is
true *and* the GLSL `passes` array is non-empty, so the WebGPU renderer's own
precondition would have nothing to satisfy it. *Fallback: not applicable — `compileGraph`
stays the plan producer.*

**B5 — `glsl-generator.ts` cannot be deleted, only its driver.** Both IR compilers import
nine value symbols plus a type from it (`ir-compiler.ts:17-22`,
`ir-subgraph-compiler.ts:17-24`): `partitionPasses`, `findTextureBoundaries`,
`resolveSourceEdge`, `groupBoundariesBySourceOutput`, `outputTypeToFragColor`,
`uniformName`, `paramGlslType`, `formatDefaultValue`, `padColorUniformValue`,
`TextureBoundaryEdge`. `RenderPass`/`RenderPlan`/`VERTEX_SHADER`/`assembleFragmentShader`
are load-bearing for both renderers, `src/renderer/types.ts` and the embed artifact codec.
Sharpest instance: `outputTypeToFragColor` emits GLSL (`fragColor = …`) and
`ir-subgraph-compiler.ts:161,:323,:386` wraps it in a **one-arg** `raw()` — so the WGSL
fragment return is produced by mechanically translating hand-written GLSL from the file
the proposal deletes.

**B6 — WebGL2 per-node previews have no IR-GLSL producer.** `subgraph-compiler.ts:138,:258`
drive `generateNodeGlsl` + `assembleFragmentShader`; `ir-subgraph-compiler.ts:166-171` is
WGSL-only, and `preview-scheduler.ts:438-448` selects by backend. Deleting `glsl()`
without porting this kills thumbnails on the fallback backend. The preview path is also
materially different code — nodes branch on `isPreview` (`gradient.ts:213,:410`) — and no
gate compares the two paths' preview output at all.

**B7 — `precision highp int;` is missing, and cannot be caught locally.** The assembler
emits only `precision highp float;` (`glsl-generator.ts:1067`). ESSL 3.00's fragment
default for `int`/`uint` is `mediump`, 16-bit minimum. `reeded_glass`'s hash needs 32-bit
unsigned wraparound and `floatBitsToUint` (`reeded-glass.ts:837-859`); `40u * 1664525u`
needs 27 bits. WGSL's `u32` is always 32-bit, so this is a WebGL2-fallback-only defect —
exactly the embed player on a visitor's older phone. ANGLE promotes mediump to 32-bit, so
this machine renders byte-identical under all three precision qualifiers and **no gate
here can ever fail on it.** Fix by construction: one line in the assembler. This is a
pre-existing bug, not a migration regression, but the migration is the moment to fix it.

**B8 — swizzle-of-binary loses its parentheses in GLSL only.** `glsl-backend.ts:88` calls
`lowerExprToGLSL(expr.expr)` with the default `parentPrec = 0`, so the precedence guard at
`:77-79` never fires: `(a + b).yx` emits as `a + b.yx`. `wgsl-backend.ts:355` parenthesises
every binary unconditionally, so WebGPU is correct and only WebGL2 is wrong — silently,
with different pixels. Measured on ANGLE with a=(0.25,0.75), b=(0.10,0.60): `a + b.yx`
renders 217,217 and `(a + b).yx` renders 255,89; both compile. No node builds this today,
because every `swizzle()` call site wraps a `variable()`. It becomes reachable the moment
anyone converts a `raw()` block to structured IR — which is the migration's own stated
direction. Width-changing swizzles fail loudly with a dimension mismatch, width-preserving
ones fail silently, so the class fails half-silently, which is worse than always failing.

### Gate blockers — the safety net is not sound

**B9 — the gate that will judge the coercion fix rejects the correct answer, and is
documented as something it is not.** `scripts/validate-wgsl-multipass.ts:41-51` lists
`/\bvec2\(/`, `/\bvec3\(/`, `/\bvec4\(/` as hard errors pushed into `result.errors` with
`process.exit(1)`. But `vec4(...)` is legal WGSL, and two-arg `raw()` arms interpolate the
coerced string verbatim while bypassing `mechanicalGlslToWgsl` entirely
(`wgsl-backend.ts:414`). `fragment_output.ts:138-141` is such a site, so it happens on
essentially every graph: fixing B1 to emit GLSL constructor names turns
`var fo_col_o: vec4f = vec4f(vec3f(v), 1.0);` into `… = vec4(vec3(v), 1.0);` — legal,
identical semantics, reported as two hard errors. The script contains **zero** references
to `requestDevice`, `createShaderModule`, `playwright` or `chromium`, yet `CLAUDE.md:32`
labels it "WGSL GPU compilation tests for all nodes/passes" and `CLAUDE.md:108` cites
"167/167 WGSL GPU compilation tests". Fix the documentation and the rule before touching
coercion, or a correct fix gets reverted by a style linter.

**B10 — `verify:pass-resolution`'s cross-backend gate degenerates to `x === x`.**
`scripts/verify-pass-resolution.ts:114-128` asserts
`plan.passes[].resolution === plan.wgsl.passes[].resolution`. Both sides already call the
same `resolvePassResolution` (`src/compiler/pass-resolution.ts:23`), so the only thing it
independently checks is that the two drivers pass identical arguments. Collapse to one
driver and it proves nothing — on the field that sets render-target size. This is the
repo's own documented failure mode, on the gate `CLAUDE.md:41` advertises as proving a
scale "reaches the RenderPlan on BOTH codegen paths".

**B11 — nothing in the automated toolchain would report the damage.** `tsconfig.json`
includes only `src`, so the 15 scripts importing `compileGraph` are never type-checked. CI
is `npm ci` + `npm run build` and nothing else (`.github/workflows/deploy.yml`). ESLint has
no type-aware parser and no import resolver. And neither `verify-ir-poc` nor
`validate-wgsl-multipass` is an npm script — I checked `package.json`; the verify family is
`pass-size`, `pass-resolution(:gpu)`, `wired-branch`, `self-validate` and the embed set.
So "drive the parity counter to zero" is something a human runs by hand once, after which
nothing re-checks it. That is the precise condition under which the entire WebGL2 fallback
shipped dead (`docs/audit/2026-07-12-post-webgpu-audit.md:275`).

**B12 — published embeds cannot be rolled back.** `src/embed/artifact.ts:66-72` keeps every
pass's `fragmentShader`, deflated into a third party's HTML; `src/embed/player.ts:102-127`
replays stored text and never recompiles. Already-published scenes are therefore safe from
this migration. But a scene published *after* a switch with subtly-wrong GLSL renders wrong
for every Safari/Firefox visitor to that site, permanently, and no URL flag reaches it —
the publisher must re-publish and hand-edit their own page. This is the one surface where
"revert the commit" is not a rollback.

## 4. Effort, and the cost of doing nothing

The 8–12 working-day estimate is for the deletion, not for the six things that must exist
first — three of which (B3, B4, B6) do not exist in any form. Calibration from this repo:
the comparable GPU gate `scripts/verify-pass-resolution-gpu.ts` is 1268 lines and
`verify-ir-poc.ts` is 2300.

| path | scope | estimate |
|---|---|---|
| **Full migration as proposed** | IR→GLSL assembler, RenderPlan producer, preview compiler port, shared-layer relocation, remove 4 `navigator.gpu` gates, fix 15 scripts, new pixel gate | **15–25 days**, and the pixel gate is the long pole |
| **Fallback (recommended)** | `glsl?:` optional + ~25-line delegation at `glsl-generator.ts:616`, same in `subgraph-compiler.ts:138,:258`, plus a third compile in `self-validate`'s `runCase()` | **2–4 days** |

Doing nothing is not free, and here the two investigation phases disagreed — see §7. The
churn is real: **67 commits** touched `src/nodes/*/*.ts` in the last 60 days, and two new
nodes shipped within 11 days of each other (`hue-shift.ts` 2026-07-19, `blur.ts`
2026-07-27). Both figures are direct git measurements I re-ran. So the dual-write tax is
being paid weekly, not accruing on static debt.

But the tax is concentrated, and the migration does not remove it where it hurts.
`reeded_glass` (255 lines of `glsl()`) and `gradient` (195) are ~450 of ~1189 duplicated
lines, with 41 nodes in a trivial tail. And `reeded_glass`'s `ir()` is 30 one-arg plus
**8 two-arg** `raw()` calls against only 5 structured-IR builder calls — its frost block
(`reeded-glass.ts:1399-1430`) is an 18-line hand-written GLSL body beside an 18-line
hand-written WGSL body. After deleting `glsl()`, an author changing the frost path still
edits two languages in one function, now with nothing to check the GLSL half against.
Seven node files have **zero** one-arg `raw()` — `image.ts` (0/8), `fragment-output.ts`
(0/3), `color-space.ts` (0/3), `hsv-to-rgb.ts` (0/2), `fbm.ts` (0/2), `hue-shift.ts` (0/1),
`noise.ts` (0/1) — so for those the migration removes a third copy, not a second.

The divergence class of bug is the stated motivation, so it is worth checking against the
actual history. The most expensive recent one, `b56c19c`, was a **one-arg** `raw()`
mechanical-translation failure: wiring Reeded Glass's Frost input made the `frost > 0.001`
branch non-uniform, WGSL forbids `textureSample` under non-uniform control flow, Tint
rejected the module, `createRenderPipeline` did not throw, the renderer reported compile
SUCCESS, and at draw time the invalid pipeline invalidated the command buffer — dropping
the entire frame including `loadOp: 'clear'`. GLSL was already the single source of truth
for that block. Deleting `glsl()` would not have prevented it, and the fix that landed was
to **hand-write a WGSL arm** — adding a language copy, not removing one. Same shape at
`src/nodes/distort/warp.ts:161`, a one-arg `raw()` carrying GLSL's y-flip that the audit
records as a vertically mirrored distortion field on WebGPU only. The migration leaves all
91 `raw()` GLSL strings as sole source and the mechanical-translation hazard exactly where
it is, while deleting the only cross-check on the 34 two-arg sites.

The genuinely large duplication is elsewhere and needs no deletion: **four** near-identical
drivers, not two. `generateNodeGlsl` (`glsl-generator.ts:398-630`) vs `generateNodeIR`
(`ir-compiler.ts:109-333`) are ~133 of 209 non-blank lines identical; `compileMultiPass`
(`:742-957`) vs `compileMultiPassIR` (`:547-735`) ~110 of 191; plus the two preview mirrors
(`subgraph-compiler.ts:171-349`, `ir-subgraph-compiler.ts:190-421`). Collapsing those into
one pass-walker parameterised by node-emitter is verifiable by the strongest possible test —
both existing paths must emit byte-identical output before and after — and is revertible in
one commit.

## 5. Sequencing

Truth-in-documentation and gate repair come first, because every later step is judged by
these gates and two of them currently cannot fail.

**Step 0 — fix the gates and the docs (0.5–1 day, no production change).** Correct
`CLAUDE.md:32` and `:108` to stop calling `validate-wgsl-multipass` a GPU compile. Teach it
that `vec4(` is legal WGSL, or replace its regex rules with the real `createShaderModule`
path `self-validate` already has (B9). Rewrite `verify-pass-resolution.ts:114-128` so it can
fail with one producer (B10). Wire `verify-ir-poc` and `validate-wgsl-multipass` into
`package.json` and into CI (B11). *Verifiable:* each gate must be shown to fail on a
deliberately broken input before it is trusted — the repo's own lesson from
`228334f`/`4a75f15`.

**Step 1 — parity counter inside `self-validate` (1 day, no production change).** Add a
third compile beside the two at `scripts/self-validate/index.ts:181-206`: lower each node's
`ir()` to GLSL and compare against `generateNodeGlsl`, then feed it to the existing WebGL2
compile at `:481-503`. ~40 LOC, per-node attribution for free, and the corpus (280 cases,
enum-variant product with a `showWhen`-aware fallback at `:112-141`) already exists. Assert
uniform sets and `textureFilter` here too, since those are pixel channels text parity cannot
see. Use token-level normalisation for the seven cosmetic causes, not byte equality. Golden
files would be strictly worse: the corpus is generated deterministically from the registry,
so any legitimate codegen change forces mass regeneration, at which point the fixtures prove
nothing.

**Step 2 — fix B7 and B8 (0.5 day).** `precision highp int;` in the assembler; parenthesise
swizzled binaries at `glsl-backend.ts:88`. Both are pre-existing, both are cheap, and B8
must land before anyone converts a `raw()` block to structured IR. *Verifiable:* B8 by a
unit lowering of `swizzle(binary(...))`; B7 only by construction, since this hardware cannot
fail on it.

**Step 3 — make `glsl` optional and delegate to `ir()` (1 day).** `src/nodes/types.ts:269`
becomes `glsl?:`; at `glsl-generator.ts:616` fall back to
`lowerNodeOutputToGLSL(definition.ir(context))`, merging `standardUniforms` into `uniforms`
and `functions` into `functionRegistry`. `GLSLContext` is structurally assignable to
`IRContext` — `IRContext`'s fields (`ir/types.ts:205-234`) are a strict subset of
`GLSLContext`'s (`nodes/types.ts:75-89`) — so the call type-checks as written. Same fallback
at `subgraph-compiler.ts:138,:258` for thumbnails. **Do not delete any `glsl()` yet.**
*Verifiable:* Step 1's counter must stay at zero for all 43 nodes with `glsl()` still
present, since every node then has both a reference and a fallback.

**Step 4 — migrate nodes individually, riskiest last (ongoing, not a project).** Delete
`glsl()` only where its `ir()` is structured or shares a lang-parameterised emitter. Safest
first: the ~20 nodes with no recompile-enum dimensions that already emit byte-identical GLSL.
Riskiest last: `reeded_glass`, `gradient`, `image`, then `warp`/`pixelate`/`dither`/
`polar_coords`/`tile`. Riskiest-last is right here because each deletion is independent — the
tail can simply never happen, and for `reeded_glass` and `image` (0 one-arg `raw()`) it
probably should not, since the migration buys them nothing. Prefer instead the pattern
`blur.ts:245-267` already uses: a 14-line `glsl()` that calls the same
`emit({…, wgsl: false})` emitter its `ir()` calls, so the GLSL arm is production-tested
rather than hand-maintained. `9ea1fea` did this for reeded-glass — "one implementation of the
optics, two output spaces".

**Rollback.** Steps 0–2 are independently revertible. Step 3 is additive: reverting restores
the required `glsl` field and nothing else changes, because production output is
byte-identical or cosmetically identical (measured). Step 4 is per-node — restore one
function. Nothing here needs a `?codegen=legacy` switch, because there is never a second
driver to switch between; that is the main structural advantage over the proposed migration,
which needs a flag *and* still cannot reach B12's published artifacts.

**If the full migration is revived later,** Steps 0–2 are prerequisites for it too, and the
verdict gate must be a **WebGL2-before vs WebGL2-after** pixel diff, never WebGL2 vs WebGPU.
Cross-backend equality is already known false and documented: the warp texture-mode y-flip
(`warp.ts:161`, audit §P1) and up to 51 code units on frost through hardware bilinear
(`docs/research/2026-07-29-frost-backend-divergence.md`). `Rig.captureRawGlsl`
(`scripts/blur-bakeoff/lib/gpu-rig.ts:75-96`) is the right harness shape.

## 6. What remains unverified

- **Pixels.** I compiled and linked 130/130; I did not render and diff. The seven cosmetic
  causes are spec-identical and `1e-6`/`0.000001` are the same float32, but FMA contraction
  on `-1.0 * x` vs `-x` and constant-folding order could still move a byte. This is the
  largest remaining gap and Step 1 plus a `captureRawGlsl` diff would close it.
- **The preview path, entirely.** Every probe in this investigation drove `compileGraph` /
  `compileGraphIR` with `isPreview = false`. Nodes branch on `isPreview`
  (`gradient.ts:213,:410`) and one sweep found 24 divergent signatures at `isPreview=true`
  vs 15 at false. Preview codegen can diverge where main codegen agrees, and nothing
  compares it.
- **Deep pass chains.** My corpus tops out at 2 passes (one texture-wired source); a relay
  probe reached 3. Ping-pong aliasing, `expand-passes.ts` blur expansion into virtual nodes,
  and 4+ pass chains were not compared. Any deep-chain fixture needs a mechanism-engaged
  assertion — assert the compiled pass count exceeds the partition depth *before* comparing,
  or it silently compiles as two passes and proves nothing.
- **`blur` specifically.** The only `multiPass` node (`blur.ts:205`), absent from
  `verify-ir-poc` entirely. It is in my sweep and compiled, but it has never had a
  `glsl()`/`ir()` comparison of any kind.
- **Non-ANGLE drivers.** One driver tested. B7's `mediump int` exposure is invisible here by
  construction; Mali, Adreno and older Intel WebGL2 stacks are untested, and the embed player
  runs on arbitrary visitors' browsers.
- **Semantic equivalence of the 34 two-arg `raw()` arms.** Compilation is not equivalence,
  and these are exactly where mechanical translation is skipped. Needs a per-node
  WebGL2-vs-WebGPU pixel comparison, which cross-backend divergence makes awkward to score.
- **Numeric params and `dynamicInputs`.** I enumerated enum/bool combinations only. A
  divergence gated on a numeric threshold or a dynamic port count would hide.
- **A `self-validate` reporting anomaly** flagged during the investigation and not
  reproduced: a `--no-gpu` run reportedly wrote `gpu.json` with 866 passes without printing
  the gpu stage, where `enabled('gpu') && !noGpu` (`index.ts:528`) should skip it. Worth a
  look by whoever owns that script, given this repo's history of green-but-vacuous gates.

## 7. Where the two investigation phases contradict each other

**On whether B1/B2 are intrinsic.** Four mapping agents independently called
`coerceTypeForIR` "the single largest blocker" requiring a rewrite. The adversarial phase
said the blockers never execute on a fallback architecture. **The adversarial phase is
right, and I verified it directly:** coercion is applied at `ir-compiler.ts:174,:220`, in
the driver's input resolution, not inside any node's `ir()`. Both statements are true of
different architectures — the blockers are intrinsic to *replacing the driver*, not to
*making `ir()` the single source for node bodies*. The mapping phase never tested the
fallback, so it had no way to see this. My 164-case sweep found 0 leaks and my GPU run
130/130.

**On whether the node library is static.** The sequencing agent argued the duplication is
"mostly static debt rather than an accruing tax — the node library has been stable at 43
since Phase 4 and no new built-in nodes are scheduled." The adversarial phase measured 67
node commits in 60 days and two new nodes in 11. **The adversarial phase is right** — I
re-ran both: 67 commits, `blur.ts` created 2026-07-27, `hue-shift.ts` 2026-07-19. The
sequencing agent read ROADMAP's *plans*; the git log records *behaviour*. This contradiction
cuts toward doing something rather than nothing, which is why the recommendation is
go-on-the-alternative rather than no-go outright.

**On the verdict.** The sequencing agent concluded "do it, but not for the stated reason,"
8–12 days. The adversarial plan critique concluded no, and would not ship a revised version
either. **I side with the adversarial phase on justification and with neither on remedy.**
The decisive evidence is the `raw()` census — `reeded_glass` at 30 one-arg + 8 two-arg
against 5 structured calls, seven files at zero one-arg — which makes "one generator per
node" false exactly where duplication costs most, plus `b56c19c` being a bug the migration
would not have prevented and whose accepted fix moved the opposite way. But the adversarial
phase's own proposed alternative is stronger than its "no": it is ~25 lines, I measured it
byte-identical and GPU-clean, and it captures the authoring benefit while keeping 43
independent GLSL references alive as the parity oracle. That is why this document says
go-with-conditions on the alternative rather than no-go on everything.

**One more inversion worth recording.** `?backend=webgl2` — the documented and only way to
exercise the fallback in a WebGPU browser — works by *disabling* the IR path
(`BROWSER-AUTOMATION.md:190`, `src/App.tsx:505`). Under the proposed migration WebGL2 would
*require* the IR path, so the flag's semantics invert and the documentation becomes actively
wrong. Under the recommended fallback the flag keeps working unchanged, because there is
still exactly one GLSL driver.

## Repro

The probes behind §2 were scratch-only; the repo was not modified. To reproduce, patch the
registry in memory rather than editing nodes:

```ts
// for each def in ALL_NODES with an ir():
live.glsl = (ctx) => {
  const o = live.ir(ctx)                                  // GLSLContext ⊇ IRContext
  for (const u of o.standardUniforms) ctx.uniforms.add(u)
  for (const fn of o.functions ?? [])
    if (!ctx.functionRegistry.has(fn.key))
      ctx.functionRegistry.set(fn.key, lowerFunctionsToGLSL([fn]).join('\n'))
  return lowerNodeOutputToGLSL(o).join('\n  ')
}
```

Then run `compileGraph` over one graph per node per enum combination and diff
`plan.passes[].fragmentShader` against an unpatched baseline. For the GPU stage, reuse the
launch + `gl.compileShader` block at `scripts/self-validate/index.ts:436-503`; note
`playwright-core` must be imported by absolute path from outside the repo, and its CJS
default needs `pw.chromium ?? pw.default?.chromium`.

```bash
npx tsx scripts/verify-ir-poc.ts            # 85/85 green; 37 real comparisons
npx tsx scripts/verify-ir-poc.ts --verbose  # grep -c undefined → 106
npm run self-validate                       # the corpus + the real GPU compile to extend
```
