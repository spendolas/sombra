/**
 * Does the ENGINE implement the per-pass resolution contract, on real GPUs?
 *
 * scripts/verify-pass-size.ts proves the arithmetic and
 * scripts/verify-pass-resolution.ts proves the plan carries the field. Neither
 * runs a renderer. This one does: it drives `WebGL2ShaderRenderer` and
 * `WebGPUShaderRenderer` themselves and asserts that a pass rendered at scale
 * `s` — with `u_resolution = u_viewport = s*canvas` AND `u_dpr = s*dpr` — leaves
 * anchor-pinned content exactly where it was.
 *
 * Four gates:
 *   1. PINNING (engine + rig)  a scaled intermediate does not move the content.
 *      Measured as a luminance CENTROID in pixels, not a mean: a mean happily
 *      passes a pattern that has shifted, and that exact mistake once made a
 *      frost harness report clean numbers while comparing a shader to itself.
 *      Covers all 9 Fragment Output anchors, and cross-checks the engine against
 *      `scripts/blur-bakeoff/lib/gpu-rig.ts`, whose own `PassSpec.scale` is an
 *      INDEPENDENT implementation of per-pass scaling.
 *   2. SCALE-1 IDENTITY (engine + rig)  `resolution: 1` is byte-identical to no
 *      declared resolution at all, so the no-op path is provably a no-op.
 *   3. POOL THRASH (engine)  a mixed-scale plan allocates nothing after warmup.
 *      Both main renderers made their staleness guards per-pass specifically to
 *      prevent this; src/webgpu/renderer.ts:456 records the same bug happening
 *      before from a single-value comparison.
 *   4. PREVIEW AGREEMENT (preview renderers)  a two-pass thumbnail whose first
 *      pass declares 0.5 allocates a 40x40 intermediate and still lands its
 *      content on the same pixel. The preview renderers are a SECOND
 *      implementation of the contract — own uniform upload, own allocation, a
 *      4 px floor instead of 1, `u_anchor` pinned to centre — so gates 1–3 say
 *      nothing about them.
 *
 * No shipped node declares a scale (deliberately — this change is plumbing), so
 * the producer is a synthetic node registered in the page, mirroring what
 * scripts/verify-pass-resolution.ts does in Node. The engine half runs the real
 * `src/` modules, served by a throwaway Vite dev server and imported into a
 * blank page on that origin — no app, no worker, no React.
 *
 * A run that skips BOTH backends is a FAILURE, not a pass. Silent skips that
 * read as green are the specific failure mode this gate exists to prevent.
 *
 * SCOPE. Headless, so `devicePixelRatio` is 1 throughout: no `dpr > 1` capture is
 * exercised on any half. Both MAIN renderers (`WebGL2ShaderRenderer`,
 * `WebGPUShaderRenderer`) and both PREVIEW renderers (`WebGL2PreviewRenderer`,
 * `WebGPUPreviewRenderer`) are covered — previews by gate 4, added when spec gate
 * 6 was found claimed but unbuilt. Noted so a green pass count is not over-read.
 *
 * Run: npx tsx scripts/verify-pass-resolution-gpu.ts
 */
import { createServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRig } from './blur-bakeoff/lib/gpu-rig'
import { encodePng } from './blur-bakeoff/lib/png'
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import type { Rgba8 } from './blur-bakeoff/lib/image'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = resolve(ROOT, 'reports/pass-resolution')

/** Canvas edge, CSS px. headless devicePixelRatio is 1, so also device px. */
const SIZE = 256
/** Blob centre offset from the anchor point, in REFERENCE px (u_ref_size units). */
const INSET = 88
/**
 * Extra offset applied only where the inset vanishes.
 *
 * The inset is `(1 - 2a) * INSET`, which is ZERO at `a = 0.5` — content sits
 * exactly on the anchor point, and content on the anchor point cannot move when
 * a pass is rescaled no matter how wrong `u_dpr` is. Measured: with the dpr
 * scaling removed from `passTargetSize`, all eight off-centre anchors moved
 * 44–136 px and `center` moved 0.000 px. Since `center` is the DEFAULT anchor,
 * that is the one blind spot least acceptable to keep, so a weight of
 * `1 - |1 - 2a|` — 1 at the centre, 0 at either extreme — adds a displacement
 * exactly where the inset stops providing one, without pushing the blob off the
 * canvas at the extremes.
 *
 * The value is chosen so the three per-axis positions (88 / 154 / 168 px at
 * SIZE 256) are all DISTINCT: with 40 the centre landed on 168, exactly where
 * the far anchor does, and two of the nine reference PNGs came out
 * indistinguishable — which reads to a human reviewer like the anchor being
 * ignored.
 */
const OFFSET = 26
/** Blob sigma, in reference px. Wide enough to survive a 0.25 downscale. */
const SIGMA = 18
/** Thumbnail edge, px. Both preview renderers hard-code this. */
const PREVIEW_SIZE = 80
/**
 * Preview probe geometry, in reference px — deliberately not the main probe's.
 *
 * Both preview renderers pin `u_anchor` to (0.5, 0.5), where the `(1 - 2a)·INSET`
 * term is identically zero, so the centre-weighted OFFSET is the ONLY thing that
 * displaces the blob — and displacement is what makes a wrong `u_dpr` visible.
 * The main probe's σ of 18 reference px would also reach past every edge of an
 * 80 px thumbnail, clipping the blob asymmetrically and biasing the very centroid
 * being measured. 12 px off centre at σ 7 puts 4σ = 28 px against a 28 px edge
 * distance: clipped amplitude e^-8 ≈ 0.03 codes, i.e. nothing.
 */
const PREVIEW_OFFSET = 12
const PREVIEW_SIGMA = 7
/** Scale the preview gate's first pass declares. 0.5 × 80 = 40 px. */
const PREVIEW_SCALE = 0.5
/** The 9 Fragment Output anchors, as `anchorToVec2` names them. */
const ANCHORS = ['tl', 'tc', 'tr', 'cl', 'center', 'cr', 'bl', 'bc', 'br'] as const
/** Scales the probe pass is asked to render at, besides the 1.0 baseline. */
const SCALES = [0.5, 0.25, 2] as const
/** How far a centroid may move, in canvas px, before pinning is broken. */
const PIN_TOL_PX = 1.0

type Backend = 'webgpu' | 'webgl2'

// ---------------------------------------------------------------------------
// Measurement (Node side — one implementation, and see the self-test below)
// ---------------------------------------------------------------------------

interface Frame {
  width: number
  height: number
  data: Uint8ClampedArray
}

interface Centroid {
  /** Luminance-weighted mean column, in px. */
  cx: number
  /** Luminance-weighted mean row, in px. */
  cy: number
  /** Total luminance weight — 0 means a blank frame, i.e. nothing was measured. */
  weight: number
  /** Brightest channel value seen, for a blank-frame guard. */
  max: number
}

/**
 * Brightness centroid, in PIXELS.
 *
 * Pixels, not normalised units, because the claim under test is stated in
 * pixels ("content must not move"), and because a normalised centroid hides how
 * big a shift it is describing — 0.005 sounds tiny and is 1.3 px at 256 wide.
 *
 * A centroid rather than a mean: the mean of a shifted pattern is unchanged, so
 * a mean-based gate passes exactly the failure this exists to catch. For a
 * compact blob on black the centroid IS the blob's centre of mass, so a 1 px
 * translation moves it by 1 px (asserted in the self-test below).
 */
function centroid(img: Frame): Centroid {
  let sx = 0
  let sy = 0
  let w = 0
  let max = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3
      if (img.data[i] > max) max = img.data[i]
      sx += l * x
      sy += l * y
      w += l
    }
  }
  return { cx: w > 0 ? sx / w : 0, cy: w > 0 ? sy / w : 0, weight: w, max }
}

/**
 * How many bytes differ at all. Used as the anti-vacuity signal for the pinning
 * gate: a smooth blob resampled through a half-size target differs from a native
 * render by only ~1 code, so a MAGNITUDE threshold would be brittle, while the
 * COUNT is large and unambiguous. (The decisive check is still the allocated
 * texture size; this one catches "the scale silently did nothing".)
 */
function countByteDiffs(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return a.data.length
  let n = 0
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++
  return n
}

/** Largest absolute byte difference between two same-sized frames. */
function maxByteDiff(a: Frame, b: Frame): number {
  if (a.width !== b.width || a.height !== b.height) return 255
  let m = 0
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i])
    if (d > m) m = d
  }
  return m
}

/**
 * Analytic blob centre as a CENTROID INDEX (col, row), y DOWN — see the probe
 * body. The shader places the centre at `res*a + (1-2a)*dpr*INSET` in
 * continuous fragment coordinates, where pixel `i` spans `[i, i+1)`; `centroid()`
 * weights each pixel at its integer index, i.e. half a pixel lower.
 */
function predictedCentre(anchor: readonly [number, number]): { cx: number; cy: number } {
  const at = (a: number) =>
    SIZE * a + (1 - 2 * a) * INSET + (1 - Math.abs(1 - 2 * a)) * OFFSET - 0.5
  return { cx: at(anchor[0]), cy: at(anchor[1]) }
}

/**
 * The same prediction for the PREVIEW probe: 80 px target, `u_anchor` pinned to
 * (0.5, 0.5) by both preview renderers, so the inset term drops out and the
 * centre-weighted offset is the whole displacement.
 */
function predictedPreviewCentre(): { cx: number; cy: number } {
  const at = PREVIEW_SIZE * 0.5 + PREVIEW_OFFSET - 0.5
  return { cx: at, cy: at }
}

function anchorToVec2(anchor: string): [number, number] {
  switch (anchor) {
    case 'tl': return [0, 0]
    case 'tc': return [0.5, 0]
    case 'tr': return [1, 0]
    case 'cl': return [0, 0.5]
    case 'cr': return [1, 0.5]
    case 'bl': return [0, 1]
    case 'bc': return [0.5, 1]
    case 'br': return [1, 1]
    default: return [0.5, 0.5]
  }
}

function toFrame(res: { width: number; height: number; b64: string }): Frame {
  return {
    width: res.width,
    height: res.height,
    data: new Uint8ClampedArray(Buffer.from(res.b64, 'base64')),
  }
}

function savePng(name: string, img: Frame): void {
  const rgba: Rgba8 = { width: img.width, height: img.height, data: img.data }
  writeFileSync(resolve(OUT_DIR, name), encodePng(rgba))
}

// ---------------------------------------------------------------------------
// The rig's probe body, in the rig's shared GLSL/WGSL dialect
// ---------------------------------------------------------------------------

/**
 * The same Gaussian blob the engine's synthetic node draws, expressed against
 * the rig's uniforms so the two can be compared numerically.
 *
 * The rig has no u_dpr — it hands each pass its own target size — so the pass
 * derives the effective dpr as `u_resolution.x / fullWidth`, which is exactly
 * how `passTargetSize()` derives it (from the ACTUAL integer width, never the
 * requested float). That makes the agreement below a real cross-check of the
 * sizing arithmetic rather than a tautology.
 *
 * No `?:` and no `vec2<u32>`: the body must compile as both GLSL ES 3.0 and
 * WGSL, where the rig aliases `vec2`→`vec2f` and `float`→`f32`. Local
 * declarations still differ, so they go through `decl` — same shape as
 * `syntax()` in scripts/blur-bakeoff/lib/shaders.ts.
 */
function rigProbeBody(anchor: readonly [number, number], backend: Backend): string {
  const decl = backend === 'webgpu'
    ? (t: string, n: string, init: string) => `var ${n}: ${t} = ${init};`
    : (t: string, n: string, init: string) => `${t} ${n} = ${init};`
  const a = `vec2(${anchor[0].toFixed(1)}, ${anchor[1].toFixed(1)})`
  return [
    decl('vec2', 'res', 'U.u_resolution'),
    decl('float', 'dpr', `res.x / ${SIZE}.0`),
    decl('vec2', 'anc', a),
    decl('vec2', 'pb', 'uv * res - res * anc'),
    decl('vec2', 'pc', `(vec2(1.0) - 2.0 * anc) * (dpr * ${INSET}.0) + (vec2(1.0) - abs(vec2(1.0) - 2.0 * anc)) * (dpr * ${OFFSET}.0)`),
    decl('float', 'd', `length(pb - pc) / (dpr * ${SIGMA}.0)`),
    'return vec4(vec3(exp(-0.5 * d * d)), 1.0);',
  ].join('\n  ')
}

const RIG_PASSTHROUGH = 'return sampleSrc(uv);'

// ---------------------------------------------------------------------------
// In-page engine harness
// ---------------------------------------------------------------------------

interface CaptureReq {
  backend: Backend
  anchor: string
  /** undefined → register the node type that declares NO resolution at all. */
  scale?: number
}

interface CaptureRes {
  ok: boolean
  error?: string
  width: number
  height: number
  b64: string
  /** Per-pass target sizes the plan asked for, for the record. */
  planResolutions: Array<number | null>
  passCount: number
  /**
   * Sizes of the intermediate render targets the RENDERER actually allocated,
   * read from its own state. Without this the pinning gate would pass vacuously
   * if the engine ignored `resolution` and rendered everything full size.
   */
  intermediates: string[]
}

interface PreviewCaptureRes {
  ok: boolean
  error?: string
  width: number
  height: number
  b64: string
  planResolutions: Array<number | null>
  passCount: number
  /**
   * Sizes of the intermediate targets the PREVIEW renderer allocated. Same
   * anti-vacuity role as `CaptureRes.intermediates`: a preview that ignored
   * `resolution` outright would produce a byte-identical thumbnail and pass every
   * position metric.
   */
  intermediates: string[]
}

interface ThrashRes {
  ok: boolean
  error?: string
  /** texImage2D / createTexture calls while the plan was installed + warmed. */
  duringSetup: number
  /** …and across the 60 frames after warmup. Must be 0. */
  afterWarmup: number
  /** Sizes the renderer's pool really held, to confirm the plan was mixed-scale. */
  sizes: string[]
}

/**
 * Everything the page needs, installed once as `window.__gate`.
 *
 * Written as a single stringified function because Playwright serialises the
 * function source: it may reference only its own argument, never this file's
 * scope.
 */
async function installHarness(page: Page, cfg: {
  size: number
  inset: number
  offset: number
  sigma: number
  /** Thumbnail edge for the preview half. */
  previewSize: number
  previewOffset: number
  previewSigma: number
  /** Vite's dev base, e.g. '/sombra/' — module URLs hang off it. */
  base: string
}): Promise<{ webgpu: boolean; webgl2: boolean }> {
  return await page.evaluate(async (c) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any
    const num = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`)

    const [nodesMod, registryMod, glslMod, irMod, irTypes, subMod, irSubMod] = await Promise.all([
      import(/* @vite-ignore */ `${c.base}src/nodes/index.ts`),
      import(/* @vite-ignore */ `${c.base}src/nodes/registry.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/glsl-generator.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir-compiler.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir/types.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/subgraph-compiler.ts`),
      import(/* @vite-ignore */ `${c.base}src/compiler/ir-subgraph-compiler.ts`),
    ])
    nodesMod.initializeNodeLibrary()
    const { nodeRegistry } = registryMod
    const { compileGraph } = glslMod
    const { compileGraphIR } = irMod
    const { raw, declare, variable, binary, textureSample } = irTypes
    const { compileNodePreview } = subMod
    const { compileNodePreviewIR } = irSubMod

    // ---- the synthetic scale-declaring node ------------------------------
    // Two roles in one type, chosen by whether `source` is wired:
    //   unwired  → PROBE: draws a Gaussian blob pinned to the anchor via the
    //              compiler's own auto_uv (the formula under test), so the blob
    //              lives in whatever pass this node lands in.
    //   wired    → RELAY: passes the previous pass's texture straight through,
    //              which is what pulls the probe's pass back up to full size.
    // `count: () => 1` means expand-passes leaves it alone; the pass boundary
    // comes from the downstream relay's textureInput, and
    // `resolvePassResolution` still reads multiPass.resolution.
    //
    // `geo` is the blob's placement, in reference px. It is a parameter because
    // the main half draws on a 256 px canvas and the preview half on an 80 px
    // thumbnail, where the main geometry would overflow every edge.
    const makeDef = (
      type: string,
      declaresScale: boolean,
      geo: { inset: number; offset: number; sigma: number },
    ) => ({
      type,
      label: type,
      category: 'Effect',
      description: 'GPU gate probe — registered at runtime, never shipped',
      multiPass: declaresScale
        ? {
            count: () => 1,
            from: 'color',
            to: 'source',
            resolution: (_i: number, params: Record<string, unknown>) =>
              Number(params.testScale ?? 1),
          }
        : undefined,
      inputs: [
        { id: 'source', label: 'Source', type: 'color', textureInput: true, default: [0, 0, 0, 1] },
        { id: 'coords', label: 'Coords', type: 'vec2', default: 'auto_uv' },
      ],
      outputs: [{ id: 'color', label: 'Color', type: 'color' }],
      params: [
        { id: 'testScale', label: 'Test Scale', type: 'float', default: 1, min: 0.01, max: 4, step: 0.01, updateMode: 'recompile', hidden: true },
      ],
      glsl: (ctx: any) => {
        const id = ctx.nodeId.replace(/-/g, '_')
        const sampler = ctx.textureSamplers?.source
        if (sampler) {
          ctx.uniforms.add('u_viewport')
          return `vec4 ${ctx.outputs.color} = texture(${sampler}, gl_FragCoord.xy / u_viewport);`
        }
        ctx.uniforms.add('u_resolution')
        ctx.uniforms.add('u_anchor')
        ctx.uniforms.add('u_dpr')
        ctx.uniforms.add('u_ref_size')
        return [
          `vec2 gpb_${id} = (${ctx.inputs.coords} - u_anchor) * (u_dpr * u_ref_size);`,
          `vec2 gpc_${id} = (vec2(1.0) - 2.0 * u_anchor) * (u_dpr * ${num(geo.inset)}) + (vec2(1.0) - abs(vec2(1.0) - 2.0 * u_anchor)) * (u_dpr * ${num(geo.offset)});`,
          `float gpd_${id} = length(gpb_${id} - gpc_${id}) / (u_dpr * ${num(geo.sigma)});`,
          `vec4 ${ctx.outputs.color} = vec4(vec3(exp(-0.5 * gpd_${id} * gpd_${id})), 1.0);`,
        ].join('\n  ')
      },
      ir: (ctx: any) => {
        const id = ctx.nodeId.replace(/-/g, '_')
        const sampler = ctx.textureSamplers?.source
        if (sampler) {
          return {
            statements: [
              declare(ctx.outputs.color, 'vec4', textureSample(sampler,
                binary('/', variable('gl_FragCoord.xy'), variable('u_viewport'), 'vec2'))),
            ],
            uniforms: [],
            standardUniforms: new Set(['u_viewport']),
          }
        }
        // Explicit WGSL rather than the mechanical translation: this body is the
        // thing under test, so it must not depend on a translator's guesses.
        return {
          statements: [
            raw(
              [
                `vec2 gpb_${id} = (${ctx.inputs.coords} - u_anchor) * (u_dpr * u_ref_size);`,
                `vec2 gpc_${id} = (vec2(1.0) - 2.0 * u_anchor) * (u_dpr * ${num(geo.inset)}) + (vec2(1.0) - abs(vec2(1.0) - 2.0 * u_anchor)) * (u_dpr * ${num(geo.offset)});`,
                `float gpd_${id} = length(gpb_${id} - gpc_${id}) / (u_dpr * ${num(geo.sigma)});`,
                `vec4 ${ctx.outputs.color} = vec4(vec3(exp(-0.5 * gpd_${id} * gpd_${id})), 1.0);`,
              ].join('\n  '),
              [
                `let gpb_${id}: vec2f = (${ctx.inputs.coords} - u_anchor) * (u_dpr * u_ref_size);`,
                `let gpc_${id}: vec2f = (vec2f(1.0) - 2.0 * u_anchor) * (u_dpr * ${num(geo.inset)}) + (vec2f(1.0) - abs(vec2f(1.0) - 2.0 * u_anchor)) * (u_dpr * ${num(geo.offset)});`,
                `let gpd_${id}: f32 = length(gpb_${id} - gpc_${id}) / (u_dpr * ${num(geo.sigma)});`,
                `let ${ctx.outputs.color}: vec4f = vec4f(vec3f(exp(-0.5 * gpd_${id} * gpd_${id})), 1.0);`,
              ].join('\n  '),
            ),
          ],
          uniforms: [],
          standardUniforms: new Set(['u_resolution', 'u_anchor', 'u_dpr', 'u_ref_size']),
        }
      },
    })

    const MAIN_GEO = { inset: c.inset, offset: c.offset, sigma: c.sigma }
    // Preview variants. `inset: 0` because the previews pin `u_anchor` to
    // (0.5, 0.5) and the inset term is multiplied by `(1 - 2·0.5) = 0` — writing
    // 0 says that rather than leaving a number that does nothing.
    const PREVIEW_GEO = { inset: 0, offset: c.previewOffset, sigma: c.previewSigma }
    nodeRegistry.register(makeDef('gate_scaled', true, MAIN_GEO))
    nodeRegistry.register(makeDef('gate_plain', false, MAIN_GEO))
    nodeRegistry.register(makeDef('gate_pv_scaled', true, PREVIEW_GEO))
    nodeRegistry.register(makeDef('gate_pv_plain', false, PREVIEW_GEO))

    const anchorToVec2 = (a: string): [number, number] => {
      switch (a) {
        case 'tl': return [0, 0]
        case 'tc': return [0.5, 0]
        case 'tr': return [1, 0]
        case 'cl': return [0, 0.5]
        case 'cr': return [1, 0.5]
        case 'bl': return [0, 1]
        case 'bc': return [0.5, 1]
        case 'br': return [1, 1]
        default: return [0.5, 0.5]
      }
    }

    const node = (id: string, type: string, params: Record<string, unknown> = {}) =>
      ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } })
    const edge = (id: string, s: string, sh: string, t: string, th: string) =>
      ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th })

    /** probe → relay… → fragment_output. `scales[0]` is the probe's. */
    function buildPlan(scales: Array<number | undefined>, anchor: string) {
      const nodes: any[] = []
      const edges: any[] = []
      scales.forEach((s, i) => {
        const type = s === undefined ? 'gate_plain' : 'gate_scaled'
        nodes.push(node(`p${i}`, type, s === undefined ? {} : { testScale: s }))
        if (i > 0) edges.push(edge(`e${i}`, `p${i - 1}`, 'color', `p${i}`, 'source'))
      })
      nodes.push(node('out', 'fragment_output', { anchor, alpha: 1, alphaOp: 'multiply', quality: 'high' }))
      edges.push(edge('eo', `p${scales.length - 1}`, 'color', 'out', 'color'))

      const plan = compileGraph(nodes, edges)
      if (!plan.success) throw new Error(`GLSL compile failed: ${JSON.stringify(plan.errors)}`)
      // compileGraph() never populates plan.wgsl; every real caller merges the IR
      // half in by hand (src/embed/publish.ts:48), so do the same here.
      const ir = compileGraphIR(nodes, edges)
      if (!ir) throw new Error('IR compile returned null')
      plan.wgsl = { passes: ir.passes }
      return plan
    }

    /**
     * Install a plan the way a real caller does. The uniform upload is NOT
     * optional: Fragment Output multiplies by `u_out_alpha`, and an unbound
     * uniform reads as 0, so skipping this renders a fully transparent frame
     * that looks exactly like a broken pass (src/viewer.ts:105 does the same).
     */
    function install(r: any, plan: any, anchor: string) {
      r.setAnchor(anchorToVec2(anchor))
      const res = r.updateRenderPlan(plan)
      if (!res.success) throw new Error(`updateRenderPlan: ${res.error}`)
      if (plan.userUniforms?.length) {
        r.updateUniforms(plan.userUniforms.map((u: any) => ({ name: u.name, value: u.value })))
      }
    }

    // ---- renderers -------------------------------------------------------
    const open: Record<string, any> = {}

    async function renderer(backend: string) {
      if (open[backend]) return open[backend]
      const canvas = document.createElement('canvas')
      canvas.style.width = `${c.size}px`
      canvas.style.height = `${c.size}px`
      canvas.style.display = 'block'
      document.body.appendChild(canvas)
      const mod = backend === 'webgpu'
        ? await import(/* @vite-ignore */ `${c.base}src/webgpu/renderer.ts`)
        : await import(/* @vite-ignore */ `${c.base}src/webgl/renderer.ts`)
      const r = backend === 'webgpu'
        ? new mod.WebGPUShaderRenderer()
        : new mod.WebGL2ShaderRenderer()
      await r.init(canvas)
      // Pin the DPR scale: 'adaptive' + animated would render at 0.75x and the
      // measured centroid would describe a different canvas than the plan does.
      r.setAnimated(false)
      r.setQualityTier('high')
      open[backend] = { canvas, renderer: r }
      return open[backend]
    }

    /**
     * The sizes the renderer really allocated for its intermediates, from its
     * own private pool. This is the only way to tell "the pass was rendered at
     * 64x64 and pinning survived" from "the scale was ignored, so of course
     * nothing moved" — the second reads identical on every pixel metric.
     */
    function intermediates(r: any, backend: string): string[] {
      const pool = backend === 'webgpu' ? r.intermediateTextures : r.fboPool
      if (!pool) return []
      return pool.map((t: any) => `${t.width}x${t.height}`)
    }

    /**
     * Render, then snapshot.
     *
     * Everything from `render()` to `getImageData()` must stay in ONE
     * synchronous run: the WebGL2 context is created without
     * `preserveDrawingBuffer`, so an `await` here would let the compositor
     * discard the frame and every capture would come back black — which the
     * blank-frame assertions would report as a broken renderer.
     *
     * `render()` also sizes the canvas from `clientWidth * dpr`, so `canvas.width`
     * is only trustworthy after it has run once.
     */
    function grab(canvas: HTMLCanvasElement, r: any) {
      r.render()
      return drawToShot(canvas, canvas.width, canvas.height)
    }

    /**
     * Composite a canvas or ImageBitmap onto an opaque 2D canvas and read it
     * back as base64 RGBA. Opaque backing because a transparent capture would
     * otherwise read as black and be indistinguishable from a frame that
     * rendered nothing.
     */
    function drawToShot(src: CanvasImageSource, width: number, height: number) {
      const out = document.createElement('canvas')
      out.width = width
      out.height = height
      const ctx = out.getContext('2d', { willReadFrequently: true })!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(src, 0, 0)
      const px = ctx.getImageData(0, 0, out.width, out.height).data
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < px.length; i += CH) {
        bin += String.fromCharCode.apply(null, px.subarray(i, i + CH) as unknown as number[])
      }
      return { width: out.width, height: out.height, b64: btoa(bin) }
    }

    // ---- preview renderers ------------------------------------------------
    const openPv: Record<string, any> = {}

    /**
     * A preview renderer, as production wires it.
     *
     * WebGPU preview takes the MAIN renderer's `GPUDevice` (that sharing is the
     * production arrangement — see src/renderer/create-renderer.ts), so this
     * depends on `renderer(backend)` having been stood up first. WebGL2 preview
     * owns its own OffscreenCanvas and needs nothing.
     */
    async function previewRenderer(backend: string) {
      if (openPv[backend]) return openPv[backend]
      let r: any
      if (backend === 'webgpu') {
        const mod = await import(/* @vite-ignore */ `${c.base}src/webgpu/preview-renderer.ts`)
        const main = await renderer('webgpu')
        r = new mod.WebGPUPreviewRenderer(main.renderer.getDevice())
      } else {
        const mod = await import(/* @vite-ignore */ `${c.base}src/webgl/preview-renderer.ts`)
        r = new mod.WebGL2PreviewRenderer()
      }
      await r.init()
      openPv[backend] = { renderer: r }
      return openPv[backend]
    }

    /**
     * probe → relay, compiled the way the preview scheduler compiles it.
     *
     * No `fragment_output` node: `compileNodePreview`/`compileNodePreviewIR`
     * wrap the TARGET node's own output into fragColor. The pass boundary comes
     * from the relay's `textureInput` port, exactly as in the main half.
     */
    function buildPreviewGraph(scale: number | undefined) {
      const type = scale === undefined ? 'gate_pv_plain' : 'gate_pv_scaled'
      const nodes: any[] = [
        node('p0', type, scale === undefined ? {} : { testScale: scale }),
        node('p1', 'gate_pv_plain'),
      ]
      const edges: any[] = [edge('e1', 'p0', 'color', 'p1', 'source')]
      return { nodes, edges, target: 'p1' }
    }

    w.__gate = {
      async capture(req: { backend: string; anchor: string; scale?: number }) {
        try {
          const { canvas, renderer: r } = await renderer(req.backend)
          const plan = buildPlan([req.scale, req.scale === undefined ? undefined : 1], req.anchor)
          install(r, plan, req.anchor)
          const shot = grab(canvas, r)
          return {
            ok: true,
            ...shot,
            planResolutions: plan.passes.map((p: any) => p.resolution ?? null),
            passCount: plan.passes.length,
            intermediates: intermediates(r, req.backend),
          }
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e), width: 0, height: 0, b64: '', planResolutions: [], passCount: 0, intermediates: [] }
        }
      },

      /**
       * The same question, asked of the PREVIEW renderers.
       *
       * These are a separate implementation of the same contract — separate
       * uniform upload, separate target allocation, a 4 px floor instead of 1,
       * and `u_anchor` pinned to centre — so the main half proves nothing about
       * them. Drives the production entry point for each backend:
       * `renderMultiPassPreview` (GLSL) and `renderWGSLPreview` (WGSL); the
       * WebGPU renderer's `renderMultiPassPreview` is a warn-and-return-null
       * stub for interface compliance and is deliberately NOT used.
       */
      async previewCapture(req: { backend: string; scale?: number }) {
        const fail = (error: string) => ({ ok: false, error, width: 0, height: 0, b64: '', planResolutions: [], passCount: 0, intermediates: [] })
        try {
          const { renderer: r } = await previewRenderer(req.backend)
          const g = buildPreviewGraph(req.scale)
          let bitmap: ImageBitmap | null = null
          let planResolutions: Array<number | null> = []
          let passCount = 0
          let allocated: string[] = []

          if (req.backend === 'webgpu') {
            const res = compileNodePreviewIR(g.nodes, g.edges, g.target)
            if (!res.success) return fail(`preview IR compile: ${JSON.stringify(res.errors)}`)
            planResolutions = res.wgslPasses.map((p: any) => p.resolution ?? null)
            passCount = res.wgslPasses.length
            // Per-pass user uniforms, filtered by the pass's own layout — this is
            // what deserializeWGSLPasses() in preview-scheduler.ts does.
            const passes = res.wgslPasses.map((p: any) => ({
              shaderCode: p.shaderCode,
              uniformLayout: p.uniformLayout,
              textureBindings: p.textureBindings,
              inputTextures: p.inputTextures,
              userUniforms: res.userUniforms
                .filter((u: any) => p.uniformLayout.offsets.has(u.name))
                .map((u: any) => ({ name: u.name, value: u.value })),
              resolution: p.resolution,
            }))
            // The WebGPU preview's intermediates are per-CALL locals, destroyed
            // before the promise resolves (renderMultiPassWGSL), so unlike
            // WebGL2's persistent `passFBOs` there is no pool left to read.
            // Recording createTexture during the call is the only way to see the
            // size it really allocated — and without that this gate would pass
            // vacuously on a preview that ignored `resolution` outright.
            const sizes: string[] = []
            const origCreate = w.GPUDevice.prototype.createTexture
            w.GPUDevice.prototype.createTexture = function (desc: any) {
              const s = desc?.size
              if (Array.isArray(s)) sizes.push(`${s[0]}x${s[1]}`)
              else if (s) sizes.push(`${s.width}x${s.height}`)
              return origCreate.call(this, desc)
            }
            try {
              bitmap = await r.renderWGSLPreview(passes)
            } finally {
              w.GPUDevice.prototype.createTexture = origCreate
            }
            allocated = sizes
          } else {
            const res = compileNodePreview(g.nodes, g.edges, g.target)
            if (!res.success) return fail(`preview GLSL compile: ${JSON.stringify(res.errors)}`)
            planResolutions = res.passes.map((p: any) => p.resolution ?? null)
            passCount = res.passes.length
            const passes = res.passes.map((p: any) => ({
              fragmentShader: p.fragmentShader,
              uniforms: p.userUniforms.map((u: any) => ({ name: u.name, value: u.value })),
              inputTextures: p.inputTextures,
              resolution: p.resolution,
            }))
            bitmap = await r.renderMultiPassPreview(passes)
            // Persistent pool, read straight from the renderer's own state — the
            // same private-field read `intermediates()` does for the main half.
            allocated = (r.passFBOs ?? []).map((f: any) => `${f.width}x${f.height}`)
          }

          if (!bitmap) return fail('the preview renderer returned no bitmap')
          const shot = drawToShot(bitmap, bitmap.width, bitmap.height)
          bitmap.close?.()
          return { ok: true, ...shot, planResolutions, passCount, intermediates: allocated }
        } catch (e: any) {
          return fail(String(e?.message ?? e))
        }
      },

      async thrash(req: { backend: string; frames: number }) {
        try {
          // Count real allocations. WebGL2's texImage2D lives on
          // WebGL2RenderingContext.prototype (NOT the WebGL1 prototype — patching
          // that one would silently count nothing and the gate would pass
          // vacuously), and WebGPU's on GPUDevice.prototype.
          const restore: Array<() => void> = []
          w.__alloc = 0
          const hook = (obj: any, key: string) => {
            if (!obj?.prototype?.[key]) return false
            const orig = obj.prototype[key]
            obj.prototype[key] = function (...a: unknown[]) {
              w.__alloc++
              return orig.apply(this, a)
            }
            restore.push(() => { obj.prototype[key] = orig })
            return true
          }
          const hooked = req.backend === 'webgpu'
            ? hook(w.GPUDevice, 'createTexture')
            : hook(w.WebGL2RenderingContext, 'texImage2D')
          if (!hooked) throw new Error(`no allocation hook available for ${req.backend}`)

          // Fresh renderer: the pool must be built under the hook, so the
          // during-setup count proves the hook actually intercepts.
          if (open[req.backend]) {
            open[req.backend].renderer.dispose()
            open[req.backend].canvas.remove()
            delete open[req.backend]
          }
          const { canvas, renderer: r } = await renderer(req.backend)
          // Mixed scales on purpose: one width/height comparison mis-fires only
          // when the passes disagree, which is the recorded bug.
          const plan = buildPlan([0.5, 0.25, undefined], 'center')
          install(r, plan, 'center')
          for (let i = 0; i < 10; i++) r.render()
          const duringSetup = w.__alloc
          w.__alloc = 0
          for (let i = 0; i < req.frames; i++) r.render()
          const afterWarmup = w.__alloc

          // Read from the pool, not from the plan: the assertion downstream is
          // "the RENDERER really held differently-sized targets", which is what
          // makes a single width/height comparison wrong in the first place.
          const sizes = intermediates(r, req.backend)
          for (const f of restore) f()
          // Leave a clean renderer behind for any later capture.
          r.dispose()
          canvas.remove()
          delete open[req.backend]
          return { ok: true, duringSetup, afterWarmup, sizes }
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e), duringSetup: -1, afterWarmup: -1, sizes: [] }
        }
      },
    }

    // ---- availability ----------------------------------------------------
    let webgpu = false
    try {
      const gpu = (navigator as any).gpu
      if (gpu) webgpu = !!(await gpu.requestAdapter())
    } catch { webgpu = false }
    let webgl2 = false
    try {
      webgl2 = !!document.createElement('canvas').getContext('webgl2')
    } catch { webgl2 = false }
    return { webgpu, webgl2 }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, cfg)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface EnginePinRow {
  backend: Backend
  anchor: string
  scale: number
  base: Centroid
  scaled: Centroid
  planResolutions: Array<number | null>
  passCount: number
  /** What the renderer allocated for the scaled pass, e.g. ['64x64']. */
  intermediates: string[]
  /** How many bytes differ, baseline vs scaled. 0 = we compared a render to itself. */
  diffVsBase: number
}

interface PreviewRow {
  backend: Backend
  base: Centroid
  scaled: Centroid
  /** Per-pass scales the PREVIEW compile carried. */
  planResolutions: Array<number | null>
  passCount: number
  /** What the preview renderer allocated for its intermediate, e.g. ['40x40']. */
  intermediates: string[]
  /** Bytes differing, unscaled thumbnail vs scaled. 0 = compared to itself. */
  diffVsBase: number
  /** Thumbnail edge that came back — must be PREVIEW_SIZE on both backends. */
  width: number
  height: number
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  const engineRows: EnginePinRow[] = []
  const engineIdentity: Array<{ backend: Backend; diff: number; weight: number }> = []
  const engineThrash: Array<{ backend: Backend } & ThrashRes> = []
  const previewRows: PreviewRow[] = []
  const engineBase = new Map<string, Centroid>()
  const rigRows: Array<{ backend: Backend; anchor: string; scale: number; base: Centroid; scaled: Centroid }> = []
  const rigIdentity: Array<{ backend: Backend; diff: number }> = []
  const rigVsEngine: Array<{ backend: Backend; anchor: string; rig: Centroid; engine: Centroid }> = []
  let engineBackends: Backend[] = []
  let rigBackends: Backend[] = []
  let setupError: string | undefined

  try {
    // --- engine half: real src/ modules, no app -------------------------
    // The project's own vite.config.ts, because src/nodes/index.ts imports
    // React components through the `@/` alias — the harness needs the same
    // resolution the app gets, not a stripped-down one.
    server = await createServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      logLevel: 'error',
      server: { port: 0, host: '127.0.0.1' },
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite dev server did not report a local URL')
    // e.g. http://127.0.0.1:5199/sombra/ → origin + base
    const base = new URL(url).pathname.endsWith('/') ? new URL(url).pathname : `${new URL(url).pathname}/`
    const origin = new URL(url).origin

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu'],
    })
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } })
    page.on('pageerror', (e) => console.error('  [page error]', e.message))
    // tsx compiles this file with esbuild's keepNames, which wraps named
    // functions in `__name(...)`. Playwright ships the callback's SOURCE to the
    // page, where that helper does not exist — so provide it.
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    // A blank document on the Vite origin: dynamic imports of src/… resolve,
    // and the editor never boots (no second GPUDevice, no compiler worker).
    await page.route('**/__gate.html', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>pass-resolution gate</title>' }))
    await page.goto(`${origin}${base}__gate.html`)

    const avail = await installHarness(page, {
      size: SIZE, inset: INSET, offset: OFFSET, sigma: SIGMA,
      previewSize: PREVIEW_SIZE, previewOffset: PREVIEW_OFFSET, previewSigma: PREVIEW_SIGMA,
      base,
    })
    engineBackends = (['webgpu', 'webgl2'] as const).filter((b) => avail[b])
    console.log(`  engine backends: ${engineBackends.join(', ') || '(none)'}`)

    for (const backend of engineBackends) {
      // Baseline (scale 1 declared) + each scale, per anchor.
      for (const anchor of ANCHORS) {
        const base = await page.evaluate((r) => (window as never as { __gate: { capture(r: CaptureReq): Promise<CaptureRes> } }).__gate.capture(r), { backend, anchor, scale: 1 } as CaptureReq)
        if (!base.ok) throw new Error(`engine ${backend} ${anchor} baseline: ${base.error}`)
        const baseFrame = toFrame(base)
        const baseC = centroid(baseFrame)
        engineBase.set(`${backend}/${anchor}`, baseC)
        savePng(`engine-${backend}-anchor-${anchor}-full.png`, baseFrame)

        for (const scale of SCALES) {
          const shot = await page.evaluate((r) => (window as never as { __gate: { capture(r: CaptureReq): Promise<CaptureRes> } }).__gate.capture(r), { backend, anchor, scale } as CaptureReq)
          if (!shot.ok) throw new Error(`engine ${backend} ${anchor} @${scale}: ${shot.error}`)
          const frame = toFrame(shot)
          if (scale === 0.25) savePng(`engine-${backend}-anchor-${anchor}-scaled.png`, frame)
          engineRows.push({
            backend, anchor, scale,
            base: baseC,
            scaled: centroid(frame),
            planResolutions: shot.planResolutions,
            passCount: shot.passCount,
            intermediates: shot.intermediates,
            diffVsBase: countByteDiffs(baseFrame, frame),
          })
        }
        console.log(`  engine ${backend} ${anchor}: ok`)
      }

      // Scale-1 identity: a declared 1 vs no declaration at all.
      const declared = await page.evaluate((r) => (window as never as { __gate: { capture(r: CaptureReq): Promise<CaptureRes> } }).__gate.capture(r), { backend, anchor: 'center', scale: 1 } as CaptureReq)
      const undeclared = await page.evaluate((r) => (window as never as { __gate: { capture(r: CaptureReq): Promise<CaptureRes> } }).__gate.capture(r), { backend, anchor: 'center' } as CaptureReq)
      if (!declared.ok || !undeclared.ok) throw new Error(`engine ${backend} identity: ${declared.error ?? undeclared.error}`)
      const a = toFrame(declared)
      const b = toFrame(undeclared)
      engineIdentity.push({ backend, diff: maxByteDiff(a, b), weight: centroid(a).weight })

      // Preview agreement (spec gate 6). Before the thrash probe, which disposes
      // the main renderer — the WebGPU preview borrows its GPUDevice.
      const pvCall = (scale?: number) => page.evaluate(
        (r) => (window as never as { __gate: { previewCapture(r: { backend: string; scale?: number }): Promise<PreviewCaptureRes> } }).__gate.previewCapture(r),
        { backend, scale } as { backend: string; scale?: number })
      const pvBase = await pvCall(undefined)
      if (!pvBase.ok) throw new Error(`preview ${backend} baseline: ${pvBase.error}`)
      const pvScaled = await pvCall(PREVIEW_SCALE)
      if (!pvScaled.ok) throw new Error(`preview ${backend} @${PREVIEW_SCALE}: ${pvScaled.error}`)
      const pvBaseFrame = toFrame(pvBase)
      const pvScaledFrame = toFrame(pvScaled)
      savePng(`preview-${backend}-full.png`, pvBaseFrame)
      savePng(`preview-${backend}-scaled.png`, pvScaledFrame)
      previewRows.push({
        backend,
        base: centroid(pvBaseFrame),
        scaled: centroid(pvScaledFrame),
        planResolutions: pvScaled.planResolutions,
        passCount: pvScaled.passCount,
        intermediates: pvScaled.intermediates,
        diffVsBase: countByteDiffs(pvBaseFrame, pvScaledFrame),
        width: pvScaled.width,
        height: pvScaled.height,
      })
      console.log(`  preview ${backend}: intermediates=${pvScaled.intermediates.join(',') || '(none)'} diff=${countByteDiffs(pvBaseFrame, pvScaledFrame)}`)

      // Pool thrash, last: it hooks prototypes and disposes the renderer.
      const th = await page.evaluate((r) => (window as never as { __gate: { thrash(r: { backend: string; frames: number }): Promise<ThrashRes> } }).__gate.thrash(r), { backend, frames: 60 })
      engineThrash.push({ backend, ...th })
      console.log(`  engine ${backend} thrash: setup=${th.duringSetup} after=${th.afterWarmup} sizes=${th.sizes.join(',')}`)
    }
  } catch (e) {
    setupError = e instanceof Error ? e.message : String(e)
  } finally {
    await browser?.close()
    await server?.close()
  }

  // --- rig half: an independent implementation of per-pass scaling -------
  if (!setupError) {
    const rig = await createRig()
    try {
      rigBackends = (['webgpu', 'webgl2'] as const).filter((b) => rig.available[b])
      console.log(`  rig backends: ${rigBackends.join(', ') || '(none)'}`)
      for (const backend of rigBackends) {
        for (const anchor of ANCHORS) {
          const body = rigProbeBody(anchorToVec2(anchor), backend)
          const full = await rig.capture({ backend, width: SIZE, height: SIZE, passes: [{ body }, { body: RIG_PASSTHROUGH }] })
          const baseC = centroid(full)
          for (const scale of SCALES) {
            const scaled = await rig.capture({ backend, width: SIZE, height: SIZE, passes: [{ body, scale }, { body: RIG_PASSTHROUGH }] })
            rigRows.push({ backend, anchor, scale, base: baseC, scaled: centroid(scaled) })
          }
          const eng = engineBase.get(`${backend}/${anchor}`)
          if (eng) rigVsEngine.push({ backend, anchor, rig: baseC, engine: eng })
        }
        // scale 1 vs no scale, in the rig
        const body = rigProbeBody(anchorToVec2('center'), backend)
        const noScale = await rig.capture({ backend, width: SIZE, height: SIZE, passes: [{ body }, { body: RIG_PASSTHROUGH }] })
        const one = await rig.capture({ backend, width: SIZE, height: SIZE, passes: [{ body, scale: 1 }, { body: RIG_PASSTHROUGH }] })
        rigIdentity.push({ backend, diff: maxByteDiff(noScale, one) })
        console.log(`  rig ${backend}: ok`)
      }
    } finally {
      await rig.close()
    }
  }

  // -----------------------------------------------------------------------
  // Gates
  // -----------------------------------------------------------------------

  test('harness reached both halves without error', () => {
    assert(!setupError, `setup failed: ${setupError}`)
  })

  // A run that exercises no backend proved nothing. Fail, do not skip.
  test('at least one GPU backend was exercised (engine)', () => {
    assert(engineBackends.length > 0,
      'no WebGPU and no WebGL2 in the engine harness — this gate proved NOTHING, so it fails rather than reading green')
  })
  test('at least one GPU backend was exercised (rig)', () => {
    assert(rigBackends.length > 0,
      'no WebGPU and no WebGL2 in the rig — this gate proved NOTHING, so it fails rather than reading green')
  })

  // Self-test of the measure itself: a gate whose instrument is insensitive is
  // not a gate. Shift a synthetic blob by exactly 1 px and require the centroid
  // to follow it, and require a MEAN not to (the trap this measure avoids).
  test('centroid measure tracks a 1 px shift (and a mean does not)', () => {
    const make = (dx: number): Frame => {
      const data = new Uint8ClampedArray(SIZE * SIZE * 4)
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const d = Math.hypot(x - (128 + dx), y - 128) / SIGMA
          const v = Math.round(255 * Math.exp(-0.5 * d * d))
          const i = (y * SIZE + x) * 4
          data[i] = data[i + 1] = data[i + 2] = v
          data[i + 3] = 255
        }
      }
      return { width: SIZE, height: SIZE, data }
    }
    const a = centroid(make(0))
    const b = centroid(make(1))
    assert(Math.abs(b.cx - a.cx - 1) < 0.05, `centroid moved ${(b.cx - a.cx).toFixed(4)} px for a 1 px shift`)
    const mean = (f: Frame) => { let s = 0; for (let i = 0; i < f.data.length; i += 4) s += f.data[i]; return s / (f.width * f.height) }
    assert(Math.abs(mean(make(0)) - mean(make(1))) < 0.05,
      'the mean DID move — pick a different demonstration; the point is that a mean is blind to a shift')
  })

  // --- Gate 1: pinning, in the ENGINE ------------------------------------
  for (const row of engineRows) {
    const tag = `engine/${row.backend} anchor ${row.anchor} @scale ${row.scale}`
    test(`${tag}: a scaled pass does not move the anchored content`, () => {
      assert(row.base.weight > 0 && row.base.max > 32,
        `baseline frame is blank (max ${row.base.max}) — nothing was measured`)
      assert(row.scaled.weight > 0 && row.scaled.max > 32,
        `scaled frame is blank (max ${row.scaled.max}) — the scaled pass produced nothing`)
      assert(row.passCount >= 2, `expected a multi-pass plan, got ${row.passCount} pass(es)`)
      assert(row.planResolutions[0] === row.scale,
        `pass 0 should carry resolution ${row.scale}, plan says ${JSON.stringify(row.planResolutions)}`)
      // The two anti-vacuity checks. Without them this gate passes with flying
      // colours when `resolution` is ignored outright: the scaled render would
      // then BE the baseline render, byte for byte, and every position metric
      // would agree perfectly — the "clean numbers while comparing a shader to
      // itself" trap.
      const want = `${Math.round(SIZE * row.scale)}x${Math.round(SIZE * row.scale)}`
      assert(row.intermediates[0] === want,
        `the renderer allocated ${JSON.stringify(row.intermediates)} for a scale of ${row.scale} — expected ${want}, so the scale was not applied`)
      assert(row.diffVsBase > 0,
        'the scaled render is byte-identical to the full-resolution one — this comparison is a shader against itself, not a test')
      const dx = Math.abs(row.scaled.cx - row.base.cx)
      const dy = Math.abs(row.scaled.cy - row.base.cy)
      assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
        `centroid moved (${dx.toFixed(3)}, ${dy.toFixed(3)}) px — content must not move when a pass is rescaled`)
    })
  }

  // The relative check above would also pass if BOTH renders were wrong in the
  // same way, so pin the baseline to the analytic answer too.
  for (const backend of engineBackends) {
    for (const anchor of ANCHORS) {
      const c = engineBase.get(`${backend}/${anchor}`)
      test(`engine/${backend} anchor ${anchor}: blob lands where the anchor formula says`, () => {
        assert(!!c, 'no baseline capture')
        const p = predictedCentre(anchorToVec2(anchor))
        const dx = Math.abs(c!.cx - p.cx)
        const dy = Math.abs(c!.cy - p.cy)
        assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
          `centroid (${c!.cx.toFixed(2)}, ${c!.cy.toFixed(2)}) vs predicted (${p.cx}, ${p.cy}) — off by (${dx.toFixed(3)}, ${dy.toFixed(3)}) px`)
      })
    }
  }

  if (engineBackends.length === 2) {
    for (const anchor of ANCHORS) {
      test(`engine anchor ${anchor}: WebGPU and WebGL2 agree on where it lands`, () => {
        const a = engineBase.get(`webgpu/${anchor}`)!
        const b = engineBase.get(`webgl2/${anchor}`)!
        const dx = Math.abs(a.cx - b.cx)
        const dy = Math.abs(a.cy - b.cy)
        assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
          `backends disagree by (${dx.toFixed(3)}, ${dy.toFixed(3)}) px`)
      })
    }
  }

  // --- Gate 2: scale-1 identity, in the ENGINE ---------------------------
  for (const e of engineIdentity) {
    test(`engine/${e.backend}: a declared scale of 1 is byte-identical to no scale`, () => {
      assert(e.weight > 0, 'both frames were blank — nothing was compared')
      assert(e.diff === 0, `differed by ${e.diff} codes — the no-op path is not a no-op`)
    })
  }

  // --- Gate 3: pool thrash, in the ENGINE --------------------------------
  for (const t of engineThrash) {
    test(`engine/${t.backend}: a mixed-scale plan allocates nothing after warmup`, () => {
      assert(t.ok, `thrash probe failed: ${t.error}`)
      // `t.sizes` is the pool itself — intermediates only, the final pass draws
      // to the canvas — so every entry must be counted, not all-but-one.
      assert(new Set(t.sizes).size > 1,
        `the pool was not mixed-scale (${t.sizes.join(', ')}) — the single-comparison bug cannot show up`)
      // If the hook counted nothing during setup it is not intercepting, and a
      // zero afterwards would mean nothing at all.
      assert(t.duringSetup > 0,
        'the allocation hook counted 0 during setup — it is not intercepting, so a 0 afterwards proves nothing')
      assert(t.afterWarmup === 0,
        `${t.afterWarmup} allocations across 60 frames — the pool is being recreated per frame`)
    })
  }

  // --- Gate 4: preview agreement (spec gate 6) ---------------------------
  // A run that exercised no preview backend proved nothing about previews, so it
  // fails rather than reading green — same rule as the engine and rig halves.
  test('at least one preview backend was exercised', () => {
    assert(previewRows.length > 0,
      'no preview backend was driven — the preview half of the resolution contract is UNVERIFIED, so this fails rather than reading green')
  })
  for (const row of previewRows) {
    test(`preview/${row.backend}: a scaled pass does not move the thumbnail's content`, () => {
      assert(row.base.weight > 0 && row.base.max > 32,
        `unscaled thumbnail is blank (max ${row.base.max}) — nothing was measured`)
      assert(row.scaled.weight > 0 && row.scaled.max > 32,
        `scaled thumbnail is blank (max ${row.scaled.max}) — the scaled pass produced nothing`)
      assert(row.width === PREVIEW_SIZE && row.height === PREVIEW_SIZE,
        `thumbnail came back ${row.width}x${row.height}, not ${PREVIEW_SIZE}x${PREVIEW_SIZE} — the FINAL pass must stay pinned to the readback target`)
      assert(row.passCount >= 2, `expected a multi-pass preview, got ${row.passCount} pass(es)`)
      assert(row.planResolutions[0] === PREVIEW_SCALE,
        `preview pass 0 should carry resolution ${PREVIEW_SCALE}, compile says ${JSON.stringify(row.planResolutions)}`)
      // THE anti-vacuity check. A preview that ignored `resolution` outright
      // would render both thumbnails identically and sail through every position
      // metric below; only the allocated size tells the two apart.
      const want = `${Math.round(PREVIEW_SIZE * PREVIEW_SCALE)}x${Math.round(PREVIEW_SIZE * PREVIEW_SCALE)}`
      assert(row.intermediates[0] === want,
        `the preview renderer allocated ${JSON.stringify(row.intermediates)} for a scale of ${PREVIEW_SCALE} — expected ${want}, so the scale was not applied`)
      assert(row.diffVsBase > 0,
        'the scaled thumbnail is byte-identical to the unscaled one — this comparison is a shader against itself, not a test')
      const dx = Math.abs(row.scaled.cx - row.base.cx)
      const dy = Math.abs(row.scaled.cy - row.base.cy)
      assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
        `thumbnail centroid moved (${dx.toFixed(3)}, ${dy.toFixed(3)}) px — the preview's anchor must not move when a pass is rescaled`)
    })
    // The comparison above would also pass if BOTH thumbnails were wrong in the
    // same way, so pin the unscaled one to the analytic answer as well — the
    // same second check the engine half makes.
    test(`preview/${row.backend}: the blob lands where the preview's centre anchor says`, () => {
      const p = predictedPreviewCentre()
      const dx = Math.abs(row.base.cx - p.cx)
      const dy = Math.abs(row.base.cy - p.cy)
      assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
        `centroid (${row.base.cx.toFixed(2)}, ${row.base.cy.toFixed(2)}) vs predicted (${p.cx}, ${p.cy}) — off by (${dx.toFixed(3)}, ${dy.toFixed(3)}) px`)
    })
  }

  // --- Gate 1/2 in the RIG, plus rig↔engine agreement --------------------
  for (const row of rigRows) {
    test(`rig/${row.backend} anchor ${row.anchor} @scale ${row.scale}: scaled pass does not move content`, () => {
      assert(row.base.weight > 0 && row.base.max > 32, `baseline blank (max ${row.base.max})`)
      assert(row.scaled.weight > 0 && row.scaled.max > 32, `scaled blank (max ${row.scaled.max})`)
      const dx = Math.abs(row.scaled.cx - row.base.cx)
      const dy = Math.abs(row.scaled.cy - row.base.cy)
      assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
        `centroid moved (${dx.toFixed(3)}, ${dy.toFixed(3)}) px`)
    })
  }
  for (const r of rigIdentity) {
    test(`rig/${r.backend}: scale 1 is byte-identical to no scale`, () => {
      assert(r.diff === 0, `differed by ${r.diff} codes`)
    })
  }
  for (const p of rigVsEngine) {
    test(`rig/${p.backend} anchor ${p.anchor}: the engine agrees with the independent rig`, () => {
      const dx = Math.abs(p.rig.cx - p.engine.cx)
      const dy = Math.abs(p.rig.cy - p.engine.cy)
      assert(dx < PIN_TOL_PX && dy < PIN_TOL_PX,
        `rig (${p.rig.cx.toFixed(2)}, ${p.rig.cy.toFixed(2)}) vs engine (${p.engine.cx.toFixed(2)}, ${p.engine.cy.toFixed(2)}) — apart by (${dx.toFixed(3)}, ${dy.toFixed(3)}) px`)
    })
  }

  // Print the worst numbers a PASSING run produced, so the margin against
  // PIN_TOL_PX is visible rather than implied.
  const worst = (rows: Array<{ backend: Backend; base: Centroid; scaled: Centroid }>, label: string) => {
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const mine = rows.filter((r) => r.backend === backend)
      if (!mine.length) continue
      const d = Math.max(...mine.map((r) =>
        Math.max(Math.abs(r.scaled.cx - r.base.cx), Math.abs(r.scaled.cy - r.base.cy))))
      console.log(`  worst centroid drift, ${label}/${backend}: ${d.toFixed(4)} px (tolerance ${PIN_TOL_PX})`)
    }
  }
  worst(engineRows, 'engine')
  worst(rigRows, 'rig')
  // The drift above is expected to be exactly 0: the probe is a symmetric blob,
  // and a symmetric pattern's centroid is fixed by its symmetry whatever the
  // sampling grid. So also print numbers that are NOT zero by construction —
  // where the blob actually sits, and how much the scaled frame really differs —
  // otherwise a run of zeroes is indistinguishable from a degenerate one.
  for (const backend of engineBackends) {
    const off = Math.max(...ANCHORS.map((a) => {
      const c = engineBase.get(`${backend}/${a}`)!
      const p = predictedCentre(anchorToVec2(a))
      return Math.max(Math.abs(c.cx - p.cx), Math.abs(c.cy - p.cy))
    }))
    const rows = engineRows.filter((r) => r.backend === backend)
    const minDiff = Math.min(...rows.map((r) => r.diffVsBase))
    const tl = engineBase.get(`${backend}/tl`)!
    console.log(`  engine/${backend}: anchor tl centroid (${tl.cx.toFixed(3)}, ${tl.cy.toFixed(3)}) vs predicted (${predictedCentre([0, 0]).cx}, ${predictedCentre([0, 0]).cy}); worst anchor offset ${off.toFixed(4)} px; smallest scaled-vs-full differing-byte count ${minDiff}`)
  }
  for (const row of previewRows) {
    console.log(`  preview/${row.backend}: centroid full (${row.base.cx.toFixed(3)}, ${row.base.cy.toFixed(3)}) vs scaled (${row.scaled.cx.toFixed(3)}, ${row.scaled.cy.toFixed(3)}); intermediate ${row.intermediates.join(',')}; ${row.diffVsBase} differing bytes`)
  }
  if (rigVsEngine.length) {
    const d = Math.max(...rigVsEngine.map((p) =>
      Math.max(Math.abs(p.rig.cx - p.engine.cx), Math.abs(p.rig.cy - p.engine.cy))))
    console.log(`  worst rig↔engine disagreement: ${d.toFixed(4)} px (tolerance ${PIN_TOL_PX})`)
  }
  console.log(`  captures written to ${OUT_DIR}`)
  await run('pass-resolution-gpu')
}

// Anything that throws BEFORE main()'s try — mkdirSync on an unwritable
// reports/ dir, an import failure — would otherwise surface as an unhandled
// rejection with a zero exit code, i.e. a gate failure that reads as green.
main().catch((e) => {
  console.error(`✗ pass-resolution-gpu: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(1)
})
