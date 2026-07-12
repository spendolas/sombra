/**
 * Self-validation suite — machine-checkable regression net for the classes of
 * bug found in the 2026-07-12 post-WebGPU audit (docs/audit/).
 *
 * Checks:
 *  1. matrix     — per-node codegen over the full param space (every enum value,
 *                  image loaded AND empty, inputs wired AND unwired). Both
 *                  backends generated; static uniform/binding contracts applied.
 *  2. invariants — preset/default-graph params exist on definitions, showWhen
 *                  keys resolve, input ports actually read by generators,
 *                  CSS var() references defined, doc node-counts match registry.
 *  3. fixtures   — every shaders/*.sombra|*.json imports and compiles on both paths.
 *  4. gpu        — every unique generated shader really compiled on GPU
 *                  (WGSL via WebGPU createShaderModule, GLSL via WebGL2) in
 *                  headless Chrome. Skippable with --no-gpu.
 *
 * Reports: reports/self-validate/{matrix,invariants,fixtures,gpu}.json + latest.md
 * Exit code: non-zero if any FAIL. Agents/CI read latest.md + JSONs.
 *
 * Usage: npx tsx scripts/self-validate/index.ts [--no-gpu] [--only=matrix,...]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../../src/nodes'
import { nodeRegistry } from '../../src/nodes/registry'
import type { NodeData, EdgeData, NodeDefinition } from '../../src/nodes/types'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'
import { areTypesCompatible } from '../../src/nodes/type-coercion'
import { importFromFile } from '../../src/utils/sombra-file'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REPORT_DIR = path.join(ROOT, 'reports/self-validate')

// 2x2 red PNG — exercises the loaded-image codegen branch the default ('') never reaches.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA0GAgWyZZ1nAAAAAElFTkSuQmCC'

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export interface Finding {
  check: string
  status: 'FAIL' | 'WARN'
  subject: string
  message: string
  file?: string
}

const findings: Finding[] = []
const counters: Record<string, { pass: number; fail: number; warn: number }> = {}

function tally(check: string, ok: boolean, warn = false) {
  const c = (counters[check] ??= { pass: 0, fail: 0, warn: 0 })
  if (ok) c.pass++
  else if (warn) c.warn++
  else c.fail++
}

function fail(check: string, subject: string, message: string, file?: string) {
  findings.push({ check, status: 'FAIL', subject, message, file })
  tally(check, false)
}

function warn(check: string, subject: string, message: string, file?: string) {
  findings.push({ check, status: 'WARN', subject, message, file })
  tally(check, false, true)
}

let nodeCounter = 0
const uid = () => `sv_${++nodeCounter}`

function makeNode(id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }
}

function makeEdge(source: string, target: string, sourceHandle: string, targetHandle: string, sourcePortType = 'float'): Edge<EdgeData> {
  return {
    id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
    source, target, sourceHandle, targetHandle,
    type: 'typed',
    data: { sourcePort: sourceHandle, targetPort: targetHandle, sourcePortType: sourcePortType as EdgeData['sourcePortType'] },
  }
}

/** Default params for a definition (mirrors what the editor seeds on create). */
function defaultParams(def: NodeDefinition): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  for (const param of def.params ?? []) p[param.id] = param.default
  return p
}

// ---------------------------------------------------------------------------
// 1. Param-matrix codegen validation
// ---------------------------------------------------------------------------

interface ShaderCase {
  /** stable id for reports */
  name: string
  wgsl: string[]
  glsl: string[]
}

const gpuBundle: ShaderCase[] = []

/** Cartesian product of enum params, capped; beyond cap fall back to one-at-a-time. */
function enumVariants(def: NodeDefinition, cap = 24): Array<Record<string, unknown>> {
  const enums = (def.params ?? []).filter((p) => p.type === 'enum' && Array.isArray(p.options) && p.options.length > 0)
  if (enums.length === 0) return [{}]
  const total = enums.reduce((n, p) => n * p.options!.length, 1)
  if (total <= cap) {
    let combos: Array<Record<string, unknown>> = [{}]
    for (const p of enums) {
      combos = combos.flatMap((c) => p.options!.map((o) => ({ ...c, [p.id]: typeof o === 'object' ? (o as { value: unknown }).value : o })))
    }
    return combos
  }
  // one-at-a-time from defaults
  const out: Array<Record<string, unknown>> = [{}]
  for (const p of enums) {
    for (const o of p.options!) {
      out.push({ [p.id]: typeof o === 'object' ? (o as { value: unknown }).value : o })
    }
  }
  return out
}

/** Pick a standard upstream source node type for a port type. */
function sourceFor(portType: string): { type: string; out: string } | null {
  switch (portType) {
    case 'float': return { type: 'float_constant', out: 'value' }
    case 'vec2': return { type: 'uv_transform', out: 'uv' }
    case 'vec3': case 'color': return { type: 'color_constant', out: 'color' }
    case 'sampler2D': return { type: 'noise', out: 'value' }
    default: return null
  }
}

/** GLSL contract: every used u_* identifier / texture() sampler must be declared. */
function checkGlslContract(name: string, src: string) {
  const declared = new Set<string>()
  for (const m of src.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)) declared.add(m[1])
  const used = new Set<string>()
  for (const m of src.matchAll(/\bu_[A-Za-z0-9_]+\b/g)) used.add(m[0])
  for (const u of used) {
    if (!declared.has(u)) fail('matrix', name, `GLSL uses undeclared uniform '${u}'`)
  }
  for (const m of src.matchAll(/\btexture\s*\(\s*(\w+)/g)) {
    if (!declared.has(m[1])) fail('matrix', name, `GLSL samples undeclared sampler '${m[1]}'`)
  }
}

/** WGSL contract: every used u_* identifier must be a Uniforms field or a @group var. */
function checkWgslContract(name: string, src: string) {
  const declared = new Set<string>()
  const structMatch = src.match(/struct\s+Uniforms\s*\{([\s\S]*?)\}/)
  if (structMatch) for (const m of structMatch[1].matchAll(/(\w+)\s*:/g)) declared.add(m[1])
  for (const m of src.matchAll(/@group\(\d+\)\s*@binding\(\d+\)\s*var(?:<[^>]*>)?\s+(\w+)/g)) declared.add(m[1])
  const used = new Set<string>()
  for (const m of src.matchAll(/\bu_[A-Za-z0-9_]+\b/g)) used.add(m[0])
  for (const u of used) {
    if (!declared.has(u)) fail('matrix', name, `WGSL uses undeclared binding/uniform '${u}'`)
  }
}

function runCase(name: string, nodes: Node<NodeData>[], edges: Edge<EdgeData>[]) {
  const anyFail = findings.length

  const plan = compileGraph(nodes, edges)
  if (!plan.success) {
    fail('matrix', name, `GLSL compile failed: ${plan.errors.map((e) => e.message).join('; ')}`)
  } else {
    for (const pass of plan.passes) checkGlslContract(name, pass.fragmentShader)
  }

  const ir = compileGraphIR(nodes, edges)
  if (!ir) {
    fail('matrix', name, 'IR/WGSL compile returned null')
  } else {
    for (const pass of ir.passes) checkWgslContract(name, pass.shaderCode)
  }

  if (plan.success && ir) {
    gpuBundle.push({
      name,
      glsl: plan.passes.map((p) => p.fragmentShader),
      wgsl: ir.passes.map((p) => p.shaderCode),
    })
  }
  tally('matrix', findings.length === anyFail)
}

function checkMatrix() {
  const output = nodeRegistry.get('fragment_output')!
  for (const def of nodeRegistry.getAll()) {
    if (def.type === 'fragment_output') continue
    const outPort = def.outputs[0]
    if (!outPort) continue
    const outputIn = output.inputs[0]

    let variants = enumVariants(def)
    // Image axis: exercise BOTH the empty and the loaded branch.
    if ((def.params ?? []).some((p) => p.id === 'imageData')) {
      variants = variants.flatMap((v) => [
        { ...v, imageData: '', imageName: '' },
        { ...v, imageData: TINY_PNG, imageName: 'sv.png' },
      ])
    }

    for (const variant of variants) {
      const variantLabel = Object.entries(variant)
        .map(([k, v]) => `${k}=${k === 'imageData' ? (v ? 'loaded' : 'empty') : v}`)
        .join(',') || 'defaults'

      // bare: node → output, all inputs on defaults/auto_uv
      {
        const n = makeNode(uid(), def.type, { ...defaultParams(def), ...variant })
        const o = makeNode(uid(), 'fragment_output', defaultParams(output))
        if (areTypesCompatible(outPort.type, outputIn.type)) {
          runCase(`${def.type}[${variantLabel}] bare`, [n, o], [
            makeEdge(n.id, o.id, outPort.id, outputIn.id, outPort.type),
          ])
        }
      }

      // wired: every declared input fed by a standard source (triggers texture
      // boundaries for textureInput ports and the connected-param codegen path)
      {
        const n = makeNode(uid(), def.type, { ...defaultParams(def), ...variant })
        const o = makeNode(uid(), 'fragment_output', defaultParams(output))
        const nodes = [n, o]
        const edges: Edge<EdgeData>[] = [makeEdge(n.id, o.id, outPort.id, outputIn.id, outPort.type)]
        let wiredAny = false
        for (const input of def.inputs) {
          const src = sourceFor(input.type)
          if (!src) continue
          const srcDef = nodeRegistry.get(src.type)!
          const s = makeNode(uid(), src.type, defaultParams(srcDef))
          nodes.push(s)
          edges.push(makeEdge(s.id, n.id, src.out, input.id, srcDef.outputs[0].type))
          wiredAny = true
        }
        if (wiredAny && areTypesCompatible(outPort.type, outputIn.type)) {
          runCase(`${def.type}[${variantLabel}] wired`, nodes, edges)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Static invariants
// ---------------------------------------------------------------------------

async function checkInvariants() {
  // 2a. Preset graphs reference only params/handles that exist
  const tg = await import('../../src/utils/test-graph')
  const builders = Object.entries(tg).filter(([, v]) => typeof v === 'function') as Array<[string, () => { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }]>
  for (const [fnName, build] of builders) {
    try {
      const { nodes, edges } = build()
      let ok = true
      for (const n of nodes) {
        const def = nodeRegistry.get(n.data.type)
        if (!def) { fail('invariants', `${fnName}/${n.id}`, `unknown node type '${n.data.type}'`, 'src/utils/test-graph.ts'); ok = false; continue }
        const known = new Set((def.params ?? []).map((p) => p.id))
        for (const key of Object.keys(n.data.params ?? {})) {
          if (!known.has(key)) { fail('invariants', `${fnName}/${n.id}`, `param '${key}' does not exist on '${n.data.type}' (has: ${[...known].join(', ')})`, 'src/utils/test-graph.ts'); ok = false }
        }
      }
      for (const e of edges) {
        const src = nodes.find((n) => n.id === e.source); const tgt = nodes.find((n) => n.id === e.target)
        const srcDef = src && nodeRegistry.get(src.data.type); const tgtDef = tgt && nodeRegistry.get(tgt.data.type)
        if (srcDef && e.sourceHandle && !srcDef.outputs.some((p) => p.id === e.sourceHandle)) { fail('invariants', `${fnName}/${e.id}`, `sourceHandle '${e.sourceHandle}' not on '${srcDef.type}'`, 'src/utils/test-graph.ts'); ok = false }
        if (tgtDef && e.targetHandle && !tgtDef.inputs.some((p) => p.id === e.targetHandle) && !(tgtDef.params ?? []).some((p) => p.id === e.targetHandle)) { fail('invariants', `${fnName}/${e.id}`, `targetHandle '${e.targetHandle}' not on '${tgtDef.type}'`, 'src/utils/test-graph.ts'); ok = false }
      }
      tally('invariants', ok)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // dagre CJS/ESM interop differs between vite and node — a harness limitation, not a product bug
      if (msg.includes("reading 'Graph'")) warn('invariants', fnName, `builder not runnable under node (dagre ESM interop): ${msg}`, 'src/utils/test-graph.ts')
      else fail('invariants', fnName, `builder threw: ${msg}`, 'src/utils/test-graph.ts')
    }
  }

  // 2b. showWhen keys reference existing params
  for (const def of nodeRegistry.getAll()) {
    const ids = new Set((def.params ?? []).map((p) => p.id))
    let ok = true
    for (const p of def.params ?? []) {
      for (const key of Object.keys(p.showWhen ?? {})) {
        if (!ids.has(key)) { fail('invariants', `${def.type}.${p.id}`, `showWhen references nonexistent param '${key}'`); ok = false }
      }
    }
    tally('invariants', ok)
  }

  // 2c. Every declared input port is actually read by the node's generators
  //     (spatial nodes' coords port is consumed by the SRT framework — exempt)
  const nodeFiles = walk(path.join(ROOT, 'src/nodes')).filter((f) => f.endsWith('.ts'))
  const sourceByType = new Map<string, { file: string; text: string }>()
  for (const f of nodeFiles) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/^\s*type:\s*'([a-z0-9_]+)'/gm)) {
      if (nodeRegistry.get(m[1])) sourceByType.set(m[1], { file: f, text })
    }
  }
  for (const def of nodeRegistry.getAll()) {
    const src = sourceByType.get(def.type)
    if (!src) continue
    if (def.dynamicInputs) continue // ports accessed via computed keys — not statically checkable
    let ok = true
    for (const input of def.inputs) {
      if (def.spatial && input.id === 'coords') continue // framework-consumed
      if (input.textureInput) continue // consumed by the multipass framework (texture sampling)
      const patterns = [`inputs.${input.id}`, `inputs['${input.id}']`, `inputs["${input.id}"]`, `inputs[\`${input.id}\`]`]
      if (!patterns.some((p) => src.text.includes(p))) {
        fail('invariants', `${def.type}.${input.id}`, `input port declared but never read via ctx.inputs — dead handle in UI`, path.relative(ROOT, src.file))
        ok = false
      }
    }
    tally('invariants', ok)
  }

  // 2d. CSS custom-property references resolve
  const cssDefs = new Set<string>()
  const styleSources = [path.join(ROOT, 'src/index.css'), path.join(ROOT, 'src/generated/ds.ts')]
  for (const f of styleSources) {
    if (!fs.existsSync(f)) continue
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi)) cssDefs.add(m[1])
  }
  const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => /\.(tsx?|css)$/.test(f))
  const varUses = new Map<string, string>()
  for (const f of srcFiles) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)[,)]/gi)) {
      if (!cssDefs.has(m[1])) varUses.set(m[1], path.relative(ROOT, f))
    }
  }
  for (const [v, f] of varUses) {
    // React Flow/Radix-provided vars are external — warn only for --rf/--radix prefixes
    if (/^--(xy|rf|radix|tw)-/.test(v)) continue
    fail('invariants', v, `var(${v}) referenced but never defined in index.css/ds.ts`, f)
  }
  tally('invariants', varUses.size === 0)

  // 2e. Doc node-counts match registry
  const count = nodeRegistry.getAll().length
  for (const [docFile, re] of [
    ['CLAUDE.md', /(\d+)\s+nodes\b/],
    ['BROWSER-AUTOMATION.md', /Node Types \((\d+) total\)/],
  ] as const) {
    const p = path.join(ROOT, docFile)
    if (!fs.existsSync(p)) continue
    const m = fs.readFileSync(p, 'utf8').match(re)
    if (m && Number(m[1]) !== count) {
      warn('invariants', docFile, `doc says ${m[1]} nodes, registry has ${count}`, docFile)
    } else tally('invariants', true)
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. Fixture corpus — real saved graphs must import + compile forever
// ---------------------------------------------------------------------------

function checkFixtures() {
  const dir = path.join(ROOT, 'shaders')
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sombra') || f.endsWith('.json'))
  for (const f of files) {
    const name = `fixture:${f}`
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const { nodes, edges } = importFromFile(json)
      const plan = compileGraph(nodes, edges)
      if (!plan.success) { fail('fixtures', name, `GLSL compile failed: ${plan.errors.map((e) => e.message).join('; ')}`); continue }
      for (const pass of plan.passes) checkGlslContract(name, pass.fragmentShader)
      const ir = compileGraphIR(nodes, edges)
      if (!ir) { fail('fixtures', name, 'IR/WGSL compile returned null'); continue }
      for (const pass of ir.passes) checkWgslContract(name, pass.shaderCode)
      gpuBundle.push({ name, glsl: plan.passes.map((p) => p.fragmentShader), wgsl: ir.passes.map((p) => p.shaderCode) })
      tally('fixtures', true)
    } catch (err) {
      fail('fixtures', name, `import threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. GPU validation via headless Chrome (real createShaderModule / WebGL2 compile)
// ---------------------------------------------------------------------------

async function checkGpu() {
  // dedupe shaders by hash so Chrome compiles each unique source once
  const wgslMap = new Map<string, { src: string; cases: string[] }>()
  const glslMap = new Map<string, { src: string; cases: string[] }>()
  for (const c of gpuBundle) {
    for (const s of c.wgsl) {
      const h = createHash('sha1').update(s).digest('hex')
      const e = wgslMap.get(h) ?? { src: s, cases: [] }
      e.cases.push(c.name); wgslMap.set(h, e)
    }
    for (const s of c.glsl) {
      const h = createHash('sha1').update(s).digest('hex')
      const e = glslMap.get(h) ?? { src: s, cases: [] }
      e.cases.push(c.name); glslMap.set(h, e)
    }
  }
  console.log(`  gpu: ${wgslMap.size} unique WGSL, ${glslMap.size} unique GLSL shaders`)

  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-webgpu'],
  })
  // WebGPU requires a secure context — about:blank doesn't qualify, localhost does.
  const http = await import('node:http')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>self-validate</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${port}/`)

    const wgslResults = await page.evaluate(async (shaders: Array<{ h: string; src: string }>) => {
      const out: Array<{ h: string; errors: string[] }> = []
      const gpu = (navigator as unknown as { gpu?: GPU }).gpu
      if (!gpu) return { supported: false, out }
      const adapter = await gpu.requestAdapter()
      if (!adapter) return { supported: false, out }
      const device = await adapter.requestDevice()
      for (const { h, src } of shaders) {
        const mod = device.createShaderModule({ code: src })
        const info = await mod.getCompilationInfo()
        const errors = info.messages.filter((m) => m.type === 'error').map((m) => `L${m.lineNum}: ${m.message}`)
        out.push({ h, errors })
      }
      device.destroy()
      return { supported: true, out }
    }, [...wgslMap.entries()].map(([h, e]) => ({ h, src: e.src })))

    if (!wgslResults.supported) {
      warn('gpu', 'wgsl', 'WebGPU unavailable in headless Chrome — WGSL GPU validation skipped')
    } else {
      for (const r of wgslResults.out) {
        const entry = wgslMap.get(r.h)!
        if (r.errors.length) fail('gpu', entry.cases.slice(0, 3).join(' | '), `WGSL GPU compile: ${r.errors.slice(0, 2).join(' ; ')}`)
        tally('gpu', r.errors.length === 0)
      }
    }

    const glslResults = await page.evaluate((shaders: Array<{ h: string; src: string }>) => {
      const out: Array<{ h: string; errors: string[] }> = []
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      if (!gl) return { supported: false, out }
      for (const { h, src } of shaders) {
        const sh = gl.createShader(gl.FRAGMENT_SHADER)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS)
        out.push({ h, errors: ok ? [] : [(gl.getShaderInfoLog(sh) ?? 'unknown error').slice(0, 400)] })
        gl.deleteShader(sh)
      }
      return { supported: true, out }
    }, [...glslMap.entries()].map(([h, e]) => ({ h, src: e.src })))

    if (!glslResults.supported) {
      warn('gpu', 'glsl', 'WebGL2 unavailable in headless Chrome — GLSL GPU validation skipped')
    } else {
      for (const r of glslResults.out) {
        const entry = glslMap.get(r.h)!
        if (r.errors.length) fail('gpu', entry.cases.slice(0, 3).join(' | '), `GLSL GPU compile: ${r.errors[0].split('\n').slice(0, 3).join(' ')}`)
        tally('gpu', r.errors.length === 0)
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
}

// ---------------------------------------------------------------------------
// Reports + main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const noGpu = args.includes('--no-gpu')
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',')
  const enabled = (name: string) => !only || only.includes(name)

  initializeNodeLibrary()
  fs.mkdirSync(REPORT_DIR, { recursive: true })

  if (enabled('matrix')) { console.log('▸ matrix'); checkMatrix() }
  if (enabled('invariants')) { console.log('▸ invariants'); await checkInvariants() }
  if (enabled('fixtures')) { console.log('▸ fixtures'); checkFixtures() }
  if (enabled('gpu') && !noGpu) {
    console.log('▸ gpu')
    try { await checkGpu() }
    catch (err) { warn('gpu', 'runner', `GPU runner failed: ${err instanceof Error ? err.message : String(err)}`) }
  }

  // per-check JSON
  for (const check of ['matrix', 'invariants', 'fixtures', 'gpu']) {
    fs.writeFileSync(
      path.join(REPORT_DIR, `${check}.json`),
      JSON.stringify({ generated: new Date().toISOString(), counters: counters[check] ?? { pass: 0, fail: 0, warn: 0 }, findings: findings.filter((f) => f.check === check) }, null, 2),
    )
  }

  // latest.md summary
  const failCount = findings.filter((f) => f.status === 'FAIL').length
  const warnCount = findings.filter((f) => f.status === 'WARN').length
  const lines = [
    `# Self-validation report — ${new Date().toISOString()}`,
    '',
    `**${failCount} FAIL / ${warnCount} WARN**`,
    '',
    '| check | pass | fail | warn |',
    '|---|---|---|---|',
    ...Object.entries(counters).map(([k, c]) => `| ${k} | ${c.pass} | ${c.fail} | ${c.warn} |`),
    '',
  ]
  const byCheck = new Map<string, Finding[]>()
  for (const f of findings) {
    const arr = byCheck.get(f.check) ?? []
    arr.push(f); byCheck.set(f.check, arr)
  }
  for (const [check, list] of byCheck) {
    lines.push(`## ${check}`, '')
    // dedupe identical messages across many cases
    const grouped = new Map<string, { subjects: string[]; f: Finding }>()
    for (const f of list) {
      const key = `${f.status}:${f.message}:${f.file ?? ''}`
      const g = grouped.get(key) ?? { subjects: [], f }
      g.subjects.push(f.subject); grouped.set(key, g)
    }
    for (const { subjects, f } of grouped.values()) {
      const subj = subjects.length > 4 ? `${subjects.slice(0, 4).join(', ')} (+${subjects.length - 4} more)` : subjects.join(', ')
      lines.push(`- **${f.status}** \`${subj}\` — ${f.message}${f.file ? ` _(${f.file})_` : ''}`)
    }
    lines.push('')
  }
  fs.writeFileSync(path.join(REPORT_DIR, 'latest.md'), lines.join('\n'))

  console.log(`\n${failCount} FAIL / ${warnCount} WARN — reports in reports/self-validate/`)
  process.exit(failCount > 0 ? 1 : 0)
}

main()
