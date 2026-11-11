/**
 * Comprehensive WGSL validation — builds every possible multi-pass graph
 * combination and validates the WGSL compiles without errors.
 *
 * Tests:
 * - Every textureInput node in multi-pass mode
 * - Every noise type through each multi-pass node
 * - FBM through each multi-pass node
 * - Single-pass baseline for every node
 */

import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import { compileGraphIR } from '../src/compiler/ir-compiler'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'

initializeNodeLibrary()

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let nodeCounter = 0
function uid(): string { return `test_${++nodeCounter}` }

function makeNode(id: string, type: string, params: Record<string, unknown> = {}, x = 0, y = 0): Node<NodeData> {
  return { id, type: 'shaderNode', position: { x, y }, data: { type, params } }
}

function makeEdge(source: string, target: string, sourceHandle: string, targetHandle: string): Edge<EdgeData> {
  return {
    id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
    source, target, sourceHandle, targetHandle,
    type: 'typed',
    data: { sourcePort: sourceHandle, targetPort: targetHandle, sourcePortType: 'float' },
  }
}

// WGSL structural validator — check for common GLSL artifacts
const WGSL_ISSUES: Array<{ pattern: RegExp; msg: string }> = [
  { pattern: /\bvec2\(/, msg: 'vec2( should be vec2f(' },
  { pattern: /\bvec3\(/, msg: 'vec3( should be vec3f(' },
  { pattern: /\bvec4\(/, msg: 'vec4( should be vec4f(' },
  { pattern: /(?<!\w)float\s+\w/, msg: '"float x" should be "var x: f32"' },
  { pattern: /(?<!\w)int\s+\w/, msg: '"int x" should be "var x: i32"' },
  { pattern: /[^/]\?[^?].*:(?!:)/, msg: 'Possible GLSL ternary (? :) — should be select()' },
  { pattern: /\btexture\s*\(/, msg: 'texture( should be textureSample(' },
  { pattern: /\bmod\s*\(/, msg: 'mod( should be sombra_mod(' },
]

interface TestResult {
  name: string
  glslOk: boolean
  wgslOk: boolean
  wgslPassCount: number
  errors: string[]
  warnings: string[]
}

function validateWGSL(wgslCode: string): string[] {
  const issues: string[] = []
  const lines = wgslCode.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip comments
    if (line.trimStart().startsWith('//')) continue
    for (const check of WGSL_ISSUES) {
      if (check.pattern.test(line)) {
        issues.push(`Line ${i + 1}: ${check.msg} → "${line.trim()}"`)
      }
    }
  }
  return issues
}

function runTest(name: string, nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): TestResult {
  const result: TestResult = { name, glslOk: false, wgslOk: false, wgslPassCount: 0, errors: [], warnings: [] }

  // GLSL compile
  const glsl = compileGraph(nodes, edges)
  if (!glsl.success) {
    result.errors.push(`GLSL compile failed: ${glsl.errors.map(e => e.message).join('; ')}`)
    return result
  }
  result.glslOk = true

  // IR/WGSL compile
  const wgsl = compileGraphIR(nodes, edges)
  if (!wgsl) {
    result.errors.push('IR compilation returned null')
    return result
  }

  result.wgslPassCount = wgsl.passes.length

  // Validate each pass's WGSL
  for (let i = 0; i < wgsl.passes.length; i++) {
    const pass = wgsl.passes[i]
    const issues = validateWGSL(pass.shaderCode)
    for (const issue of issues) {
      result.errors.push(`Pass ${i}: ${issue}`)
    }
  }

  result.wgslOk = result.errors.length === 0
  return result
}

// ---------------------------------------------------------------------------
// Graph builders
// ---------------------------------------------------------------------------

/** Simple single-pass: Source → Output */
function singlePassGraph(sourceType: string, sourceParams: Record<string, unknown> = {}): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const srcId = uid()
  const outId = uid()
  return {
    nodes: [
      makeNode(srcId, sourceType, sourceParams),
      makeNode(outId, 'fragment_output'),
    ],
    edges: [
      makeEdge(srcId, outId, 'value', 'color'),
    ],
  }
}

/** Multi-pass: Source → TextureNode(source=textureInput) → Output */
function multiPassGraph(
  sourceType: string,
  sourceParams: Record<string, unknown>,
  textureNodeType: string,
  textureNodeParams: Record<string, unknown> = {},
): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const srcId = uid()
  const texNodeId = uid()
  const outId = uid()

  // Source feeds a color ramp to produce vec3 output
  const rampId = uid()
  const nodes: Node<NodeData>[] = [
    makeNode(srcId, sourceType, sourceParams),
    makeNode(rampId, 'color_ramp'),
    makeNode(texNodeId, textureNodeType, textureNodeParams),
    makeNode(outId, 'fragment_output'),
  ]

  const edges: Edge<EdgeData>[] = [
    // Source → Color Ramp (float → vec3)
    makeEdge(srcId, rampId, 'value', 'value'),
    // Color Ramp → Texture Node's source (textureInput)
    makeEdge(rampId, texNodeId, 'color', 'source'),
    // Texture Node → Output
    makeEdge(texNodeId, outId, 'color', 'color'),
  ]

  return { nodes, edges }
}

/** Multi-pass with FBM as source */
function multiPassFBMGraph(
  noiseType: string,
  textureNodeType: string,
  textureNodeParams: Record<string, unknown> = {},
): { nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] } {
  const fbmId = uid()
  const rampId = uid()
  const texNodeId = uid()
  const outId = uid()

  return {
    nodes: [
      makeNode(fbmId, 'fbm', { noiseType, octaves: 4 }),
      makeNode(rampId, 'color_ramp'),
      makeNode(texNodeId, textureNodeType, textureNodeParams),
      makeNode(outId, 'fragment_output'),
    ],
    edges: [
      makeEdge(fbmId, rampId, 'value', 'value'),
      makeEdge(rampId, texNodeId, 'color', 'source'),
      makeEdge(texNodeId, outId, 'color', 'color'),
    ],
  }
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

const NOISE_TYPES = ['simplex', 'value', 'worley', 'worley_fast', 'worley2d', 'box']

const TEXTURE_NODES: Array<{ type: string; params?: Record<string, unknown>; label: string }> = [
  { type: 'warp', params: { edge: 'clamp' }, label: 'Warp (clamp)' },
  { type: 'warp', params: { edge: 'repeat' }, label: 'Warp (repeat)' },
  { type: 'warp', params: { edge: 'mirror' }, label: 'Warp (mirror)' },
  { type: 'pixelate', label: 'Pixelate' },
  { type: 'tile', params: { mirror: 'none' }, label: 'Tile (none)' },
  { type: 'tile', params: { mirror: 'x' }, label: 'Tile (mirror x)' },
  { type: 'tile', params: { mirror: 'y' }, label: 'Tile (mirror y)' },
  { type: 'tile', params: { mirror: 'xy' }, label: 'Tile (mirror xy)' },
  { type: 'polar_coords', params: { mode: 'inverse' }, label: 'Polar (inverse)' },
  { type: 'polar_coords', params: { mode: 'forward' }, label: 'Polar (forward)' },
  { type: 'reeded_glass', params: { frost: 0.0 }, label: 'Reeded Glass (no frost)' },
  { type: 'reeded_glass', params: { frost: 0.5 }, label: 'Reeded Glass (frost)' },
]

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

const results: TestResult[] = []
let totalTests = 0
let passed = 0
let failed = 0

console.log('=== WGSL Multi-Pass Validation ===\n')

// 1. Single-pass baseline — every noise type
console.log('--- Single-pass noise baseline ---')
for (const noiseType of NOISE_TYPES) {
  const graph = singlePassGraph('noise', { noiseType })
  const r = runTest(`Noise(${noiseType}) single-pass`, graph.nodes, graph.edges)
  results.push(r)
  totalTests++
  if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
  else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
}

// 2. Single-pass FBM — every noise type
console.log('\n--- Single-pass FBM baseline ---')
for (const noiseType of NOISE_TYPES) {
  const fbmId = uid()
  const outId = uid()
  const graph = {
    nodes: [makeNode(fbmId, 'fbm', { noiseType, octaves: 4 }), makeNode(outId, 'fragment_output')],
    edges: [makeEdge(fbmId, outId, 'value', 'color')],
  }
  const r = runTest(`FBM(${noiseType}) single-pass`, graph.nodes, graph.edges)
  results.push(r)
  totalTests++
  if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
  else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
}

// 3. Multi-pass: every noise type × every texture node
console.log('\n--- Multi-pass: Noise → TextureNode ---')
for (const texNode of TEXTURE_NODES) {
  for (const noiseType of NOISE_TYPES) {
    const graph = multiPassGraph('noise', { noiseType }, texNode.type, texNode.params)
    const r = runTest(`Noise(${noiseType}) → ${texNode.label}`, graph.nodes, graph.edges)
    results.push(r)
    totalTests++
    if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name} [${r.wgslPassCount} passes]`) }
    else { failed++; console.log(`  ✗ ${r.name} [${r.wgslPassCount} passes]`); r.errors.forEach(e => console.log(`    ${e}`)) }
  }
}

// 4. Multi-pass: FBM × every texture node
console.log('\n--- Multi-pass: FBM → TextureNode ---')
for (const texNode of TEXTURE_NODES) {
  for (const noiseType of NOISE_TYPES) {
    const graph = multiPassFBMGraph(noiseType, texNode.type, texNode.params)
    const r = runTest(`FBM(${noiseType}) → ${texNode.label}`, graph.nodes, graph.edges)
    results.push(r)
    totalTests++
    if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name} [${r.wgslPassCount} passes]`) }
    else { failed++; console.log(`  ✗ ${r.name} [${r.wgslPassCount} passes]`); r.errors.forEach(e => console.log(`    ${e}`)) }
  }
}

// 4b. Stack — not reachable through TEXTURE_NODES: its texture ports are
// per-layer (`layer_<id>`, from dynamicInputs), never `source`, and its chain
// port is wired by the expansion. Every blend mode in both blend spaces, plus
// the hidden / none / nested shapes, with the pass count each must produce.
console.log('\n--- Stack (every blend mode × blend space, hidden / none / nested) ---')
{
  const { BLEND_MODES } = await import('../src/nodes/shared/blend-modes')
  const layer = (id: string, blendMode: string, visible = true) => ({ id, name: id, blendMode, visible })
  const stackCase = (label: string, layers: Array<ReturnType<typeof layer>>, space: string, expectPasses: number, nest = false) => {
    const outId = uid()
    const stkId = uid()
    const nodes: Node<NodeData>[] = [makeNode(stkId, 'stack', { layers, blendSpace: space }), makeNode(outId, 'fragment_output')]
    const edges: Edge<EdgeData>[] = []
    layers.forEach((l, i) => {
      const nz = uid(), ramp = uid()
      nodes.push(makeNode(nz, 'noise', { noiseType: NOISE_TYPES[i % NOISE_TYPES.length] }), makeNode(ramp, 'color_ramp'))
      edges.push(makeEdge(nz, ramp, 'value', 'value'), makeEdge(ramp, stkId, 'color', `layer_${l.id}`))
    })
    let top = stkId
    if (nest) {
      const outer = uid(), dots = uid()
      nodes.push(makeNode(outer, 'stack', { layers: [layer('x', 'normal'), layer('y', 'overlay')], blendSpace: space }), makeNode(dots, 'dots'))
      edges.push(makeEdge(stkId, outer, 'color', 'layer_x'), makeEdge(dots, outer, 'color', 'layer_y'))
      top = outer
    }
    edges.push(makeEdge(top, outId, 'color', 'color'))
    const r = runTest(label, nodes, edges)
    if (r.wgslOk && r.wgslPassCount !== expectPasses) {
      r.wgslOk = false
      r.errors.push(`expected ${expectPasses} passes, got ${r.wgslPassCount}`)
    }
    results.push(r)
    totalTests++
    if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name} [${r.wgslPassCount} passes]`) }
    else { failed++; console.log(`  ✗ ${r.name} [${r.wgslPassCount} passes]`); r.errors.forEach(e => console.log(`    ${e}`)) }
  }
  for (const space of ['srgb', 'linear']) {
    for (const m of BLEND_MODES) stackCase(`Stack ${m.id} [${space}]`, [layer('a', 'normal'), layer('b', m.id)], space, 4)
  }
  stackCase('Stack 3 layers, middle hidden', [layer('a', 'normal'), layer('b', 'screen', false), layer('c', 'hue')], 'linear', 4)
  stackCase('Stack, every layer hidden', [layer('a', 'normal', false), layer('b', 'screen', false)], 'srgb', 1)
  stackCase('Stack nested in a Stack', [layer('a', 'normal'), layer('b', 'multiply')], 'srgb', 7, true)
}

// 5. Image node single-pass
console.log('\n--- Image node ---')
{
  const imgId = uid()
  const outId = uid()
  const graph = {
    nodes: [
      makeNode(imgId, 'image', { imageData: '', fitMode: 'cover' }),
      makeNode(outId, 'fragment_output'),
    ],
    edges: [makeEdge(imgId, outId, 'color', 'color')],
  }
  const r = runTest('Image (no data)', graph.nodes, graph.edges)
  results.push(r)
  totalTests++
  if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
  else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
}

// 6. Pixel Grid + Bayer (uses mod in bayer8x8 function)
console.log('\n--- Post-process nodes ---')
{
  const noiseId = uid()
  const rampId = uid()
  const gridId = uid()
  const outId = uid()
  const graph = {
    nodes: [
      makeNode(noiseId, 'noise', { noiseType: 'simplex' }),
      makeNode(rampId, 'color_ramp'),
      makeNode(gridId, 'dither', { shape: 'circle', pixelSize: 8 }),
      makeNode(outId, 'fragment_output'),
    ],
    edges: [
      makeEdge(noiseId, rampId, 'value', 'value'),
      makeEdge(rampId, gridId, 'color', 'color'),
      makeEdge(gridId, outId, 'result', 'color'),
    ],
  }
  const r = runTest('Pixel Grid (circle)', graph.nodes, graph.edges)
  results.push(r)
  totalTests++
  if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
  else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
}

// 7. Checkerboard (uses mod via IR call)
{
  const cbId = uid()
  const outId = uid()
  const graph = {
    nodes: [makeNode(cbId, 'checkerboard'), makeNode(outId, 'fragment_output')],
    edges: [makeEdge(cbId, outId, 'value', 'color')],
  }
  const r = runTest('Checkerboard (mod via IR call)', graph.nodes, graph.edges)
  results.push(r)
  totalTests++
  if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
  else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
}

// 8. Ramp stops as uniforms (SR-2) — Color Ramp and Gradient, 2/4/8 stops,
// same-position pair, alpha < 1, every interpolation, single- and multi-pass.
// Beyond the structural scan: every stop uniform must be DECLARED by the pass
// that reads it on both backends (GLSL `uniform vec4`, WGSL Uniforms struct
// field + `uniforms.` access) and uploaded with the stop's RGBA value.
console.log('\n--- Ramp stops as uniforms (SR-2) ---')
{
  const stopSets: Record<string, Array<{ position: number; color: number[] }>> = {
    two: [{ position: 0, color: [0.1, 0.2, 0.3] }, { position: 1, color: [0.9, 0.8, 0.7, 0.5] }],
    four: [{ position: 0.75, color: [0.5, 0.6, 0.7, 0.25] }, { position: 0, color: [0, 0, 0, 1] }, { position: 0.5, color: [1, 0, 0, 0] }, { position: 0.25, color: [0, 1, 0, 0.5] }],
    eight: Array.from({ length: 8 }, (_, k) => ({ position: ((k * 3) % 8) / 7, color: [k / 8, 1 - k / 8, 0.5, 0.1 + k / 10] })),
    samepos: [{ position: 0, color: [0, 0, 0, 1] }, { position: 0.5, color: [1, 0, 0, 1] }, { position: 0.5, color: [0, 0, 1, 0.3] }, { position: 1, color: [1, 1, 1, 1] }],
  }
  for (const nodeType of ['color_ramp', 'gradient']) {
    for (const [setName, stops] of Object.entries(stopSets)) {
      for (const interp of ['smooth', 'linear', 'constant']) {
        for (const multi of [false, true]) {
          const srcId = uid(), rampId = uid(), blurId = uid(), outId = uid()
          const nodes: Node<NodeData>[] = []
          const edges: Edge<EdgeData>[] = []
          if (nodeType === 'color_ramp') {
            nodes.push(makeNode(srcId, 'noise', { noiseType: 'value' }), makeNode(rampId, 'color_ramp', { interpolation: interp, stops }))
            edges.push(makeEdge(srcId, rampId, 'value', 't'))
          } else {
            nodes.push(makeNode(rampId, 'gradient', { gradientType: 'angular', interpolation: interp, stops }))
          }
          if (multi) {
            nodes.push(makeNode(blurId, 'blur'))
            edges.push(makeEdge(rampId, blurId, 'color', 'source'), makeEdge(blurId, outId, 'color', 'color'))
          } else {
            edges.push(makeEdge(rampId, outId, 'color', 'color'))
          }
          nodes.push(makeNode(outId, 'fragment_output'))
          const r = runTest(`${nodeType} ${setName} ${interp}${multi ? ' → blur (multi-pass)' : ''}`, nodes, edges)
          if (r.glslOk) {
            const sid = rampId.replace(/-/g, '_')
            const glsl = compileGraph(nodes, edges)
            const wgsl = compileGraphIR(nodes, edges)!
            const names = stops.map((_, k) => `u_${sid}_stop_s${k}`)
            const glslPass = glsl.passes.find((p) => p.fragmentShader.includes(`node_${sid}_color`))
            const wgslPass = wgsl.passes.find((p) => p.shaderCode.includes(`node_${sid}_color`))
            if (multi && glsl.passes.length < 2) r.errors.push('expected a multi-pass plan')
            for (const [k, u] of names.entries()) {
              if (!glslPass || !new RegExp(`uniform vec4 ${u};`).test(glslPass.fragmentShader)) r.errors.push(`GLSL pass does not declare ${u}`)
              if (!wgslPass || !new RegExp(`\\b${u}\\s*:\\s*vec4f`).test(wgslPass.shaderCode) || !wgslPass.shaderCode.includes(`uniforms.${u}`)) r.errors.push(`WGSL pass does not declare/read ${u}`)
              const spec = glsl.userUniforms.find((x) => x.name === u)
              const c = stops[k].color
              const want = c.length === 4 ? c : [c[0], c[1], c[2], 1]
              if (!spec || JSON.stringify(spec.value) !== JSON.stringify(want)) r.errors.push(`${u} uploads ${JSON.stringify(spec?.value)}, want ${JSON.stringify(want)}`)
            }
            r.wgslOk = r.errors.length === 0
          }
          results.push(r)
          totalTests++
          if (r.wgslOk) { passed++; console.log(`  ✓ ${r.name}`) }
          else { failed++; console.log(`  ✗ ${r.name}`); r.errors.forEach(e => console.log(`    ${e}`)) }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed out of ${totalTests} tests`)
console.log('='.repeat(60))

if (failed > 0) {
  console.log('\nFailed tests:')
  for (const r of results) {
    if (!r.wgslOk) {
      console.log(`\n  ✗ ${r.name}`)
      for (const e of r.errors) console.log(`    ${e}`)
    }
  }
  process.exit(1)
}
