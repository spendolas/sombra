# Shader Embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Sombra user publish a finished shader and embed it on any third-party website via a copy-paste snippet and a JS toolkit that exposes every knob to the host page.

**Architecture:** At publish time the editor compiles the graph and serializes the *compiled output* (a `SceneArtifact`: the `RenderPlan` minus vertex shaders + a knob manifest + baked images) to base64url, inline in the snippet. A standalone player bundle (renderer + decoder + perf harness, **no React/xyflow/compiler/nodes**) decodes it, reuses `createShaderRenderer`, and drives the loop. Two front doors over one player: `<div data-sombra-scene>` auto-mount and `Sombra.mount(el, opts)` returning a `SceneHandle`.

**Tech Stack:** TypeScript (strict), Vite 6 (library build for the player), `pako` (deflate), the existing `src/renderer` + `src/compiler` modules, `tsx` verification scripts, `playwright-core` for browser smoke.

## Global Constraints

- TypeScript strict mode everywhere. No `any` without cause.
- **The player bundle (`src/embed/index.ts` and its imports) must NOT import** React, `@xyflow/react`, `src/compiler/*`, `src/nodes/*`, or `src/utils/sombra-file.ts`. It may import only `src/renderer/*`, `src/embed/*`, and `pako`. This is enforced by a build-time grep gate (Task 7).
- Editor-side embed code (`src/embed/manifest.ts`, `src/embed/publish.ts`, `src/components/EmbedModal.tsx`) MAY import compiler/nodes/xyflow — it runs in the editor, not the player.
- UI components use Tailwind utility classes + `ds.*` from `@/generated/ds`. No per-component CSS, no raw hex outside `port-colors.ts`. If an inline visual class is unavoidable, append a task to `.claude/ds-queue.md`.
- No unit-test framework exists. Verification = standalone `tsx` scripts (pure logic) + browser smoke via `playwright-core` and the dev server (DOM/GPU). Mirror `scripts/verify-gizmo-coords.ts`: relative imports from `../src/...`, `passed`/`failed` counters, `process.exit(1)` on failure.
- WebGPU-first, WebGL2 fallback — both backends must keep working; the artifact carries both.
- CDN base path is `/sombra/` (`vite.config.ts base`). The player ships to `dist/embed/`, served at `https://spendolas.github.io/sombra/embed/`.
- `EMBED_VERSION = '0.1.0'` — the single source of truth for the CDN filename and snippet URLs (`src/embed/version.ts`).

---

## File structure

**Shared / player (pure, no DOM except player.ts; no compiler/nodes):**
- `src/embed/version.ts` — `EMBED_VERSION` constant + `CDN_BASE`.
- `src/embed/vertex.ts` — the GLSL vertex constant the player owns (copy of the compiler's `VERTEX_SHADER`).
- `src/embed/artifact.ts` — `SceneArtifact`, `KnobDescriptor`, `SerializedPlan`, `ImageAsset` types + `encodeArtifact`, `decodeArtifact`, `stripPlan`, `reconstructPlan`, `collectPlanUniforms`.
- `src/embed/player.ts` — `mount(el, opts): SceneHandle`; wraps `createShaderRenderer`.
- `src/embed/perf-harness.ts` — `PerfHarness` class (IntersectionObserver, visibilitychange, reduced-motion, resize, context-loss).
- `src/embed/auto-init.ts` — `initAll()` scans `[data-sombra-scene]`.
- `src/embed/index.ts` — public entry: `{ mount, init, version }`; UMD global `Sombra`; auto-inits on load.

**Editor-side (publish):**
- `src/embed/manifest.ts` — `buildManifest(uniforms, nodes): KnobDescriptor[]`.
- `src/embed/publish.ts` — `publishScene(nodes, edges): PublishResult`; `buildSnippets(...)`.
- `src/components/EmbedModal.tsx` — three-tab publish UI.
- `src/components/GraphToolbar.tsx` — add the Embed button (modify).

**Build / harness:**
- `vite.embed.config.ts` — player library build.
- `embed-dev.html` + `src/embed-dev.ts` — dev-only harness page for manual + playwright smoke.
- `package.json` — add `build:embed`, `verify:embed*` scripts (modify).

**Verification scripts:**
- `scripts/verify-artifact-roundtrip.ts`
- `scripts/verify-manifest.ts`
- `scripts/verify-embed-snippets.ts`
- `scripts/verify-embed-bundle.ts`
- `scripts/verify-embed-smoke.ts`

**Docs:** `EMBED.md` (new), `BROWSER-AUTOMATION.md`, `CLAUDE.md`, `AGENTS.md`, `ROADMAP.md` (modify).

---

## Task 1: Version + vertex constant

**Files:**
- Create: `src/embed/version.ts`
- Create: `src/embed/vertex.ts`
- Modify: `src/compiler/glsl-generator.ts:102` (export the existing `VERTEX_SHADER`)

**Interfaces:**
- Produces: `EMBED_VERSION: string`, `CDN_BASE: string` (version.ts); `GLSL_VERTEX_SHADER: string` (vertex.ts). `VERTEX_SHADER` becomes an exported const in glsl-generator.ts (for the round-trip invariant test only — not imported by the player).

- [ ] **Step 1: Create `src/embed/version.ts`**

```ts
// Single source of truth for the player's CDN filename + snippet URLs.
export const EMBED_VERSION = '0.1.0'
export const CDN_BASE = 'https://spendolas.github.io/sombra/embed'
export const PLAYER_UMD_URL = `${CDN_BASE}/sombra-player.${EMBED_VERSION}.umd.js`
```

- [ ] **Step 2: Create `src/embed/vertex.ts`**

Copy the compiler's fullscreen-quad vertex shader verbatim. The player owns this copy so it never imports the compiler.

```ts
/**
 * The fullscreen-quad vertex stage, owned by the player so the embed bundle
 * never pulls in the compiler. MUST stay byte-identical to VERTEX_SHADER in
 * src/compiler/glsl-generator.ts — asserted by scripts/verify-artifact-roundtrip.ts.
 */
export const GLSL_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`
```

- [ ] **Step 3: Export `VERTEX_SHADER` from the compiler**

In `src/compiler/glsl-generator.ts:102`, change `const VERTEX_SHADER = ...` to `export const VERTEX_SHADER = ...`. (Leave the string contents untouched.)

- [ ] **Step 4: Verify it still builds**

Run: `npx tsc -b --noEmit`
Expected: no new errors (the export is additive).

- [ ] **Step 5: Commit**

```bash
git add src/embed/version.ts src/embed/vertex.ts src/compiler/glsl-generator.ts
git commit -m "feat(embed): version + player-owned vertex constant"
```

---

## Task 2: Scene Artifact types + codec

**Files:**
- Create: `src/embed/artifact.ts`
- Create: `scripts/verify-artifact-roundtrip.ts`
- Modify: `package.json` (add `verify:embed:artifact` script)

**Interfaces:**
- Consumes: `GLSL_VERTEX_SHADER` (Task 1); `RenderPlan`, `RenderPass` from `../compiler/glsl-generator` (type-only); `UniformSpec` from `../nodes/types` (type-only). Type-only imports are erased at build, so the player stays compiler-free.
- Produces:
  - `SceneArtifact`, `SerializedPlan`, `KnobDescriptor`, `ImageAsset` (types)
  - `stripPlan(plan: RenderPlan): SerializedPlan`
  - `reconstructPlan(sp: SerializedPlan): RenderPlan`
  - `encodeArtifact(a: SceneArtifact): string`
  - `decodeArtifact(s: string): SceneArtifact`
  - `collectPlanUniforms(plan: RenderPlan): Array<{ name: string; value: number | number[] }>`

- [ ] **Step 1: Write the artifact module**

Create `src/embed/artifact.ts`:

```ts
import pako from 'pako'
import type { RenderPlan, RenderPass } from '../compiler/glsl-generator'
import type { UniformSpec } from '../nodes/types'
import { GLSL_VERTEX_SHADER } from './vertex'

/** A knob exposed to the host page. One per unwired updateMode:'uniform' param. */
export interface KnobDescriptor {
  key: string                              // friendly, deduped (e.g. "scale", "scale-2")
  uniform: string                          // wire name, e.g. "u_abc123_scale"
  label: string
  type: 'float' | 'vec2' | 'vec3' | 'color'
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  min?: number
  max?: number
  step?: number
  default: number | number[]
}

/** A baked image texture. */
export interface ImageAsset {
  sampler: string                          // "u_<sanitizedNodeId>_image"
  dataUrl: string                          // base64 data URL
}

/** RenderPlan with the constant vertex shaders removed (player re-adds them). */
export type SerializedPlan =
  Omit<RenderPlan, 'vertexShader' | 'passes'> & {
    passes: Array<Omit<RenderPass, 'vertexShader'>>
  }

/** The complete frozen scene payload. */
export interface SceneArtifact {
  v: 1
  kind: 'frozen'                           // reserved: future 'live'
  plan: SerializedPlan
  manifest: KnobDescriptor[]
  images: ImageAsset[]
  meta: {
    anchor: [number, number]
    timeSpeed: number
  }
}

/** Remove the constant vertex shader from every pass + the top-level field. */
export function stripPlan(plan: RenderPlan): SerializedPlan {
  const { vertexShader: _v, passes, ...rest } = plan
  return {
    ...rest,
    passes: passes.map(({ vertexShader: _pv, ...p }) => p),
  }
}

/** Re-attach the player-owned vertex constant so the renderer accepts the plan. */
export function reconstructPlan(sp: SerializedPlan): RenderPlan {
  return {
    ...sp,
    vertexShader: GLSL_VERTEX_SHADER,
    passes: sp.passes.map((p) => ({ ...p, vertexShader: GLSL_VERTEX_SHADER })),
  }
}

/** All runtime uniforms across every pass, deduped by name (for baking). */
export function collectPlanUniforms(
  plan: RenderPlan,
): Array<{ name: string; value: number | number[] }> {
  const seen = new Map<string, number | number[]>()
  for (const pass of plan.passes) {
    for (const u of pass.userUniforms as UniformSpec[]) {
      if (!seen.has(u.name)) seen.set(u.name, u.value)
    }
  }
  return [...seen].map(([name, value]) => ({ name, value }))
}

// --- base64url (chunked to avoid String.fromCharCode RangeError on large buffers) ---

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function encodeArtifact(a: SceneArtifact): string {
  const json = JSON.stringify(a)
  const deflated = pako.deflate(json)
  return bytesToBase64Url(deflated)
}

export function decodeArtifact(s: string): SceneArtifact {
  const bytes = base64UrlToBytes(s)
  const json = pako.inflate(bytes, { to: 'string' })
  return JSON.parse(json) as SceneArtifact
}
```

- [ ] **Step 2: Write the failing round-trip verification script**

Create `scripts/verify-artifact-roundtrip.ts`:

```ts
/**
 * verify-artifact-roundtrip — the SceneArtifact codec must be lossless, and the
 * player's vertex constant must match the compiler's. Part of the script-based
 * test suite: run with `npx tsx scripts/verify-artifact-roundtrip.ts`.
 */
import { encodeArtifact, decodeArtifact, type SceneArtifact } from '../src/embed/artifact'
import { GLSL_VERTEX_SHADER } from '../src/embed/vertex'
import { VERTEX_SHADER } from '../src/compiler/glsl-generator'

let passed = 0
let failed = 0
function check(name: string, cond: boolean) {
  if (cond) { passed++ } else { failed++; console.error(`  [FAIL] ${name}`) }
}

// 1. Vertex-constant invariant.
check('player vertex constant equals compiler VERTEX_SHADER', GLSL_VERTEX_SHADER === VERTEX_SHADER)

// 2. Codec round-trip on a representative synthetic artifact.
const artifact: SceneArtifact = {
  v: 1,
  kind: 'frozen',
  plan: {
    success: true,
    passes: [{
      index: 0,
      fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 o;\nuniform float u_a_scale;\nvoid main(){o=vec4(u_a_scale);}',
      userUniforms: [{ name: 'u_a_scale', glslType: 'float', value: 0.5, nodeId: 'a', paramId: 'scale' }],
      inputTextures: {},
      isTimeLive: false,
    }],
    errors: [],
    isTimeLiveAtOutput: false,
    qualityTier: 'adaptive',
    fragmentShader: 'unused-top-level',
    userUniforms: [{ name: 'u_a_scale', glslType: 'float', value: 0.5, nodeId: 'a', paramId: 'scale' }],
  } as SceneArtifact['plan'],
  manifest: [{
    key: 'scale', uniform: 'u_a_scale', label: 'Scale',
    type: 'float', glslType: 'float', min: 0, max: 1, step: 0.01, default: 0.5,
  }],
  images: [{ sampler: 'u_b_image', dataUrl: 'data:image/png;base64,AAAA' }],
  meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
}

const decoded = decodeArtifact(encodeArtifact(artifact))
check('round-trips deep-equal', JSON.stringify(decoded) === JSON.stringify(artifact))
check('decoded artifact has no vertexShader in passes', !('vertexShader' in decoded.plan.passes[0]))

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
```

- [ ] **Step 3: Run it — expect PASS**

Run: `npx tsx scripts/verify-artifact-roundtrip.ts`
Expected: `SUMMARY: 3 passed, 0 failed`. (If the vertex-constant check fails, the copy in `src/embed/vertex.ts` drifted from the compiler — fix the copy.)

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, add:
```json
    "verify:embed:artifact": "tsx scripts/verify-artifact-roundtrip.ts",
```

- [ ] **Step 5: Commit**

```bash
git add src/embed/artifact.ts scripts/verify-artifact-roundtrip.ts package.json
git commit -m "feat(embed): scene artifact types + lossless codec"
```

---

## Task 3: Knob manifest builder

**Files:**
- Create: `src/embed/manifest.ts`
- Create: `scripts/verify-manifest.ts`
- Modify: `package.json` (add `verify:embed:manifest`)

**Interfaces:**
- Consumes: `KnobDescriptor` (Task 2); `UniformSpec`, `NodeData`, `NodeDefinition` from `../nodes/types`; `nodeRegistry` from `../nodes/registry`; `Node` from `@xyflow/react`. (Editor-side module — compiler/nodes imports are allowed here.)
- Produces: `buildManifest(uniforms: UniformSpec[], nodes: Node<NodeData>[]): KnobDescriptor[]`

- [ ] **Step 1: Write the manifest module**

Create `src/embed/manifest.ts`:

```ts
import type { Node } from '@xyflow/react'
import type { NodeData, NodeParameter, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import type { KnobDescriptor } from './artifact'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Map a NodeParameter.type to the knob's public type. Only uniform-mode
 * params reach here, so type is always one of these four. */
function knobType(paramType: NodeParameter['type']): KnobDescriptor['type'] {
  return paramType === 'color' ? 'color'
    : paramType === 'vec2' ? 'vec2'
    : paramType === 'vec3' ? 'vec3'
    : 'float'
}

/**
 * Build the public knob list from the compiler's uniform specs joined with each
 * param's static NodeDefinition metadata. Keys are slugified labels, deduped
 * with -2/-3 suffixes. Call after initializeNodeLibrary().
 */
export function buildManifest(
  uniforms: UniformSpec[],
  nodes: Node<NodeData>[],
): KnobDescriptor[] {
  const nodeType = new Map(nodes.map((n) => [n.id, n.data.type]))
  const usedKeys = new Map<string, number>()
  const out: KnobDescriptor[] = []

  for (const u of uniforms) {
    const type = nodeType.get(u.nodeId)
    const def = type ? nodeRegistry.get(type) : undefined
    const param = def?.params?.find((p) => p.id === u.paramId)
    if (!param) continue // no metadata → skip (defensive)

    let key = slugify(param.label) || u.paramId
    const n = usedKeys.get(key) ?? 0
    usedKeys.set(key, n + 1)
    if (n > 0) key = `${key}-${n + 1}`

    out.push({
      key,
      uniform: u.name,
      label: param.label,
      type: knobType(param.type),
      glslType: u.glslType,
      min: param.min,
      max: param.max,
      step: param.step,
      default: u.value,
    })
  }
  return out
}
```

- [ ] **Step 2: Write the verification script**

Create `scripts/verify-manifest.ts`. It initializes the real registry, picks a node type that has uniform-mode params, and asserts descriptors + dedup:

```ts
/**
 * verify-manifest — buildManifest joins compiler uniforms with NodeDefinition
 * metadata, one knob per uniform, deduped keys. Run: npx tsx scripts/verify-manifest.ts
 */
import type { Node } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import type { NodeData, UniformSpec } from '../src/nodes/types'
import { buildManifest } from '../src/embed/manifest'

initializeNodeLibrary()

let passed = 0, failed = 0
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) }
}

// Find any registered node with a uniform-mode, non-hidden param to test against.
let testType = '', testParamId = '', testLabel = ''
for (const [type, def] of nodeRegistry) {
  const p = def.params?.find((p) => p.updateMode === 'uniform' && !p.hidden)
  if (p) { testType = type; testParamId = p.id; testLabel = p.label; break }
}
check('found a uniform-mode param to test', testType !== '')

const nodes = [
  { id: 'n1', data: { type: testType, params: {} } },
  { id: 'n2', data: { type: testType, params: {} } },
] as Node<NodeData>[]

const uniforms: UniformSpec[] = [
  { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
  { name: `u_n2_${testParamId}`, glslType: 'float', value: 2, nodeId: 'n2', paramId: testParamId },
]

const manifest = buildManifest(uniforms, nodes)
check('one descriptor per uniform', manifest.length === 2)
check('first key is slugified label', manifest[0].key.length > 0 && manifest[0].key === manifest[0].key.toLowerCase())
check('duplicate label is deduped', manifest[0].key !== manifest[1].key)
check('descriptor carries label + uniform wire name', manifest[0].label === testLabel && manifest[0].uniform === `u_n1_${testParamId}`)
check('unknown node is skipped', buildManifest(
  [{ name: 'u_x_y', glslType: 'float', value: 0, nodeId: 'ghost', paramId: 'y' }],
  nodes,
).length === 0)

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
```

- [ ] **Step 3: Run it — expect PASS**

Run: `npx tsx scripts/verify-manifest.ts`
Expected: `SUMMARY: 6 passed, 0 failed`.

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, add:
```json
    "verify:embed:manifest": "tsx scripts/verify-manifest.ts",
```

- [ ] **Step 5: Commit**

```bash
git add src/embed/manifest.ts scripts/verify-manifest.ts package.json
git commit -m "feat(embed): knob manifest builder"
```

---

## Task 4: Player core + dev harness

**Files:**
- Create: `src/embed/player.ts`
- Create: `src/embed/index.ts`
- Create: `embed-dev.html`
- Create: `src/embed-dev.ts`

**Interfaces:**
- Consumes: `decodeArtifact`, `reconstructPlan`, `collectPlanUniforms`, `KnobDescriptor`, `SceneArtifact` (Task 2); `createShaderRenderer` from `../renderer/create-renderer`; `ShaderRenderer` from `../renderer/types`.
- Produces:
  - `MountOptions`, `SceneHandle` (types)
  - `mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle>`
  - `src/embed/index.ts` exporting `{ mount, init, version }` and assigning `window.Sombra`.

- [ ] **Step 1: Write the player module**

Create `src/embed/player.ts`. (Perf harness is added in Task 5; this task wires the render path and the handle.)

```ts
import { createShaderRenderer } from '../renderer/create-renderer'
import type { ShaderRenderer, QualityTier } from '../renderer/types'
import {
  decodeArtifact, reconstructPlan, collectPlanUniforms,
  type SceneArtifact, type KnobDescriptor,
} from './artifact'

export interface MountOptions {
  scene: string                                   // base64url artifact
  variables?: Record<string, number | number[]>   // initial knob overrides (by key)
  autoplay?: boolean                               // default true
  debug?: boolean
  onLoad?: (h: SceneHandle) => void
  onError?: (e: Error) => void
}

export interface SceneHandle {
  set(key: string, value: number | number[]): void
  get(key: string): number | number[] | undefined
  variables(): KnobDescriptor[]
  play(): void
  pause(): void
  resize(): void
  destroy(): void
  on(event: 'load' | 'error' | 'contextlost', cb: (...a: unknown[]) => void): void
}

const NOOP_HANDLE: SceneHandle = {
  set() {}, get() { return undefined }, variables() { return [] },
  play() {}, pause() {}, resize() {}, destroy() {}, on() {},
}

export async function mount(el: HTMLElement, opts: MountOptions): Promise<SceneHandle> {
  if (typeof window === 'undefined' || !el) return NOOP_HANDLE

  let artifact: SceneArtifact
  try {
    artifact = decodeArtifact(opts.scene)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('[Sombra] Failed to decode scene:', e.message)
    opts.onError?.(e)
    return NOOP_HANDLE
  }

  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'
  el.appendChild(canvas)

  const plan = reconstructPlan(artifact.plan)
  const manifest = artifact.manifest
  const byKey = new Map(manifest.map((k) => [k.key, k]))
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const emit = (ev: string, ...a: unknown[]) => (listeners[ev] ?? []).forEach((f) => f(...a))

  let renderer: ShaderRenderer
  try {
    renderer = await createShaderRenderer(canvas)
    const res = renderer.updateRenderPlan(plan)
    if (!res.success) throw new Error(res.error ?? 'updateRenderPlan failed')
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    console.error('[Sombra] Renderer init failed:', e.message)
    if (opts.debug) el.textContent = `[Sombra] ${e.message}`
    opts.onError?.(e)
    return NOOP_HANDLE
  }

  // Bake compile-time uniform values, then apply host overrides.
  renderer.updateUniforms(collectPlanUniforms(plan))
  renderer.setAnchor(artifact.meta.anchor)

  const applyOverride = (key: string, value: number | number[]) => {
    const knob = byKey.get(key)
    if (!knob) { console.warn(`[Sombra] unknown knob "${key}". Known: ${[...byKey.keys()].join(', ')}`); return }
    let v = value
    if (knob.glslType === 'vec4' && Array.isArray(v) && v.length === 3) v = [...v, 1] // pad color alpha
    renderer.updateUniforms([{ name: knob.uniform, value: v }])
  }
  if (opts.variables) for (const [k, v] of Object.entries(opts.variables)) applyOverride(k, v)

  // Re-apply GPU state after device/context loss (all GPU state is gone).
  renderer.onDeviceLost(() => {
    renderer.updateRenderPlan(plan)
    renderer.updateUniforms(collectPlanUniforms(plan))
    for (const [s, img] of images) renderer.uploadImageTexture(s, img)
    emit('contextlost')
  })

  // Baked image textures decode async — re-render as each lands.
  const images = new Map<string, HTMLImageElement>()
  const isAnimated = plan.isTimeLiveAtOutput
  for (const asset of artifact.images) {
    const img = new Image()
    img.onload = () => {
      images.set(asset.sampler, img)
      renderer.uploadImageTexture(asset.sampler, img)
      renderer.notifyChange()
      if (!isAnimated) renderer.requestRender()
    }
    img.src = asset.dataUrl
  }

  renderer.render()
  renderer.setAnimated(isAnimated)
  renderer.setQualityTier((plan.qualityTier ?? 'adaptive') as QualityTier)

  const play = () => { if (isAnimated) { renderer.setAnimationSpeed(artifact.meta.timeSpeed); renderer.startAnimation() } }
  const pause = () => renderer.stopAnimation()
  if (opts.autoplay !== false) play()
  else renderer.notifyChange()

  const handle: SceneHandle = {
    set: applyOverride,
    get: (key) => byKey.get(key)?.default,
    variables: () => manifest.slice(),
    play, pause,
    resize: () => renderer.requestRender(),
    destroy: () => { renderer.stopAnimation(); renderer.dispose(); canvas.remove() },
    on: (ev, cb) => { (listeners[ev] ??= []).push(cb) },
  }
  opts.onLoad?.(handle)
  emit('load', handle)
  return handle
}
```

- [ ] **Step 2: Write the public entry**

Create `src/embed/index.ts`:

```ts
import { EMBED_VERSION } from './version'
import { mount } from './player'
import { initAll } from './auto-init'   // added in Task 6; import is safe once that file exists

export { mount } from './player'
export type { MountOptions, SceneHandle } from './player'
export type { KnobDescriptor } from './artifact'
export const version = EMBED_VERSION
export function init(): void { initAll(mount) }

// UMD global + auto-init on load.
if (typeof window !== 'undefined') {
  ;(window as unknown as { Sombra?: unknown }).Sombra = { mount, init, version }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init())
  } else {
    init()
  }
}
```

> Note: `./auto-init` is created in Task 6. To keep Task 4 self-contained and compiling, temporarily stub `src/embed/auto-init.ts` now with `export function initAll(_mount: unknown) {}` and flesh it out in Task 6.

- [ ] **Step 3: Create the auto-init stub**

Create `src/embed/auto-init.ts`:
```ts
// Stub — real implementation lands in Task 6.
export function initAll(_mount: unknown): void {}
```

- [ ] **Step 4: Create the dev harness page**

Create `embed-dev.html` at repo root:
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Sombra Embed Dev</title>
    <style>body{margin:0;background:#0f0f1a}#box{width:640px;height:360px;margin:40px auto}</style>
  </head>
  <body>
    <div id="box"></div>
    <script type="module" src="/src/embed-dev.ts"></script>
  </body>
</html>
```

Create `src/embed-dev.ts` — compiles a sample graph in-page (dev only; uses the compiler, which is fine here since this page is not the shipped bundle):
```ts
import { initializeNodeLibrary } from './nodes'
import { compileGraph } from './compiler/glsl-generator'
import { compileGraphIR } from './compiler/ir-compiler'
import { buildManifest } from './embed/manifest'
import { stripPlan, encodeArtifact, type SceneArtifact } from './embed/artifact'
import { mount } from './embed/player'
import { getDefaultTestGraph } from './utils/test-graph'

initializeNodeLibrary()
const { nodes, edges } = getDefaultTestGraph()
const plan = compileGraph(nodes, edges)
if (typeof navigator !== 'undefined' && navigator.gpu) {
  const wgsl = compileGraphIR(nodes, edges)
  if (wgsl) plan.wgsl = { passes: wgsl.passes }
}
const artifact: SceneArtifact = {
  v: 1, kind: 'frozen', plan: stripPlan(plan),
  manifest: buildManifest(plan.userUniforms, nodes),
  images: [], meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
}
const scene = encodeArtifact(artifact)
;(window as unknown as { __embedScene: string }).__embedScene = scene
mount(document.getElementById('box')!, { scene }).then((h) => {
  ;(window as unknown as { __embedHandle: unknown }).__embedHandle = h
  console.log('[embed-dev] mounted; knobs:', h.variables().map((k) => k.key))
})
```

> Confirm the test-graph export name: open `src/utils/test-graph.ts` and use its actual default-preset export. If it is not `getDefaultTestGraph`, substitute the real one (e.g. a named preset) and adjust the import. If no zero-arg preset exists, build a minimal graph inline: one `color_constant` wired into `fragment_output`.

- [ ] **Step 5: Manual smoke**

Run: `npm run dev`, open `http://localhost:5173/sombra/embed-dev.html`.
Expected: the sample shader renders in the 640×360 box; console logs `[embed-dev] mounted; knobs: [...]`. In devtools, run `__embedHandle.set(__embedHandle.variables()[0].key, 1)` and confirm no error (visual change if that knob affects output).

- [ ] **Step 6: Commit**

```bash
git add src/embed/player.ts src/embed/index.ts src/embed/auto-init.ts embed-dev.html src/embed-dev.ts
git commit -m "feat(embed): player core + dev harness"
```

---

## Task 5: Performance harness

**Files:**
- Create: `src/embed/perf-harness.ts`
- Modify: `src/embed/player.ts` (use the harness instead of raw play/pause)

**Interfaces:**
- Consumes: nothing new (pure DOM APIs).
- Produces: `class PerfHarness` with `constructor(el, { onVisible, onHidden, onResize })`, `start()`, `stop()`, `readonly reducedMotion: boolean`.

- [ ] **Step 1: Write the harness**

Create `src/embed/perf-harness.ts`:

```ts
interface HarnessHooks {
  onVisible: () => void   // enter view / tab visible → resume loop
  onHidden: () => void    // leave view / tab hidden → pause loop
  onResize: () => void    // size changed → request a frame
}

/**
 * Gates an embed's animation to when it is actually on screen and the tab is
 * visible, honors prefers-reduced-motion, and requests a frame on resize.
 */
export class PerfHarness {
  readonly reducedMotion: boolean
  private io?: IntersectionObserver
  private ro?: ResizeObserver
  private onVis = () => { document.hidden ? this.hooks.onHidden() : this.maybeVisible() }
  private inView = false

  constructor(private el: HTMLElement, private hooks: HarnessHooks) {
    this.reducedMotion =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  start(): void {
    if (this.reducedMotion) return // static single frame; caller already rendered once
    this.io = new IntersectionObserver((entries) => {
      this.inView = entries.some((e) => e.isIntersecting)
      this.maybeVisible()
    }, { rootMargin: '50px', threshold: 0.01 })
    this.io.observe(this.el)

    this.ro = new ResizeObserver(() => this.hooks.onResize())
    this.ro.observe(this.el)

    document.addEventListener('visibilitychange', this.onVis)
  }

  private maybeVisible(): void {
    if (this.inView && !document.hidden) this.hooks.onVisible()
    else this.hooks.onHidden()
  }

  stop(): void {
    this.io?.disconnect()
    this.ro?.disconnect()
    document.removeEventListener('visibilitychange', this.onVis)
  }
}
```

- [ ] **Step 2: Wire the harness into the player**

In `src/embed/player.ts`, replace the `play()/pause()/autoplay` block and the `resize`/`destroy` handle members. Add the import at top:
```ts
import { PerfHarness } from './perf-harness'
```
Replace the play/pause section with:
```ts
  const rawPlay = () => { if (isAnimated) { renderer.setAnimationSpeed(artifact.meta.timeSpeed); renderer.startAnimation() } }
  const rawPause = () => renderer.stopAnimation()

  const harness = new PerfHarness(el, {
    onVisible: () => { if (autoplayWanted) rawPlay() },
    onHidden: rawPause,
    onResize: () => renderer.requestRender(),
  })
  let autoplayWanted = opts.autoplay !== false
  if (harness.reducedMotion) renderer.notifyChange() // one static frame, no loop
  else harness.start()
```
And update the returned handle members:
```ts
    play: () => { autoplayWanted = true; rawPlay() },
    pause: () => { autoplayWanted = false; rawPause() },
    resize: () => renderer.requestRender(),
    destroy: () => { harness.stop(); renderer.stopAnimation(); renderer.dispose(); canvas.remove() },
```
Remove the now-duplicate `play`/`pause` consts and the old `if (opts.autoplay !== false) play() else notifyChange()` lines. (`autoplayWanted` must be declared before the harness — hoist the `let autoplayWanted` line above the `new PerfHarness` call.)

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`, open `http://localhost:5173/sombra/embed-dev.html`.
- Scroll the box out of view → animation stops (add a temporary `console.log` in `onHidden` if verifying, or watch GPU usage). Scroll back → resumes.
- In devtools, emulate `prefers-reduced-motion: reduce` (Rendering tab) and reload → renders one static frame, no loop.
Expected: no console errors; loop gated correctly.

- [ ] **Step 4: Typecheck**

Run: `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/embed/perf-harness.ts src/embed/player.ts
git commit -m "feat(embed): performance harness (IO/visibility/reduced-motion/resize)"
```

---

## Task 6: Auto-init (data-attribute mount)

**Files:**
- Modify: `src/embed/auto-init.ts` (replace the stub)

**Interfaces:**
- Consumes: `mount` (passed in, to avoid a circular import with index.ts); `MountOptions` type.
- Produces: `initAll(mount: (el: HTMLElement, opts: MountOptions) => Promise<SceneHandle>): void`

- [ ] **Step 1: Replace the stub with the real scanner**

Overwrite `src/embed/auto-init.ts`:

```ts
import type { MountOptions, SceneHandle } from './player'

type MountFn = (el: HTMLElement, opts: MountOptions) => Promise<SceneHandle>

const MOUNTED = 'sombraMounted'

/**
 * Scan the document for [data-sombra-scene] elements and mount each one.
 * Idempotent — elements already mounted are skipped, so calling init()
 * repeatedly (e.g. after DOM insertion) is safe.
 */
export function initAll(mount: MountFn): void {
  if (typeof document === 'undefined') return
  const els = document.querySelectorAll<HTMLElement>('[data-sombra-scene]')
  els.forEach((el) => {
    if (el.dataset[MOUNTED]) return
    const scene = el.dataset.sombraScene
    if (!scene) return
    el.dataset[MOUNTED] = '1'
    void mount(el, {
      scene,
      autoplay: el.dataset.sombraAutoplay !== 'false',
      debug: el.dataset.sombraDebug === 'true',
    })
  })
}
```

- [ ] **Step 2: Add the data-attr path to the dev harness**

In `embed-dev.html`, add a second box below the first that exercises the auto-init path. Append inside `<body>` before the module script:
```html
    <div id="auto" data-sombra-autoplay="true" style="width:640px;height:360px;margin:40px auto"></div>
```
And at the end of `src/embed-dev.ts`, add:
```ts
document.getElementById('auto')!.dataset.sombraScene = scene
import('./embed/index').then((m) => m.init())
```

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`, open `http://localhost:5173/sombra/embed-dev.html`.
Expected: BOTH boxes render. The `#auto` box was mounted purely via `data-sombra-scene` + `init()`. Calling `Sombra.init()` again in devtools does not double-mount (only one canvas child in `#auto`).

- [ ] **Step 4: Commit**

```bash
git add src/embed/auto-init.ts embed-dev.html src/embed-dev.ts
git commit -m "feat(embed): data-attribute auto-mount"
```

---

## Task 7: Player library build + bundle gate

**Files:**
- Create: `vite.embed.config.ts`
- Create: `scripts/verify-embed-bundle.ts`
- Modify: `package.json` (add `build:embed`, `verify:embed:bundle`; chain into `build`)

**Interfaces:**
- Produces: `dist/embed/sombra-player.<version>.umd.js` (self-contained UMD, both backends inlined). Global name `Sombra`.

- [ ] **Step 1: Write the library build config**

Create `vite.embed.config.ts`. UMD requires a single self-contained file, so dynamic backend imports are inlined:

```ts
import { defineConfig } from 'vite'
import { resolve } from 'path'
import { EMBED_VERSION } from './src/embed/version'

// Self-contained UMD player for the copy-paste CDN snippet. Kept separate from
// the main app build (vite.config.ts) so it pulls in NO React/compiler/nodes.
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/embed',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/embed/index.ts'),
      name: 'Sombra',
      formats: ['umd'],
      fileName: () => `sombra-player.${EMBED_VERSION}.umd.js`,
    },
    rollupOptions: {
      output: { inlineDynamicImports: true }, // both renderer backends in one file
    },
  },
})
```

- [ ] **Step 2: Add build + gate scripts**

In `package.json` `scripts`, add:
```json
    "build:embed": "vite build --config vite.embed.config.ts",
    "verify:embed:bundle": "tsx scripts/verify-embed-bundle.ts",
```
Also chain the embed build into the main build so `dist/embed/` ships to Pages. Change:
```json
    "build": "tsc -b && vite build",
```
to:
```json
    "build": "tsc -b && vite build && npm run build:embed",
```

- [ ] **Step 3: Build the player**

Run: `npm run build:embed`
Expected: `dist/embed/sombra-player.0.1.0.umd.js` is written.

- [ ] **Step 4: Write the bundle gate**

Create `scripts/verify-embed-bundle.ts`. It fails if forbidden deps leaked in or the gzip size exceeds budget:

```ts
/**
 * verify-embed-bundle — the player must not bundle React/xyflow/compiler/nodes,
 * and must stay under a size budget. Run AFTER `npm run build:embed`.
 * Run: npx tsx scripts/verify-embed-bundle.ts
 */
import { readFileSync, statSync } from 'fs'
import { gzipSync } from 'zlib'
import { EMBED_VERSION } from '../src/embed/version'

const path = `dist/embed/sombra-player.${EMBED_VERSION}.umd.js`
let passed = 0, failed = 0
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) }
}

let src = ''
try { src = readFileSync(path, 'utf8') } catch { console.error(`  [FAIL] missing ${path} — run npm run build:embed first`); process.exit(1) }

// Forbidden markers — identifiers that only appear if the wrong module tree got pulled in.
const forbidden = ['react-dom', '@xyflow', 'ALL_NODES', 'initializeNodeLibrary', 'compileGraph', 'react/jsx-runtime']
for (const f of forbidden) check(`no "${f}" in bundle`, !src.includes(f))

const raw = statSync(path).size
const gz = gzipSync(src).length
console.log(`  size: ${(raw / 1024).toFixed(1)} KB raw, ${(gz / 1024).toFixed(1)} KB gzip`)
check('gzip under 250 KB budget', gz < 250 * 1024)

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
```

- [ ] **Step 5: Run the gate — expect PASS**

Run: `npx tsx scripts/verify-embed-bundle.ts`
Expected: prints size, `SUMMARY: 7 passed, 0 failed`. If a forbidden marker appears, an editor-only module leaked into the player import graph — trace and remove that import (usually a value import that should be `import type`).

- [ ] **Step 6: Commit**

```bash
git add vite.embed.config.ts scripts/verify-embed-bundle.ts package.json
git commit -m "feat(embed): self-contained UMD player build + bundle gate"
```

---

## Task 8: Publish orchestration + snippets

**Files:**
- Create: `src/embed/publish.ts`
- Create: `scripts/verify-embed-snippets.ts`
- Modify: `package.json` (add `verify:embed:snippets`)

**Interfaces:**
- Consumes: `compileGraph` from `../compiler/glsl-generator`; `compileGraphIR` from `../compiler/ir-compiler`; `anchorToVec2` from `../nodes/output/fragment-output`; `buildManifest` (Task 3); `stripPlan`, `encodeArtifact`, `KnobDescriptor`, `SceneArtifact`, `ImageAsset` (Task 2); `PLAYER_UMD_URL`, `EMBED_VERSION` (Task 1); `Node`, `Edge` types + `NodeData`, `EdgeData`.
- Produces:
  - `buildSnippets(sceneB64: string): { copyPaste: string; developer: string; iframe: string }`
  - `publishScene(nodes, edges, viewerHash?): PublishResult` where `PublishResult = { sceneB64: string; manifest: KnobDescriptor[]; sizeBytes: number; snippets: ReturnType<typeof buildSnippets> }`

- [ ] **Step 1: Write the publish module**

Create `src/embed/publish.ts`:

```ts
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { compileGraph } from '../compiler/glsl-generator'
import { compileGraphIR } from '../compiler/ir-compiler'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { buildManifest } from './manifest'
import { stripPlan, encodeArtifact, type SceneArtifact, type ImageAsset, type KnobDescriptor } from './artifact'
import { PLAYER_UMD_URL } from './version'

export interface PublishResult {
  sceneB64: string
  manifest: KnobDescriptor[]
  sizeBytes: number
  snippets: { copyPaste: string; developer: string; iframe: string }
}

function collectImages(nodes: Node<NodeData>[]): ImageAsset[] {
  const out: ImageAsset[] = []
  for (const n of nodes) {
    if (n.data.type !== 'image') continue
    const dataUrl = n.data.params?.imageData as string | undefined
    if (!dataUrl) continue
    out.push({ sampler: `u_${n.id.replace(/-/g, '_')}_image`, dataUrl })
  }
  return out
}

/** Compile + serialize the current graph into a frozen scene artifact. */
export function publishScene(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  viewerHash?: string,
): PublishResult {
  const plan = compileGraph(nodes, edges)
  if (!plan.success) throw new Error('Shader compilation failed: ' + plan.errors.map((e) => e.message).join('; '))
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    const wgsl = compileGraphIR(nodes, edges)
    if (wgsl) plan.wgsl = { passes: wgsl.passes }
  }

  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const timeNode = nodes.find((n) => n.data.type === 'time')
  const artifact: SceneArtifact = {
    v: 1,
    kind: 'frozen',
    plan: stripPlan(plan),
    manifest: buildManifest(plan.userUniforms, nodes),
    images: collectImages(nodes),
    meta: {
      anchor: anchorToVec2((outputNode?.data.params?.anchor as string) ?? 'center'),
      timeSpeed: (timeNode?.data.params?.speed as number) ?? 1,
    },
  }

  const sceneB64 = encodeArtifact(artifact)
  return {
    sceneB64,
    manifest: artifact.manifest,
    sizeBytes: sceneB64.length,
    snippets: buildSnippets(sceneB64, viewerHash),
  }
}

/** Build the three copy-paste snippet strings. */
export function buildSnippets(sceneB64: string, viewerHash?: string) {
  const copyPaste =
`<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");` +
`i.src="${PLAYER_UMD_URL}";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>\n` +
`<div data-sombra-scene="${sceneB64}" style="width:100%;aspect-ratio:16/9"></div>`

  // mount() is async; use onLoad to get the ready handle (Rive/Spline pattern).
  const developer =
`<script src="${PLAYER_UMD_URL}"></script>\n` +
`<div id="my-shader" style="width:100%;aspect-ratio:16/9"></div>\n` +
`<script>\n  Sombra.mount(document.getElementById('my-shader'), {\n    scene: "${sceneB64}",\n    onLoad: function (shader) {\n      // shader.set('intensity', 0.65);\n    }\n  });\n</script>`

  const iframe = viewerHash
    ? `<iframe src="https://spendolas.github.io/sombra/viewer.html#g=${viewerHash}" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>`
    : '<!-- iframe fallback unavailable: no viewer hash provided -->'

  return { copyPaste, developer, iframe }
}
```

- [ ] **Step 2: Write the snippet verification (pure)**

Create `scripts/verify-embed-snippets.ts`:

```ts
/**
 * verify-embed-snippets — buildSnippets emits well-formed, version-pinned
 * snippets carrying the artifact. Run: npx tsx scripts/verify-embed-snippets.ts
 */
import { buildSnippets } from '../src/embed/publish'
import { EMBED_VERSION } from '../src/embed/version'

let passed = 0, failed = 0
function check(name: string, cond: boolean) { if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) } }

const B64 = 'ABC123_-abc'
const s = buildSnippets(B64, 'HASH')

check('copyPaste carries the artifact', s.copyPaste.includes(`data-sombra-scene="${B64}"`))
check('copyPaste is version-pinned', s.copyPaste.includes(`sombra-player.${EMBED_VERSION}.umd.js`))
check('copyPaste self-bootstraps init', s.copyPaste.includes('Sombra.init()'))
check('developer uses Sombra.mount', s.developer.includes('Sombra.mount(') && s.developer.includes(`scene: "${B64}"`))
check('iframe uses the viewer hash', s.iframe.includes('viewer.html#g=HASH'))
check('iframe absent without hash', buildSnippets(B64).iframe.includes('unavailable'))

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
```

- [ ] **Step 3: Run it — expect PASS**

Run: `npx tsx scripts/verify-embed-snippets.ts`
Expected: `SUMMARY: 6 passed, 0 failed`.

- [ ] **Step 4: Add the npm script**

In `package.json` `scripts`, add:
```json
    "verify:embed:snippets": "tsx scripts/verify-embed-snippets.ts",
```

- [ ] **Step 5: Commit**

```bash
git add src/embed/publish.ts scripts/verify-embed-snippets.ts package.json
git commit -m "feat(embed): publish orchestration + snippet templates"
```

---

## Task 9: Embed modal + toolbar button

**Files:**
- Create: `src/components/EmbedModal.tsx`
- Modify: `src/components/GraphToolbar.tsx`

**Interfaces:**
- Consumes: `publishScene`, `PublishResult` (Task 8); `encodeCompactHash` from `@/utils/sombra-file` (for the iframe hash); `mount` from `@/embed/player` (live preview); `useGraphStore`; `ds` from `@/generated/ds`; `IconButton`.
- Produces: `<EmbedModal open onClose />` React component; a new Embed `IconButton` in the toolbar.

- [ ] **Step 1: Write the modal**

Create `src/components/EmbedModal.tsx`. Follow the existing DS/Tailwind conventions; if a needed visual class has no `ds.*` entry, use a Tailwind token class (`bg-surface-raised`, `text-fg`, etc.) and append a migration note to `.claude/ds-queue.md`.

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { encodeCompactHash } from '@/utils/sombra-file'
import { publishScene, type PublishResult } from '@/embed/publish'
import { mount, type SceneHandle } from '@/embed/player'

type Tab = 'copy' | 'dev' | 'advanced'

export function EmbedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('copy')
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    try {
      const { nodes, edges } = useGraphStore.getState()
      const hash = encodeCompactHash(nodes, edges)
      setResult(publishScene(nodes, edges, hash))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    }
  }, [open])

  // Live preview using the in-repo player (no built bundle needed in dev).
  useEffect(() => {
    if (!open || !result || !previewRef.current) return
    let disposed = false
    previewRef.current.innerHTML = ''
    mount(previewRef.current, { scene: result.sceneB64 }).then((h) => {
      if (disposed) h.destroy(); else handleRef.current = h
    })
    return () => { disposed = true; handleRef.current?.destroy(); handleRef.current = null }
  }, [open, result])

  const sizeKb = useMemo(() => result ? (result.sizeBytes / 1024).toFixed(1) : '0', [result])
  const heavy = !!result && result.sizeBytes > 200 * 1024

  if (!open) return null
  const snippet = result ? (tab === 'copy' ? result.snippets.copyPaste : tab === 'dev' ? result.snippets.developer : result.snippets.iframe) : ''
  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500) })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[720px] max-w-[92vw] max-h-[88vh] overflow-auto rounded-lg bg-surface-alt p-5 text-fg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-fg font-medium">Embed shader</h2>
          <button className="text-fg-subtle hover:text-fg" onClick={onClose}>✕</button>
        </div>

        {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

        <div ref={previewRef} className="w-full aspect-video bg-black rounded mb-3" />

        <div className="flex gap-2 mb-3">
          {(['copy', 'dev', 'advanced'] as Tab[]).map((t) => (
            <button key={t}
              className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-indigo text-fg' : 'bg-surface-raised text-fg-dim'}`}
              onClick={() => setTab(t)}>
              {t === 'copy' ? 'Copy-paste' : t === 'dev' ? 'Developer' : 'Advanced'}
            </button>
          ))}
        </div>

        <div className="text-xs text-fg-subtle mb-2">
          Payload: {sizeKb} KB {heavy && <span className="text-amber-400">— large; consider downscaling baked images</span>}
        </div>

        <pre className="bg-surface-raised text-fg-dim text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{snippet}</pre>
        <button className="mt-2 px-3 py-1 rounded bg-indigo text-fg text-sm" onClick={() => copy(snippet, tab)}>
          {copied === tab ? 'Copied ✓' : 'Copy'}
        </button>

        {tab === 'dev' && result && (
          <div className="mt-4">
            <div className="text-sm text-fg-dim mb-1">Knobs ({result.manifest.length})</div>
            <table className="w-full text-xs text-fg-dim">
              <thead><tr className="text-fg-subtle text-left"><th>key</th><th>type</th><th>range</th><th>example</th></tr></thead>
              <tbody>
                {result.manifest.map((k) => (
                  <tr key={k.key}>
                    <td className="font-mono">{k.key}</td>
                    <td>{k.type}</td>
                    <td>{k.min ?? '—'} … {k.max ?? '—'}</td>
                    <td className="font-mono">shader.set('{k.key}', {k.type === 'color' ? '[1,0,0]' : (k.max ?? 1)})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
```

> **Scope note (image downscale):** spec §4.5 calls for a WebP re-encode + max-dimension downscale control at publish for image-heavy scenes. This plan ships the **size badge + warning** only; the actual re-encode is a fast-follow (a `reencodeImages(images, maxDim)` helper using an offscreen canvas `toDataURL('image/webp')`, wired to a toggle that re-runs `publishScene`). Deferring it keeps v1 scoped; the warning tells the user when it matters. Track in `EMBED.md` fast-follows.

- [ ] **Step 2: Add the toolbar button**

Modify `src/components/GraphToolbar.tsx`:
- Add to the react import (line 5): ensure `useState` is imported (it already is).
- Add the modal import after line 16:
```tsx
import { EmbedModal } from '@/components/EmbedModal'
```
- Add state inside the component (near the existing `copied` state):
```tsx
  const [embedOpen, setEmbedOpen] = useState(false)
```
- Add a new `IconButton` after the share button (after line 73, before `</Panel>`):
```tsx
      <IconButton
        icon="code"
        onClick={() => setEmbedOpen(true)}
        title="Embed on a website"
      />
```
- Render the modal after the `</Panel>` close tag, wrapping the return in a fragment:
```tsx
  return (
    <>
      <Panel position="top-left" className={ds.graphToolbar.root}>
        {/* existing buttons ... */}
        <IconButton icon="code" onClick={() => setEmbedOpen(true)} title="Embed on a website" />
      </Panel>
      <EmbedModal open={embedOpen} onClose={() => setEmbedOpen(false)} />
    </>
  )
```

> Confirm `IconButton` supports an `icon="code"` name. Open `src/components/IconButton.tsx` and check the icon map; if `code` is not registered, add the `Code` icon from `lucide-react` to that map (follow the existing registration pattern), or use an already-registered icon name that reads as "embed".

- [ ] **Step 3: Manual smoke**

Run: `npm run dev`, open the editor, build a simple shader (or load a preset), click the new Embed button.
Expected: modal opens, live preview renders the shader, all three tabs show snippets, Copy works, the Developer tab lists knobs with `shader.set(...)` examples, payload size shows.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc -b --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/EmbedModal.tsx src/components/GraphToolbar.tsx
git commit -m "feat(embed): publish modal + toolbar button"
```

---

## Task 10: Browser smoke automation + docs

**Files:**
- Create: `scripts/verify-embed-smoke.ts`
- Create: `EMBED.md`
- Modify: `BROWSER-AUTOMATION.md`, `CLAUDE.md`, `AGENTS.md`, `ROADMAP.md`
- Modify: `package.json` (add `verify:embed:smoke`, `verify:embed`)

**Interfaces:**
- Consumes: `playwright-core`; the dev server (`embed-dev.html`).
- Produces: an automated end-to-end smoke that mounts the player and asserts pixels + a knob change.

- [ ] **Step 1: Write the smoke script**

Create `scripts/verify-embed-smoke.ts`. It assumes the dev server is running (documented in the header); it navigates to the harness, waits for mount, samples canvas pixels, sets a knob, and re-samples.

```ts
/**
 * verify-embed-smoke — end-to-end: the built-in dev harness must mount the
 * player, render non-blank pixels, and react to handle.set().
 *
 * Prereq: dev server running — `npm run dev` in another terminal.
 * Run: npx tsx scripts/verify-embed-smoke.ts
 */
import { chromium } from 'playwright-core'

const URL = process.env.EMBED_DEV_URL ?? 'http://localhost:5173/sombra/embed-dev.html'
let passed = 0, failed = 0
function check(name: string, cond: boolean) { if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) } }

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => (window as any).__embedHandle !== undefined, { timeout: 10000 })

  // Non-blank pixels in the first canvas.
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement
    const gl = c.getContext('webgl2') ?? c.getContext('webgpu')
    // Read via a 2D snapshot for backend-agnostic sampling.
    const snap = document.createElement('canvas'); snap.width = c.width; snap.height = c.height
    const ctx = snap.getContext('2d')!; ctx.drawImage(c, 0, 0)
    const d = ctx.getImageData(0, 0, Math.min(8, c.width), Math.min(8, c.height)).data
    let varied = false
    for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) { varied = true; break }
    return { hasPixels: d.some((v, i) => i % 4 !== 3 && v !== 0), varied, backend: gl ? 'ok' : 'none' }
  })
  check('canvas produced non-black pixels', nonBlank.hasPixels)

  // handle.set on the first knob does not throw.
  const setOk = await page.evaluate(() => {
    const h = (window as any).__embedHandle
    const keys = h.variables()
    if (!keys.length) return true // no knobs is valid for some graphs
    try { h.set(keys[0].key, keys[0].max ?? 1); return true } catch { return false }
  })
  check('handle.set() on a knob does not throw', setOk)
} finally {
  await browser.close()
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
```

> Note: `playwright-core` needs a Chromium binary. If none is installed in this environment, document the smoke as manual (open `embed-dev.html`, run the two `page.evaluate` bodies in the console) and skip the automated script rather than blocking. Confirm the dev port (Vite default 5173; the `base:'/sombra/'` means the harness lives at `/sombra/embed-dev.html`).

- [ ] **Step 2: Run the smoke (dev server running)**

Run (in one terminal): `npm run dev`
Run (in another): `npx tsx scripts/verify-embed-smoke.ts`
Expected: `SUMMARY: 2 passed, 0 failed`.

- [ ] **Step 3: Add the aggregate verify scripts**

In `package.json` `scripts`, add:
```json
    "verify:embed:smoke": "tsx scripts/verify-embed-smoke.ts",
    "verify:embed": "npm run verify:embed:artifact && npm run verify:embed:manifest && npm run verify:embed:snippets",
```
(`verify:embed` runs the offline pure checks; bundle + smoke are run explicitly since they need a build / dev server.)

- [ ] **Step 4: Write `EMBED.md`**

Create `EMBED.md` documenting: the artifact format (`SceneArtifact` shape + the vertex-omission invariant), the three snippets, the full `Sombra.mount` / `SceneHandle` API with every method, the `data-sombra-*` attributes (`scene`, `autoplay`, `debug`), the perf harness behaviors, backend/fallback notes, and the version-pinning/CDN scheme. Include the "frozen knobs-only, door open for live" scope and the v2 fast-follows (pointer/`u_mouse`, self-hosted file, per-knob rename, shared context, minification).

- [ ] **Step 5: Update the other docs**

- `BROWSER-AUTOMATION.md`: add a section for the player API (`window.Sombra`, `mount`, `SceneHandle`) and the `verify-embed-smoke.ts` method.
- `CLAUDE.md` and `AGENTS.md`: under Architecture, add the `src/embed/` layer (shared/player vs editor-side split + the "player imports nothing from compiler/nodes/React" rule) and the `dist/embed/` build target; add embed verify scripts to the Commands list.
- `ROADMAP.md`: add the embed phase to the history.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-embed-smoke.ts EMBED.md BROWSER-AUTOMATION.md CLAUDE.md AGENTS.md ROADMAP.md package.json
git commit -m "feat(embed): browser smoke + docs"
```

---

## Optional side-task: attribute-less fullscreen triangle

**Independent of the embed feature — do only if desired; it does not gate anything above.** Drops the quad vertex buffer/attribute in both core renderers by generating geometry from the vertex index.

**Files:** `src/webgl/renderer.ts`, `src/webgpu/renderer.ts`, `src/compiler/glsl-generator.ts` (`VERTEX_SHADER`), `src/embed/vertex.ts` (keep the two in sync), `scripts/validate-wgsl-multipass.ts` (re-run).

- [ ] **Step 1:** Replace `VERTEX_SHADER` (and the WGSL vertex stage) with the attribute-less form:
```glsl
#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  v_uv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v_uv * 2.0 - 1.0, 0.0, 1.0);
}
```
Update `src/embed/vertex.ts` to match (the round-trip invariant test enforces this).
- [ ] **Step 2:** In both renderers, remove the `a_position` buffer + attrib setup; change the draw call to `drawArrays(TRIANGLES, 0, 3)` (WebGL2) and the equivalent 3-vertex draw (WebGPU). Remove now-dead buffer allocation.
- [ ] **Step 3:** Verify: `npx tsx scripts/validate-wgsl-multipass.ts`, `npx tsx scripts/verify-artifact-roundtrip.ts`, and a manual editor + viewer render check across a multi-pass graph.
- [ ] **Step 4:** Commit: `git commit -m "perf(renderer): attribute-less fullscreen triangle"`

---

## Final integration gate

After Task 10, run the full suite and confirm clean:

- [ ] `npx tsc -b --noEmit` — no type errors
- [ ] `npm run lint` — clean
- [ ] `npm run verify:embed` — pure checks pass
- [ ] `npm run build:embed && npx tsx scripts/verify-embed-bundle.ts` — player builds, gate passes
- [ ] `npm run dev` + `npx tsx scripts/verify-embed-smoke.ts` — end-to-end smoke passes
- [ ] `npm run build` — full build (including chained `build:embed`) succeeds
- [ ] Manual: publish a shader from the editor, paste the copy-paste snippet into a bare local HTML file loading the built `dist/embed/sombra-player.0.1.0.umd.js`, confirm it renders and `Sombra`-mounted knobs respond.

Then use `superpowers:finishing-a-development-branch` to integrate `feat/shader-embed`.
