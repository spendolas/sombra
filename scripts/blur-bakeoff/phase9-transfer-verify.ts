/**
 * Phase 9 — adversarial TRANSFER verification of the frost bake-off winner.
 *
 * The bench emulated the frost block in its own rig. This script takes the
 * winner as it would actually be WRITTEN into src/nodes/transform/reeded-glass.ts,
 * pushes it through Sombra's real compilers (glsl-generator, ir-compiler,
 * wgsl-assembler) and then through a real Tint and a real WebGL2 driver.
 *
 * Nothing in src/ is modified: the variants are registered as clones of the real
 * node definition with only the frost block swapped, so every other line of the
 * node — SRT, lens, delta, the two-argument raw() for sampleUV — is the shipped
 * code.
 *
 * Positive controls are mandatory. A harness that cannot fail is worthless, so
 * each detector is proven against a variant that MUST be rejected.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase9-transfer-verify.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { chromium } from 'playwright-core'
import type { Node, Edge } from '@xyflow/react'

import { initializeNodeLibrary } from '../../src/nodes'
import { registerNode, _nodeRegistry } from '../../src/nodes/registry'
import { reededGlassNode } from '../../src/nodes/transform/reeded-glass'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'
import { raw } from '../../src/compiler/ir/types'
import type { IRStmt, IRContext, IRNodeOutput } from '../../src/compiler/ir/types'
import type { NodeDefinition, GLSLContext } from '../../src/nodes/types'
import { test, run, assert } from './lib/test-util'
import {
  shipped, winnerNaive, winnerSeedFixed, winnerFinal,
  winnerMechanical, winnerDynamicLoop, winnerYFlipTrap, glslBadControl,
  type FrostBlock, type FrostNames,
} from './lib/frost-transfer'

initializeNodeLibrary()

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase9')
fs.mkdirSync(OUT_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// Patched node definitions — real node, frost block swapped
// ---------------------------------------------------------------------------

type Emitter = (n: FrostNames) => FrostBlock

function namesFromIr(ctx: IRContext): FrostNames {
  const id = ctx.nodeId.replace(/-/g, '_')
  return {
    id,
    color: ctx.outputs.color,
    sampler: ctx.textureSamplers?.source ?? 'u_pass0',
    frost: `rg_frost_${id}`,
    coords: `rg_coords_${id}`,
    sampleUV: `rg_sampleUV_${id}`,
  }
}
function namesFromGlsl(ctx: GLSLContext): FrostNames {
  const id = ctx.nodeId.replace(/-/g, '_')
  return {
    id,
    color: ctx.outputs.color,
    sampler: ctx.textureSamplers?.source ?? 'u_pass0',
    frost: `rg_frost_${id}`,
    coords: `rg_coords_${id}`,
    sampleUV: `rg_sampleUV_${id}`,
  }
}

/** Identify the node's frost statement in the IR output. */
function isFrostRaw(s: IRStmt): boolean {
  return s.kind === 'raw' && typeof s.glsl === 'string' && s.glsl.includes('rg_acc_')
}

function patchedNode(type: string, emit: Emitter): NodeDefinition {
  return {
    ...reededGlassNode,
    type,
    glsl: (ctx: GLSLContext) => {
      const base = reededGlassNode.glsl!(ctx) as string
      const n = namesFromGlsl(ctx)
      const marker = `vec4 ${n.color};`
      const at = base.indexOf(marker)
      if (at < 0) return base // non-texture fallback path: nothing to swap
      return base.slice(0, at) + emit(n).glsl
    },
    ir: (ctx: IRContext): IRNodeOutput => {
      const out = reededGlassNode.ir!(ctx)
      const n = namesFromIr(ctx)
      const b = emit(n)
      return {
        ...out,
        statements: out.statements.map((s) => (isFrostRaw(s) ? raw(b.glsl, b.wgsl) : s)),
      }
    },
  }
}

const VARIANTS: Array<{ type: string; label: string; emit: Emitter; mustFail?: 'wgsl' | 'glsl'; info?: string }> = [
  { type: 'rg_ship', label: 'C0 shipped (8 sq lattice)', emit: shipped },
  { type: 'rg_naive', label: 'C3j-16 verbatim from bench (fragCoord seed)', emit: (n) => winnerNaive(n) },
  { type: 'rg_seedfix', label: 'C3j-16, rg_coords device-px seed', emit: (n) => winnerSeedFixed(n) },
  { type: 'rg_final', label: 'C3j-16, seed fix + baked dirs, 2 transcendentals', emit: (n) => winnerFinal(n) },
  { type: 'rg_yflip', label: 'CONTROL: WGSL arm writes gl_FragCoord', emit: winnerYFlipTrap },
  { type: 'rg_mech', label: 'CONTROL: single-arg raw() → textureSample', emit: (n) => winnerMechanical(n), mustFail: 'wgsl' },
  { type: 'rg_glslbad', label: 'CONTROL: WGSL builtin in the GLSL arm', emit: glslBadControl, mustFail: 'glsl' },
  { type: 'rg_dynloop', label: 'INFO: non-constant GLSL loop bound', emit: winnerDynamicLoop, info: 'glslLoopBound' },
]
for (const v of VARIANTS) registerNode(patchedNode(v.type, v.emit))

// ---------------------------------------------------------------------------
// Graphs. `frost` WIRED from a noise node is the case that makes the branch
// non-uniform; frost as a plain param is the case the repo already covers.
// ---------------------------------------------------------------------------
const n = (id: string, t: string, p: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: t, params: p } }) as unknown as Node
const e = (id: string, s: string, sh: string, tg: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: tg, targetHandle: th }) as unknown as Edge

function graph(type: string, wireFrost: boolean) {
  const nodes = [n('src', 'checkerboard'), n('fx', type, { frost: 0.5 }), n('out', 'fragment_output')]
  const edges = [
    e('e1', 'src', 'color', 'fx', 'source'),
    e('e2', 'fx', 'color', 'out', 'color'),
  ]
  if (wireFrost) {
    nodes.push(n('nz', 'noise'))
    edges.push(e('e3', 'nz', 'value', 'fx', 'frost'))
  }
  return { nodes, edges }
}

interface Shader { label: string; wgsl: string; glslFrag: string; glslVert: string }
const shaders: Shader[] = []
const codegen: Record<string, unknown> = {}

for (const v of VARIANTS) {
  for (const wired of [false, true]) {
    const g = graph(v.type, wired)
    const plan = compileGraph(g.nodes as never, g.edges as never)
    const ir = compileGraphIR(g.nodes as never, g.edges as never)
    const tag = `${v.type}${wired ? ' [frost WIRED]' : ' [frost param]'}`
    if (!plan.success) { codegen[`${tag}/glslCompileError`] = plan.errors; continue }
    if (!ir) { codegen[`${tag}/irNull`] = true; continue }
    assert(plan.passes.length === ir.passes.length, `${tag}: pass count mismatch`)
    // The effect pass is the one that samples the previous pass.
    for (let i = 0; i < ir.passes.length; i++) {
      if (!ir.passes[i].shaderCode.includes('rg_acc_')) continue
      shaders.push({
        label: `${tag} pass${i}`,
        wgsl: ir.passes[i].shaderCode,
        glslFrag: plan.passes[i].fragmentShader,
        glslVert: plan.passes[i].vertexShader,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Static (no-GPU) transfer checks
// ---------------------------------------------------------------------------
function frostSlice(src: string): string {
  const a = src.indexOf('rg_frad_')
  const b = src.indexOf('rg_aacc_', src.lastIndexOf('rg_acc_'))
  return a < 0 ? '' : src.slice(a, b > a ? b + 400 : src.length)
}
function shaderFor(label: string): Shader {
  const s = shaders.find((x) => x.label.startsWith(label))
  if (!s) throw new Error(`no shader for ${label}`)
  return s
}

// ---------------------------------------------------------------------------
// GPU compile
// ---------------------------------------------------------------------------
interface CompileResult { label: string; wgslErrors: string[]; glslErrors: string[]; pipelineErrors: string[] }

async function gpuCompile(_list: Shader[]): Promise<{ supported: boolean; out: CompileResult[]; probes: Record<string, string> }> {
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>t</title>') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu'] })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/`)
  const res = await page.evaluate(async (input: Shader[]) => {
    const gpu = (navigator as unknown as { gpu?: GPU }).gpu
    const out: CompileResult[] = []
    const probes: Record<string, string> = {}
    if (!gpu) return { supported: false, out, probes }
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { supported: false, out, probes }
    const device = await adapter.requestDevice()

    // --- WGSL language probes (do the defensive constructs actually matter?) --
    const probeList: Array<[string, string]> = [
      ['scalar_minus_vec2f', '  var t = vec2f(0.3, 0.4);\n  t = 1.0 - abs(fract(t * 0.5) * 2.0 - 1.0);\n  return vec4f(t, 0.0, 1.0);'],
      ['vec3f_div_scalar', '  var a = vec3f(1.0, 2.0, 3.0);\n  return vec4f(a / max(0.5, 1e-5), 1.0);'],
      ['exp_literal_1e-5', '  return vec4f(1e-5, 0.0, 0.0, 1.0);'],
      ['int_literal_16_loop', '  var s = 0.0;\n  for (var i: i32 = 0; i < 16; i++) { s = s + f32(i); }\n  return vec4f(s, 0.0, 0.0, 1.0);'],
    ]
    for (const pr of probeList) {
      const code = `@fragment fn fs() -> @location(0) vec4f {\n${pr[1]}\n}`
      const pinfo = await device.createShaderModule({ code }).getCompilationInfo()
      probes[pr[0]] = pinfo.messages.filter((m) => m.type === 'error').map((m) => m.message).join(' | ') || 'OK'
    }

    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 64
    const gl = canvas.getContext('webgl2')

    for (const s of input) {
      const info = await device.createShaderModule({ code: s.wgsl }).getCompilationInfo()
      const wgslErrors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}: ${m.message}`)

      // Pipeline creation on the (possibly invalid) module, under an error scope.
      const pipelineErrors: string[] = []
      if (wgslErrors.length === 0) {
        device.pushErrorScope('validation')
        try {
          const mod = device.createShaderModule({ code: s.wgsl })
          device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: mod, entryPoint: 'vs_main', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }] }] },
            fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' as GPUTextureFormat }] },
            primitive: { topology: 'triangle-list' },
          })
        } catch (err) { pipelineErrors.push(String(err)) }
        const scoped = await device.popErrorScope()
        if (scoped) pipelineErrors.push(scoped.message)
      }

      // GLSL ES 3.00 via a real WebGL2 driver.
      const glslErrors: string[] = []
      if (gl) {
        const vs = gl.createShader(gl.VERTEX_SHADER)!
        gl.shaderSource(vs, s.glslVert); gl.compileShader(vs)
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) glslErrors.push('VS: ' + (gl.getShaderInfoLog(vs) ?? ''))
        const fs = gl.createShader(gl.FRAGMENT_SHADER)!
        gl.shaderSource(fs, s.glslFrag); gl.compileShader(fs)
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) glslErrors.push('FS: ' + (gl.getShaderInfoLog(fs) ?? ''))
        if (glslErrors.length === 0) {
          const p = gl.createProgram()!
          gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p)
          if (!gl.getProgramParameter(p, gl.LINK_STATUS)) glslErrors.push('LINK: ' + (gl.getProgramInfoLog(p) ?? ''))
          gl.deleteProgram(p)
        }
        gl.deleteShader(vs); gl.deleteShader(fs)
      } else {
        glslErrors.push('no webgl2 context')
      }
      out.push({ label: s.label, wgslErrors, glslErrors, pipelineErrors })
    }
    device.destroy()
    return { supported: true, out, probes }
  }, shaders)
  await browser.close(); server.close()
  return res
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`compiled ${shaders.length} effect-pass shaders from ${VARIANTS.length} variants x2 graphs`)

  // ---- static checks ------------------------------------------------------
  const shipWired = shaderFor('rg_ship [frost WIRED]')
  const finalWired = shaderFor('rg_final [frost WIRED]')
  const naiveWired = shaderFor('rg_naive [frost WIRED]')
  const yflipWired = shaderFor('rg_yflip [frost WIRED]')
  const mechWired = shaderFor('rg_mech [frost WIRED]')

  test('harness reproduces the shipped frost block (whitespace-normalised)', () => {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
    const real = compileGraphIR(graph('reeded_glass', true).nodes as never, graph('reeded_glass', true).edges as never)
    const realPass = real!.passes.find((p) => p.shaderCode.includes('rg_acc_'))!
    // node ids differ only by the variant type name, not by variable names
    assert(norm(frostSlice(realPass.shaderCode)) === norm(frostSlice(shipWired.wgsl)),
      'shipped-clone WGSL differs from the real node:\nREAL: ' + frostSlice(realPass.shaderCode).slice(0, 300) +
      '\nCLONE: ' + frostSlice(shipWired.wgsl).slice(0, 300))
  })

  test('CONTROL: single-arg raw() really does emit textureSample (mechanical path)', () => {
    assert(/\btextureSample\(/.test(mechWired.wgsl) && !/textureSampleLevel\(\s*u_pass/.test(frostSlice(mechWired.wgsl)),
      'mechanical control did not produce textureSample — control is inert')
  })

  test('winner WGSL uses textureSampleLevel for every tap and for the else branch', () => {
    const slice = frostSlice(finalWired.wgsl)
    const plain = (slice.match(/(?<!Level)\btextureSample\(/g) ?? []).length
    const lod = (slice.match(/textureSampleLevel\(/g) ?? []).length
    assert(plain === 0, `${plain} plain textureSample calls in the winner's frost block`)
    assert(lod === 17, `expected 16 taps + 1 else = 17 textureSampleLevel calls, got ${lod}`)
  })

  test('the assembler rewrites gl_FragCoord inside a hand-written WGSL arm', () => {
    assert(!/gl_FragCoord/.test(yflipWired.wgsl), 'gl_FragCoord survived into WGSL — rewrite assumption wrong')
    assert(/floor\(in\.position\.xy\)/.test(yflipWired.wgsl),
      'y-flip control did not become in.position — the trap is not reproducible')
  })

  test('fragCoord-seeded winner: the two backends seed from OPPOSITE y origins', () => {
    assert(/floor\(gl_FragCoord\.xy\)/.test(naiveWired.glslFrag), 'GLSL arm lost its fragCoord seed')
    assert(/floor\(in\.position\.xy\)/.test(naiveWired.wgsl), 'WGSL arm lost its position seed')
    // gl_FragCoord.y counts from the BOTTOM, in.position.y from the TOP.
    assert(/u_resolution\.y - gl_FragCoord\.y/.test(naiveWired.glslFrag),
      'the node itself no longer flips y — recheck the premise')
  })

  test('coords-seeded winner is byte-identical in seed expression across backends', () => {
    const g = finalWired.glslFrag.match(/floor\(rg_coords_\w+ \* \(u_dpr \* u_ref_size\)\)/)?.[0]
    const w = finalWired.wgsl.match(/floor\(rg_coords_\w+ \* \(uniforms\.u_dpr \* uniforms\.u_ref_size\)\)/)?.[0]
    assert(!!g && !!w, `seed expression missing (glsl=${g}, wgsl=${w})`)
  })

  test('alpha divisor matches the tap count in every arm of the winner', () => {
    for (const s of [finalWired.glslFrag, finalWired.wgsl, naiveWired.glslFrag, naiveWired.wgsl]) {
      const m = s.match(/rg_aacc_\w+ \/ (\d+)\.0/)
      assert(!!m && m[1] === '16', `alpha divisor is ${m?.[1]}, expected 16 (repo rule: measured alpha, mean over taps)`)
    }
  })

  test('winner never writes a synthesised alpha (premultiplied accumulate preserved)', () => {
    const slice = frostSlice(finalWired.wgsl)
    assert(/rg_acc_\w+ \+ rg_s\d+_\w+\.rgb \* rg_s\d+_\w+\.a/.test(slice), 'premultiplied accumulation missing')
    assert(!/vec4f\([^)]*, 1\.0\);/.test(slice.split('rg_aacc_').slice(-1)[0] ?? ''), 'alpha forced to 1')
  })

  test('mirror-fold retained on every tap', () => {
    const folds = (frostSlice(finalWired.wgsl).match(/vec2f\(1\.0\) - abs\(fract\(/g) ?? []).length
    assert(folds === 16, `expected 16 mirror folds, got ${folds}`)
  })

  test('GLSL loop bound (naive variant) is a compile-time integer literal', () => {
    assert(/for \(int rg_i_\w+ = 0; rg_i_\w+ < 16; rg_i_\w+\+\+\)/.test(naiveWired.glslFrag),
      'loop bound is not a literal')
  })

  // ---- GPU ---------------------------------------------------------------
  const res = await gpuCompile(shaders)
  if (!res.supported) { console.log('WebGPU unavailable — GPU half skipped'); await run('phase9 transfer (static only)'); return }

  console.log('\nWGSL language probes:')
  for (const [k, v] of Object.entries(res.probes)) console.log(`  ${k}: ${v}`)

  const by = new Map(res.out.map((r) => [r.label, r]))
  for (const v of VARIANTS) {
    for (const wired of [false, true]) {
      const label = [...by.keys()].find((k) => k.startsWith(`${v.type}${wired ? ' [frost WIRED]' : ' [frost param]'}`))
      if (!label) continue
      const r = by.get(label)!
      const expectWgslFail = v.mustFail === 'wgsl' && wired
      const expectGlslFail = v.mustFail === 'glsl'
      if (v.info) {
        codegen[`${label}/${v.info}`] = r.glslErrors.length === 0 ? 'driver ACCEPTS non-constant loop bound' : r.glslErrors[0]
        console.log(`  INFO ${label}: ${codegen[`${label}/${v.info}`]}`)
        continue
      }
      test(`GPU/WGSL ${label}`, () => {
        if (expectWgslFail) assert(r.wgslErrors.length > 0, 'CONTROL DID NOT FAIL — Tint accepted textureSample under a non-uniform branch')
        else assert(r.wgslErrors.length === 0, r.wgslErrors.slice(0, 2).join(' ; '))
      })
      test(`GPU/pipeline ${label}`, () => {
        assert(r.pipelineErrors.length === 0 || expectWgslFail, r.pipelineErrors.slice(0, 1).join(' ; '))
      })
      test(`GPU/GLSL ${label}`, () => {
        if (expectGlslFail) assert(r.glslErrors.length > 0, 'CONTROL DID NOT FAIL — WebGL2 accepted a non-constant loop bound')
        else assert(r.glslErrors.length === 0, r.glslErrors.slice(0, 2).join(' ; ').slice(0, 400))
      })
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'phase9-transfer.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), probes: res.probes, results: res.out, codegen }, null, 2),
  )
  await run(`phase9 transfer verification (${res.out.length} shaders)`)
}
main()
