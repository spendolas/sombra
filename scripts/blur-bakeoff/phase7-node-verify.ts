/**
 * Phase 7 — does the real node, compiled by Sombra's own compiler, agree with
 * the research rig?
 *
 * Everything up to now was measured in a purpose-built rig. That proves the
 * algorithms, not the engine. This builds the graph
 *
 *     Image -> Blur(Horizontal) -> Blur(Vertical) -> Fragment Output
 *
 * runs it through the ACTUAL compiler, takes the RenderPlan's generated shaders
 * verbatim, executes them on the GPU, and compares the result against both the
 * rig's own separable blur and the CPU ground truth.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase7-node-verify.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
import { createRig } from './lib/gpu-rig'
import { ingestPass, egressPass, linearSampledGaussPass } from './lib/shaders'
import { decodeToLinear, encodeToSrgb8, type Rgba8 } from './lib/image'
import { gaussianBlur } from './lib/reference'
import { hfNoise, transparentEdgeSprite, stepEdge } from './lib/corpus'
import { encodePng } from './lib/png'

const OUT_DIR = path.join('reports', 'blur-bakeoff')
const IMG_DIR = path.join(OUT_DIR, 'phase7')

const RADIUS = 24
/** The node uses sigma = radius/3; the rig and CPU reference take sigma. */
const SIGMA = RADIUS / 3
const SIZE = 256

function graph(): { nodes: Node[]; edges: Edge[] } {
  // ONE blur node — the compiler expands it into its two passes.
  const nodes = [
    { id: 'img', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params: { imageData: '', fitMode: 'cover' } } },
    { id: 'bl', type: 'shaderNode', position: { x: 200, y: 0 }, data: { type: 'blur', params: { radius: RADIUS } } },
    { id: 'out', type: 'shaderNode', position: { x: 400, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ] as unknown as Node[]
  const edges = [
    { id: 'e1', source: 'img', sourceHandle: 'color', target: 'bl', targetHandle: 'source' },
    { id: 'e2', source: 'bl', sourceHandle: 'color', target: 'out', targetHandle: 'color' },
  ] as unknown as Edge[]
  return { nodes, edges }
}

function save(name: string, img: Rgba8): void {
  fs.mkdirSync(IMG_DIR, { recursive: true })
  fs.writeFileSync(path.join(IMG_DIR, `${name}.png`), encodePng(img))
}
/**
 * Compare RGB, skipping pixels that are essentially transparent: premultiplied
 * storage genuinely discards colour where alpha approaches 0, so un-premultiplying
 * there amplifies rounding into meaningless differences.
 */
function stats(a: Rgba8, b: Rgba8): { mean: number; max: number } {
  let s = 0, n = 0, m = 0
  for (let p = 0; p < a.width * a.height; p++) {
    if (Math.min(a.data[p * 4 + 3], b.data[p * 4 + 3]) < 24) continue
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])
      s += d; n++; if (d > m) m = d
    }
  }
  return { mean: n ? s / n : 0, max: m }
}

async function main() {
  initializeNodeLibrary()
  const { nodes, edges } = graph()

  const plan = compileGraph(nodes, edges)
  const ir = compileGraphIR(nodes, edges)

  const summary = {
    glsl: {
      passes: plan.passes.length,
      errors: plan.errors ?? [],
      inputTextures: plan.passes.map((p) => p.inputTextures),
      tapsPerPass: plan.passes.map((p) => (p.fragmentShader.match(/texture\(/g) ?? []).length),
      filters: plan.passes.map((p) => p.textureFilter ?? 'linear'),
    },
    wgsl: {
      passes: ir.passes.length,
      errors: ir.errors ?? [],
      tapsPerPass: ir.passes.map((p) => (p.shaderCode.match(/textureSample\(/g) ?? []).length),
    },
  }
  console.log(JSON.stringify(summary, null, 2))

  fs.mkdirSync(OUT_DIR, { recursive: true })
  // Dump the real generated shaders so the rig run can execute them verbatim.
  const dump = {
    radius: RADIUS,
    glslPasses: plan.passes.map((p) => ({
      index: p.index,
      fragmentShader: p.fragmentShader,
      vertexShader: p.vertexShader,
      inputTextures: p.inputTextures,
      textureFilter: p.textureFilter ?? 'linear',
      userUniforms: p.userUniforms,
    })),
    wgslPasses: ir.passes.map((p, i) => ({ index: i, shaderCode: p.shaderCode })),
  }
  fs.writeFileSync(path.join(OUT_DIR, 'phase7-plan.json'), JSON.stringify(dump, null, 2))
  console.log(`\nwrote ${path.join(OUT_DIR, 'phase7-plan.json')}`)

  // A quick structural check while we are here.
  const problems: string[] = []
  if (plan.passes.length !== 3) problems.push(`expected 3 GLSL passes (image, blurH, blurV), got ${plan.passes.length}`)
  if (ir.passes.length !== 3) problems.push(`expected 3 WGSL passes, got ${ir.passes.length}`)
  if ((plan.errors ?? []).length) problems.push(`GLSL errors: ${JSON.stringify(plan.errors)}`)
  if ((ir.errors ?? []).length) problems.push(`WGSL errors: ${JSON.stringify(ir.errors)}`)
  for (const p of plan.passes) {
    if (/\btexture\(\s*,/.test(p.fragmentShader)) problems.push(`pass ${p.index}: empty sampler name`)
  }
  if (problems.length) {
    console.error('\nPROBLEMS:\n' + problems.map((s) => '  - ' + s).join('\n'))
    process.exit(1)
  }
  console.log('\nstructure OK')

  // ---- numeric check: run the ENGINE's own shaders -----------------------
  // Passes 1 and 2 are the blur; pass 0 is the image node, which we replace with
  // a stimulus bound directly as the first pass's input texture.
  const enginePasses = plan.passes.slice(1).map((p, i) => ({
    fragmentShader: p.fragmentShader,
    vertexShader: p.vertexShader,
    sampler: `u_pass${i}_tex`,
    userUniforms: p.userUniforms,
  }))

  /**
   * The engine's final pass writes PREMULTIPLIED colour, because the canvas is
   * configured with premultiplied alpha. The rig's egress emits straight alpha,
   * so undo it before comparing. A no-op on opaque content.
   */
  const unpremul = (img: Rgba8): Rgba8 => {
    const out: Rgba8 = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
    for (let p = 0; p < img.width * img.height; p++) {
      const a = img.data[p * 4 + 3] / 255
      if (a <= 0) continue
      for (let c = 0; c < 3; c++) out.data[p * 4 + c] = Math.round(Math.min(255, img.data[p * 4 + c] / a))
    }
    return out
  }

  const rig = await createRig()
  const rows: Array<Record<string, unknown>> = []
  try {
    for (const [name, src] of [
      ['noise', hfNoise(SIZE, SIZE, 5)],
      ['edge', stepEdge(SIZE, SIZE)],
      ['sprite', transparentEdgeSprite(SIZE, SIZE)],
    ] as Array<[string, Rgba8]>) {
      const engineRaw = await rig.captureRawGlsl({ width: SIZE, height: SIZE, input: src, passes: enginePasses })
      const engine = unpremul(engineRaw)
      const rigOut = await rig.capture({
        backend: 'webgl2', width: SIZE, height: SIZE, input: src,
        passes: [
          ingestPass('webgl2'),
          linearSampledGaussPass('webgl2', SIGMA, 'h'),
          linearSampledGaussPass('webgl2', SIGMA, 'v'),
          egressPass('webgl2', { dither: true }),
        ],
      })
      const ref = encodeToSrgb8(gaussianBlur(decodeToLinear(src), SIGMA, { premultiplied: true }))

      const vsRig = stats(engine, rigOut)
      const vsRef = stats(engine, ref)
      const rigVsRef = stats(rigOut, ref)
      rows.push({
        stimulus: name,
        engine_vs_rig_mean: +vsRig.mean.toFixed(3), engine_vs_rig_max: vsRig.max,
        engine_vs_reference_mean: +vsRef.mean.toFixed(3), engine_vs_reference_max: vsRef.max,
        rig_vs_reference_mean: +rigVsRef.mean.toFixed(3), rig_vs_reference_max: rigVsRef.max,
      })
      const mn=(x:Rgba8)=>{let s=0;for(let p=0;p<x.width*x.height;p++)s+=x.data[p*4];return (s/(x.width*x.height)).toFixed(1)};console.log(`  ${name}: means engine=${mn(engine)} rig=${mn(rigOut)} ref=${mn(ref)} | engine↔rig ${vsRig.mean.toFixed(3)}/${vsRig.max} | engine↔ref ${vsRef.mean.toFixed(3)}/${vsRef.max} | rig↔ref ${rigVsRef.mean.toFixed(3)}/${rigVsRef.max}`)
      save(`${name}-engine`, engine)
      save(`${name}-rig`, rigOut)
      save(`${name}-reference`, ref)
    }
  } finally {
    await rig.close()
  }

  fs.writeFileSync(path.join(OUT_DIR, 'phase7.json'), JSON.stringify({ radius: RADIUS, sigma: SIGMA, rows }, null, 2))

  // Gate on the CPU ground truth, not on the rig. On the transparent-edge sprite
  // the rig is itself the one that drifts (rig vs reference 1.9 codes): it stores
  // linear premultiplied values in an 8-bit intermediate, which crushes the tiny
  // values near an alpha edge, whereas the node stores straight-alpha sRGB and
  // lands closer to the truth. Comparing the two implementations against each
  // other would have flagged the more accurate one.
  const bad = rows.filter((r) => (r.engine_vs_reference_mean as number) > 1.0)
  if (bad.length) {
    console.error(`\nENGINE DIVERGES FROM GROUND TRUTH: ${JSON.stringify(bad)}`)
    process.exit(1)
  }
  console.log('\nengine output matches the CPU ground truth on every stimulus')
}

main()
