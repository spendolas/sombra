/**
 * IR Verification Script — All 41 Nodes
 *
 * For each node with an ir() function:
 * 1. Constructs realistic GLSLContext and IRContext with matching variable names
 * 2. Calls glsl(ctx) for reference GLSL output
 * 3. Calls ir(ctx) → GLSL backend for IR-lowered GLSL output
 * 4. Compares the two (normalized for whitespace) — exact match for simple nodes
 * 5. Calls ir(ctx) → WGSL backend for WGSL output
 * 6. Validates WGSL output for structural issues (no GLSL remnants)
 * 7. Tests IRFunction lowering for nodes with shared helper functions
 *
 * Run: npx tsx scripts/verify-ir-poc.ts
 *      npx tsx scripts/verify-ir-poc.ts --verbose   (show all GLSL/WGSL output)
 */

const verbose = process.argv.includes('--verbose')

// ---------------------------------------------------------------------------
// Math (8)
// ---------------------------------------------------------------------------
import { mixNode } from '../src/nodes/math/mix'
import { clampNode } from '../src/nodes/math/clamp'
import { arithmeticNode } from '../src/nodes/math/arithmetic'
import { trigNode } from '../src/nodes/math/trig'
import { remapNode } from '../src/nodes/math/remap'
import { powerNode } from '../src/nodes/math/power'
import { roundNode } from '../src/nodes/math/round'
import { smoothstepNode } from '../src/nodes/math/smoothstep'
import { turbulenceNode } from '../src/nodes/math/turbulence'
import { ridgedNode } from '../src/nodes/math/ridged'

// ---------------------------------------------------------------------------
// Color (6)
// ---------------------------------------------------------------------------
import { brightnessContrastNode } from '../src/nodes/color/brightness-contrast'
import { invertNode } from '../src/nodes/color/invert'
import { grayscaleNode } from '../src/nodes/color/grayscale'
import { posterizeNode } from '../src/nodes/color/posterize'
import { hsvToRgbNode } from '../src/nodes/color/hsv-to-rgb'
import { colorRampNode } from '../src/nodes/color/color-ramp'

// ---------------------------------------------------------------------------
// Pattern (4)
// ---------------------------------------------------------------------------
import { checkerboardNode } from '../src/nodes/pattern/checkerboard'
import { stripesNode } from '../src/nodes/pattern/stripes'
import { dotsNode } from '../src/nodes/pattern/dots'
import { gradientNode } from '../src/nodes/pattern/gradient'

// ---------------------------------------------------------------------------
// Vector (4)
// ---------------------------------------------------------------------------
import { splitVec2Node } from '../src/nodes/vector/split-vec2'
import { splitVec3Node } from '../src/nodes/vector/split-vec3'
import { combineVec2Node } from '../src/nodes/vector/combine-vec2'
import { combineVec3Node } from '../src/nodes/vector/combine-vec3'

// ---------------------------------------------------------------------------
// Input (6)
// ---------------------------------------------------------------------------
import { timeNode } from '../src/nodes/input/time'
import { uvCoordsNode } from '../src/nodes/input/uv-coords'
import { resolutionNode } from '../src/nodes/input/resolution'
import { floatConstantNode } from '../src/nodes/input/float-constant'
import { colorConstantNode } from '../src/nodes/input/color-constant'
import { vec2ConstantNode } from '../src/nodes/input/vec2-constant'
import { randomNode } from '../src/nodes/input/random'
import { imageNode } from '../src/nodes/input/image'

// ---------------------------------------------------------------------------
// Output (1)
// ---------------------------------------------------------------------------
import { fragmentOutputNode } from '../src/nodes/output/fragment-output'

// ---------------------------------------------------------------------------
// Noise (2)
// ---------------------------------------------------------------------------
import { noiseNode } from '../src/nodes/noise/noise'
import { fbmNode } from '../src/nodes/noise/fbm'

// ---------------------------------------------------------------------------
// Distort (4)
// ---------------------------------------------------------------------------
import { tileNode } from '../src/nodes/distort/tile'
import { warpNode } from '../src/nodes/distort/warp'
import { pixelateNode } from '../src/nodes/distort/pixelate'
import { polarCoordsNode } from '../src/nodes/distort/polar-coords'

// ---------------------------------------------------------------------------
// Post-process (1)
// ---------------------------------------------------------------------------
import { ditherNode } from '../src/nodes/postprocess/pixel-grid'

// ---------------------------------------------------------------------------
// Transform (1)
// ---------------------------------------------------------------------------
import { reededGlassNode } from '../src/nodes/transform/reeded-glass'

// ---------------------------------------------------------------------------
// IR backends
// ---------------------------------------------------------------------------
import { lowerNodeOutputToGLSL, lowerFunctionsToGLSL } from '../src/compiler/ir/glsl-backend'
import { lowerNodeOutputToWGSL, lowerFunctionsToWGSL } from '../src/compiler/ir/wgsl-backend'
import type { GLSLContext } from '../src/nodes/types'
import type { IRContext, IRNodeOutput } from '../src/compiler/ir/types'

// ---------------------------------------------------------------------------
// Real-codegen-path regression harness (color_constant RGBA — see bottom of file)
// ---------------------------------------------------------------------------
import { initializeNodeLibrary } from '../src/nodes'
import { generateNodeGlsl, compileGraph } from '../src/compiler/glsl-generator'
import { generateNodeIR, compileGraphIR } from '../src/compiler/ir-compiler'
import { compileNodePreview } from '../src/compiler/subgraph-compiler'
import { compileNodePreviewIR } from '../src/compiler/ir-subgraph-compiler'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, UniformSpec } from '../src/nodes/types'

initializeNodeLibrary()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function makeGLSLContext(
  overrides: Partial<GLSLContext> & Pick<GLSLContext, 'nodeId' | 'inputs' | 'outputs' | 'params'>,
): GLSLContext {
  return {
    uniforms: new Set(),
    functions: [],
    functionRegistry: new Map(),
    ...overrides,
  }
}


/** Shared context builder — creates matching GLSL + IR contexts from a single spec. */
function ctx(
  spec: IRContext & { textureSamplers?: Record<string, string>; imageSamplers?: Set<string> },
): [GLSLContext, IRContext] {
  const glsl = makeGLSLContext({
    nodeId: spec.nodeId,
    inputs: spec.inputs,
    outputs: spec.outputs,
    params: spec.params,
    textureSamplers: spec.textureSamplers,
    imageSamplers: spec.imageSamplers,
  })
  const ir: IRContext = {
    nodeId: spec.nodeId,
    inputs: spec.inputs,
    outputs: spec.outputs,
    params: spec.params,
    textureSamplers: spec.textureSamplers,
    imageSamplers: spec.imageSamplers,
  }
  return [glsl, ir]
}

let passed = 0
let failed = 0
let warned = 0
let testNum = 0

// WGSL structural issues to flag
const WGSL_ISSUES: Array<{ pattern: RegExp; msg: string }> = [
  { pattern: /\bvec2\(/, msg: 'vec2( should be vec2f(' },
  { pattern: /\bvec3\(/, msg: 'vec3( should be vec3f(' },
  { pattern: /\bvec4\(/, msg: 'vec4( should be vec4f(' },
  { pattern: /(?<!\w)float\s+\w/, msg: '"float x" should be "var x: f32"' },
  { pattern: /(?<!\w)int\s+\w/, msg: '"int x" should be "var x: i32"' },
  // Don't flag ternaries inside comments or strings — just in code
  { pattern: /[^/]\?[^?].*:(?!:)/, msg: 'Possible GLSL ternary (? :) — should be select()' },
  // NOTE: gl_FragCoord is NOT flagged here — the WGSL assembler rewrites it to in.position
  // as a post-pass (see wgsl-assembler.ts:rewriteFragCoord). Nodes use gl_FragCoord intentionally.
  { pattern: /\btexture\s*\(/, msg: 'texture( should be textureSample(' },
]

function validateWGSL(wgsl: string): string[] {
  const issues: string[] = []
  for (const { pattern, msg } of WGSL_ISSUES) {
    if (pattern.test(wgsl)) {
      issues.push(msg)
    }
  }
  return issues
}

type NodeDef = {
  glsl: (ctx: GLSLContext) => string
  ir?: (ctx: IRContext) => IRNodeOutput
}

/**
 * Verify a node's IR output.
 * mode='exact': IR→GLSL must match hand-written GLSL (normalized whitespace)
 * mode='loose': IR→GLSL is printed but not compared (for raw() nodes where output differs structurally)
 */
function verify(
  label: string,
  nodeDef: NodeDef,
  glslCtx: GLSLContext,
  irCtx: IRContext,
  mode: 'exact' | 'loose' = 'exact',
) {
  testNum++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${testNum}. ${label}`)
  console.log('='.repeat(60))

  // Reference GLSL from hand-written glsl()
  const refGLSL = nodeDef.glsl(glslCtx)
  if (verbose) {
    console.log('\n  Reference GLSL (from glsl()):')
    for (const line of refGLSL.split('\n')) {
      console.log(`    ${line.trimStart()}`)
    }
  }

  // IR path
  if (!nodeDef.ir) {
    console.log('\n  !! No ir() function defined!')
    failed++
    return
  }

  let irOutput: IRNodeOutput
  try {
    irOutput = nodeDef.ir(irCtx)
  } catch (e) {
    console.log(`\n  [FAIL] ir() threw: ${e}`)
    failed++
    return
  }

  // IR -> GLSL
  let irGLSLLines: string[]
  try {
    irGLSLLines = lowerNodeOutputToGLSL(irOutput)
  } catch (e) {
    console.log(`\n  [FAIL] IR→GLSL lowering threw: ${e}`)
    failed++
    return
  }
  const irGLSL = irGLSLLines.join('\n  ')
  if (verbose) {
    console.log('\n  IR -> GLSL (from ir() + GLSL backend):')
    for (const line of irGLSL.split('\n')) {
      console.log(`    ${line.trimStart()}`)
    }
  }

  // Compare (normalized) — only for exact mode
  if (mode === 'exact') {
    const refNorm = normalize(refGLSL)
    const irNorm = normalize(irGLSL)

    if (refNorm === irNorm) {
      console.log('  [PASS] GLSL match')
      passed++
    } else {
      console.log('\n  [FAIL] GLSL MISMATCH')
      console.log(`    Expected: ${refNorm}`)
      console.log(`    Got:      ${irNorm}`)
      failed++
    }
  } else {
    // Loose mode — IR runs successfully is already a pass
    console.log('  [PASS] IR→GLSL lowering succeeded (loose mode)')
    passed++
  }

  // IR -> WGSL
  let irWGSLLines: string[]
  try {
    irWGSLLines = lowerNodeOutputToWGSL(irOutput)
  } catch (e) {
    console.log(`  [FAIL] IR→WGSL lowering threw: ${e}`)
    failed++
    return
  }
  const irWGSL = irWGSLLines.join('\n')
  if (verbose) {
    console.log('\n  IR -> WGSL:')
    for (const line of irWGSL.split('\n')) {
      console.log(`    ${line.trimStart()}`)
    }
  }

  // WGSL structural validation
  const wgslIssues = validateWGSL(irWGSL)
  if (wgslIssues.length > 0) {
    console.log(`  [WARN] WGSL structural issues:`)
    for (const issue of wgslIssues) {
      console.log(`    - ${issue}`)
    }
    warned++
  }

  // Test IRFunction lowering if present
  if (irOutput.functions && irOutput.functions.length > 0) {
    try {
      const fnGLSL = lowerFunctionsToGLSL(irOutput.functions)
      if (verbose) {
        console.log(`\n  IRFunctions → GLSL (${irOutput.functions.length} functions):`)
        for (const fn of fnGLSL) {
          for (const line of fn.split('\n')) {
            console.log(`    ${line}`)
          }
        }
      }
    } catch (e) {
      console.log(`  [FAIL] IRFunctions→GLSL lowering threw: ${e}`)
      failed++
      return
    }

    try {
      const fnWGSL = lowerFunctionsToWGSL(irOutput.functions)
      if (verbose) {
        console.log(`\n  IRFunctions → WGSL (${irOutput.functions.length} functions):`)
        for (const fn of fnWGSL) {
          for (const line of fn.split('\n')) {
            console.log(`    ${line}`)
          }
        }
      }

      // Validate WGSL functions too
      const fnWGSLStr = fnWGSL.join('\n')
      const fnIssues = validateWGSL(fnWGSLStr)
      if (fnIssues.length > 0) {
        console.log(`  [WARN] WGSL function structural issues:`)
        for (const issue of fnIssues) {
          console.log(`    - ${issue}`)
        }
        warned++
      }
    } catch (e) {
      console.log(`  [FAIL] IRFunctions→WGSL lowering threw: ${e}`)
      failed++
      return
    }

    console.log(`  [PASS] ${irOutput.functions.length} IRFunction(s) lowered to GLSL + WGSL`)
  }
}

// ===========================================================================
// Test cases — 26 original trivial nodes (exact match)
// ===========================================================================

// 1. Mix
{
  const [g, i] = ctx({
    nodeId: 'mix-abc123',
    inputs: { a: 'node_noise_xyz_value', b: 'node_color_def_color', factor: 'u_mix_abc123_factor' },
    outputs: { result: 'node_mix_abc123_result' },
    params: { factor: 0.5 },
  })
  verify('Mix', mixNode, g, i)

  // RGBA assertion — Blend: both color inputs are RGBA, mix() blends alpha too via `factor`.
  testNum++
  console.log(`\n  ${testNum}. Mix — RGBA blend assertion`)
  const refGLSL = mixNode.glsl(g)
  let mixOk = true
  if (!/vec4 node_mix_abc123_result = mix\(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 mix() assignment (blends alpha). Got:\n    ${refGLSL}`)
    mixOk = false
  }
  const irOut = mixNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_mix_abc123_result = mix\(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 mix() assignment. Got:\n    ${irGLSL}`)
    mixOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_mix_abc123_result: vec4f = mix\(node_noise_xyz_value, node_color_def_color, u_mix_abc123_factor\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f mix() assignment. Got:\n    ${irWGSL}`)
    mixOk = false
  }
  if (mixOk) {
    console.log('  [PASS] mix: a/b/result are RGBA (vec4/vec4f), factor blends alpha')
    passed++
  } else {
    failed++
  }
}

// 2. Clamp
{
  const [g, i] = ctx({
    nodeId: 'clamp-def456',
    inputs: { value: 'node_noise_xyz_value', min: 'u_clamp_def456_min', max: 'u_clamp_def456_max' },
    outputs: { result: 'node_clamp_def456_result' },
    params: { min: 0.0, max: 1.0 },
  })
  verify('Clamp', clampNode, g, i)
}

// 3. Arithmetic (Add, 2 inputs)
{
  const [g, i] = ctx({
    nodeId: 'arith-aaa111',
    inputs: { in_0: 'node_time_xyz_time', in_1: 'node_remap_bbb_result' },
    outputs: { result: 'node_arith_aaa111_result' },
    params: { operation: 'add', inputCount: 2 },
  })
  verify('Arithmetic (Add, 2 inputs)', arithmeticNode, g, i)
}

// 4. Trig (Sin)
{
  const [g, i] = ctx({
    nodeId: 'trig-bbb222',
    inputs: { value: 'node_time_xyz_time', frequency: 'u_trig_bbb222_frequency', amplitude: 'u_trig_bbb222_amplitude' },
    outputs: { result: 'node_trig_bbb222_result' },
    params: { func: 'sin', frequency: 1.0, amplitude: 1.0 },
  })
  verify('Trig (Sin)', trigNode, g, i)
}

// 5. Remap
{
  const [g, i] = ctx({
    nodeId: 'remap-ccc333',
    inputs: { value: 'node_noise_xyz_value', inMin: 'node_float_aaa_value', inMax: 'node_float_bbb_value', outMin: 'node_float_ccc_value', outMax: 'node_float_ddd_value' },
    outputs: { result: 'node_remap_ccc333_result' },
    params: {},
  })
  verify('Remap', remapNode, g, i)
}

// 6. Power
{
  const [g, i] = ctx({
    nodeId: 'pow-ddd444',
    inputs: { base: 'node_noise_xyz_value', exponent: 'u_pow_ddd444_exponent' },
    outputs: { result: 'node_pow_ddd444_result' },
    params: { exponent: 2.0 },
  })
  verify('Power', powerNode, g, i)
}

// 7. Round (Floor)
{
  const [g, i] = ctx({
    nodeId: 'round-eee555',
    inputs: { value: 'node_noise_xyz_value' },
    outputs: { result: 'node_round_eee555_result' },
    params: { mode: 'floor' },
  })
  verify('Round (Floor)', roundNode, g, i)
}

// 8. Smoothstep
{
  const [g, i] = ctx({
    nodeId: 'smooth-fff666',
    inputs: { x: 'node_noise_xyz_value', min: 'u_smooth_fff666_min', max: 'u_smooth_fff666_max' },
    outputs: { result: 'node_smooth_fff666_result' },
    params: { min: 0.0, max: 1.0 },
  })
  verify('Smoothstep', smoothstepNode, g, i)
}

// 9. Turbulence
{
  const [g, i] = ctx({
    nodeId: 'turb-ggg777',
    inputs: { value: 'node_noise_xyz_value' },
    outputs: { result: 'node_turb_ggg777_result' },
    params: {},
  })
  verify('Turbulence', turbulenceNode, g, i)
}

// 10. Ridged
{
  const [g, i] = ctx({
    nodeId: 'ridg-hhh888',
    inputs: { value: 'node_noise_xyz_value' },
    outputs: { result: 'node_ridg_hhh888_result' },
    params: {},
  })
  verify('Ridged', ridgedNode, g, i)
}

// 11. Brightness/Contrast
{
  const [g, i] = ctx({
    nodeId: 'bc-iii999',
    inputs: { color: 'node_noise_xyz_color', brightness: 'u_bc_iii999_brightness', contrast: 'u_bc_iii999_contrast' },
    outputs: { result: 'node_bc_iii999_result' },
    params: { brightness: 0.0, contrast: 0.0 },
  })
  verify('Brightness/Contrast', brightnessContrastNode, g, i)

  // RGBA assertion — Channel transform: brightness/contrast applies to all 4 channels (incl. alpha).
  testNum++
  console.log(`\n  ${testNum}. Brightness/Contrast — RGBA channel-transform assertion`)
  const refGLSL = brightnessContrastNode.glsl(g)
  let bcOk = true
  if (!/^vec4 node_bc_iii999_result = /.test(refGLSL) || /vec3/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 declaration, no vec3 remnants. Got:\n    ${refGLSL}`)
    bcOk = false
  }
  const irOut = brightnessContrastNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/^vec4 node_bc_iii999_result = /.test(irGLSL) || /vec3/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 declaration, no vec3 remnants. Got:\n    ${irGLSL}`)
    bcOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/^var node_bc_iii999_result: vec4f = /.test(irWGSL) || /vec3f/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f declaration, no vec3f remnants. Got:\n    ${irWGSL}`)
    bcOk = false
  }
  if (bcOk) {
    console.log('  [PASS] brightness_contrast: color/result are RGBA (vec4/vec4f), formula covers alpha')
    passed++
  } else {
    failed++
  }
}

// 11b. Brightness/Contrast — preserveAlpha=true
{
  const [g, i] = ctx({
    nodeId: 'bc-iii999pa',
    inputs: { color: 'node_noise_xyz_color', brightness: 'u_bc_iii999pa_brightness', contrast: 'u_bc_iii999pa_contrast' },
    outputs: { result: 'node_bc_iii999pa_result' },
    params: { brightness: 0.0, contrast: 0.0, preserveAlpha: true },
  })
  verify('Brightness/Contrast (preserveAlpha)', brightnessContrastNode, g, i)

  // preserveAlpha assertion — rgb transformed, input alpha passed through untouched.
  testNum++
  console.log(`\n  ${testNum}. Brightness/Contrast — preserveAlpha alpha-passthrough assertion`)
  const refGLSL = brightnessContrastNode.glsl(g)
  let bcPaOk = true
  if (!/^vec4 node_bc_iii999pa_result = vec4\(/.test(refGLSL) || !/node_noise_xyz_color\.rgb/.test(refGLSL) || !/,\s*node_noise_xyz_color\.a\)/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4(<rgb formula>, color.a). Got:\n    ${refGLSL}`)
    bcPaOk = false
  }
  const irOut = brightnessContrastNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/node_noise_xyz_color\.rgb/.test(irGLSL) || !/node_noise_xyz_color\.a/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected rgb formula + alpha passthrough. Got:\n    ${irGLSL}`)
    bcPaOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/^var node_bc_iii999pa_result: vec4f = /.test(irWGSL) || !/\.rgb/.test(irWGSL) || !/\.a/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f from rgb formula + alpha passthrough. Got:\n    ${irWGSL}`)
    bcPaOk = false
  }
  if (bcPaOk) {
    console.log('  [PASS] brightness_contrast: preserveAlpha transforms rgb only, passes input alpha through')
    passed++
  } else {
    failed++
  }
}

// 12. Invert
{
  const [g, i] = ctx({
    nodeId: 'inv-jjj000',
    inputs: { color: 'node_noise_xyz_color' },
    outputs: { result: 'node_inv_jjj000_result' },
    params: {},
  })
  verify('Invert', invertNode, g, i)

  // RGBA assertion — Channel transform: `vec4(1.0) - color` inverts alpha too, by design.
  testNum++
  console.log(`\n  ${testNum}. Invert — RGBA channel-transform assertion`)
  const refGLSL = invertNode.glsl(g)
  let invOk = true
  if (!/vec4 node_inv_jjj000_result = vec4\(1\.0\) - node_noise_xyz_color;/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4(1.0) - color (inverts alpha too). Got:\n    ${refGLSL}`)
    invOk = false
  }
  const irOut = invertNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_inv_jjj000_result = vec4\(1\.0\) - node_noise_xyz_color;/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4(1.0) - color. Got:\n    ${irGLSL}`)
    invOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_inv_jjj000_result: vec4f = \(vec4f\(1\.0\) - node_noise_xyz_color\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f(1.0) - color. Got:\n    ${irWGSL}`)
    invOk = false
  }
  if (invOk) {
    console.log('  [PASS] invert: color/result are RGBA (vec4/vec4f), alpha inverted too')
    passed++
  } else {
    failed++
  }
}

// 12b. Invert — preserveAlpha=true
{
  const [g, i] = ctx({
    nodeId: 'inv-jjj000pa',
    inputs: { color: 'node_noise_xyz_color' },
    outputs: { result: 'node_inv_jjj000pa_result' },
    params: { preserveAlpha: true },
  })
  verify('Invert (preserveAlpha)', invertNode, g, i)

  // preserveAlpha assertion — rgb inverted, input alpha passed through untouched.
  testNum++
  console.log(`\n  ${testNum}. Invert — preserveAlpha alpha-passthrough assertion`)
  const refGLSL = invertNode.glsl(g)
  let invPaOk = true
  if (!/vec4 node_inv_jjj000pa_result = vec4\(vec3\(1\.0\) - node_noise_xyz_color\.rgb, node_noise_xyz_color\.a\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4(vec3(1.0) - color.rgb, color.a). Got:\n    ${refGLSL}`)
    invPaOk = false
  }
  const irOut = invertNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/node_noise_xyz_color\.rgb/.test(irGLSL) || !/node_noise_xyz_color\.a/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected rgb inversion + alpha passthrough. Got:\n    ${irGLSL}`)
    invPaOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/^var node_inv_jjj000pa_result: vec4f = /.test(irWGSL) || !/\.rgb/.test(irWGSL) || !/\.a/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f from rgb inversion + alpha passthrough. Got:\n    ${irWGSL}`)
    invPaOk = false
  }
  if (invPaOk) {
    console.log('  [PASS] invert: preserveAlpha inverts rgb only, passes input alpha through')
    passed++
  } else {
    failed++
  }
}

// 13. Grayscale (Luminance)
{
  const [g, i] = ctx({
    nodeId: 'gray-kkk111',
    inputs: { color: 'node_noise_xyz_color' },
    outputs: { result: 'node_gray_kkk111_result' },
    params: { mode: 'luminance' },
  })
  verify('Grayscale (Luminance)', grayscaleNode, g, i)

  // RGBA assertion — Color-space op: input is RGBA, but only `.rgb` feeds the luminance math;
  // output stays `float` — alpha is irrelevant to this space (not preserved, not needed).
  testNum++
  console.log(`\n  ${testNum}. Grayscale — RGBA input, .rgb-only math, float output assertion`)
  const refGLSL = grayscaleNode.glsl(g)
  let grayOk = true
  if (!/float node_gray_kkk111_result = dot\(node_noise_xyz_color\.rgb, vec3\(0\.2126, 0\.7152, 0\.0722\)\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected dot(color.rgb, ...) with float output. Got:\n    ${refGLSL}`)
    grayOk = false
  }
  const irOut = grayscaleNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/float node_gray_kkk111_result = dot\(node_noise_xyz_color\.rgb, vec3\(0\.2126, 0\.7152, 0\.0722\)\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected dot(color.rgb, ...) with float output. Got:\n    ${irGLSL}`)
    grayOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_gray_kkk111_result: f32 = /.test(irWGSL) || !/\.rgb/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected f32 output reading .rgb from RGBA input. Got:\n    ${irWGSL}`)
    grayOk = false
  }
  if (grayOk) {
    console.log('  [PASS] grayscale: input is RGBA (reads .rgb only), output stays float (alpha N/A)')
    passed++
  } else {
    failed++
  }
}

// 14. Posterize
{
  const [g, i] = ctx({
    nodeId: 'post-lll222',
    inputs: { color: 'node_noise_xyz_color', levels: 'u_post_lll222_levels' },
    outputs: { result: 'node_post_lll222_result' },
    params: { levels: 4 },
  })
  verify('Posterize', posterizeNode, g, i)

  // RGBA assertion — Channel transform: quantization formula applies to all 4 channels (incl. alpha).
  testNum++
  console.log(`\n  ${testNum}. Posterize — RGBA channel-transform assertion`)
  const refGLSL = posterizeNode.glsl(g)
  let postOk = true
  if (!/^vec4 node_post_lll222_result = floor\(/.test(refGLSL) || /vec3/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 floor(...) declaration, no vec3 remnants. Got:\n    ${refGLSL}`)
    postOk = false
  }
  const irOut = posterizeNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/^vec4 node_post_lll222_result = floor\(/.test(irGLSL) || /vec3/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 floor(...) declaration, no vec3 remnants. Got:\n    ${irGLSL}`)
    postOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/^var node_post_lll222_result: vec4f = /.test(irWGSL) || /vec3f/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f declaration, no vec3f remnants. Got:\n    ${irWGSL}`)
    postOk = false
  }
  if (postOk) {
    console.log('  [PASS] posterize: color/result are RGBA (vec4/vec4f), quantization covers alpha')
    passed++
  } else {
    failed++
  }
}

// 14b. Posterize — preserveAlpha=true
{
  const [g, i] = ctx({
    nodeId: 'post-lll222pa',
    inputs: { color: 'node_noise_xyz_color', levels: 'u_post_lll222pa_levels' },
    outputs: { result: 'node_post_lll222pa_result' },
    params: { levels: 4, preserveAlpha: true },
  })
  verify('Posterize (preserveAlpha)', posterizeNode, g, i)

  // preserveAlpha assertion — rgb quantized, input alpha passed through untouched.
  testNum++
  console.log(`\n  ${testNum}. Posterize — preserveAlpha alpha-passthrough assertion`)
  const refGLSL = posterizeNode.glsl(g)
  let postPaOk = true
  if (!/^vec4 node_post_lll222pa_result = vec4\(floor\(/.test(refGLSL) || !/node_noise_xyz_color\.rgb/.test(refGLSL) || !/,\s*node_noise_xyz_color\.a\)/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4(floor(color.rgb * levels) / (levels - 1.0), color.a). Got:\n    ${refGLSL}`)
    postPaOk = false
  }
  const irOut = posterizeNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/node_noise_xyz_color\.rgb/.test(irGLSL) || !/node_noise_xyz_color\.a/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected rgb quantization + alpha passthrough. Got:\n    ${irGLSL}`)
    postPaOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/^var node_post_lll222pa_result: vec4f = /.test(irWGSL) || !/\.rgb/.test(irWGSL) || !/\.a/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f from rgb quantization + alpha passthrough. Got:\n    ${irWGSL}`)
    postPaOk = false
  }
  if (postPaOk) {
    console.log('  [PASS] posterize: preserveAlpha quantizes rgb only, passes input alpha through')
    passed++
  } else {
    failed++
  }
}

// 15. Checkerboard
{
  const [g, i] = ctx({
    nodeId: 'check-mmm333',
    inputs: { coords: 'node_uv_xyz_coords' },
    outputs: { value: 'node_check_mmm333_value' },
    params: {},
  })
  verify('Checkerboard', checkerboardNode, g, i)
}

// 16. Stripes
{
  const [g, i] = ctx({
    nodeId: 'strip-nnn444',
    inputs: { coords: 'node_uv_xyz_coords', softness: 'u_strip_nnn444_softness' },
    outputs: { value: 'node_strip_nnn444_value' },
    params: { softness: 0.0 },
  })
  verify('Stripes', stripesNode, g, i)
}

// 17. Dots
{
  const [g, i] = ctx({
    nodeId: 'dots-ooo555',
    inputs: { coords: 'node_uv_xyz_coords', radius: 'u_dots_ooo555_radius', softness: 'u_dots_ooo555_softness' },
    outputs: { value: 'node_dots_ooo555_value' },
    params: { radius: 0.3, softness: 0.05 },
  })
  verify('Dots', dotsNode, g, i)
}

// 18. Gradient (Linear)
{
  const [g, i] = ctx({
    nodeId: 'grad-ppp666',
    inputs: { coords: 'node_uv_xyz_coords' },
    outputs: { value: 'node_grad_ppp666_value' },
    params: { gradientType: 'linear' },
  })
  verify('Gradient (Linear)', gradientNode, g, i)
}

// 19. Split Vec2
{
  const [g, i] = ctx({
    nodeId: 'split2-qqq777',
    inputs: { vector: 'node_uv_xyz_coords' },
    outputs: { x: 'node_split2_qqq777_x', y: 'node_split2_qqq777_y' },
    params: {},
  })
  verify('Split Vec2', splitVec2Node, g, i)
}

// 20. Split Vec3
{
  const [g, i] = ctx({
    nodeId: 'split3-rrr888',
    inputs: { vector: 'node_color_xyz_color' },
    outputs: { x: 'node_split3_rrr888_x', y: 'node_split3_rrr888_y', z: 'node_split3_rrr888_z' },
    params: {},
  })
  verify('Split Vec3', splitVec3Node, g, i)
}

// 21. Combine Vec2
{
  const [g, i] = ctx({
    nodeId: 'comb2-sss999',
    inputs: { x: 'node_split_aaa_x', y: 'node_split_bbb_y' },
    outputs: { vector: 'node_comb2_sss999_vector' },
    params: {},
  })
  verify('Combine Vec2', combineVec2Node, g, i)
}

// 22. Combine Vec3
{
  const [g, i] = ctx({
    nodeId: 'comb3-ttt000',
    inputs: { x: 'node_split_aaa_x', y: 'node_split_bbb_y', z: 'node_split_ccc_z' },
    outputs: { vector: 'node_comb3_ttt000_vector' },
    params: {},
  })
  verify('Combine Vec3', combineVec3Node, g, i)
}

// 23. Time
{
  const [g, i] = ctx({
    nodeId: 'time-uuu111',
    inputs: { speed: 'u_time_uuu111_speed' },
    outputs: { time: 'node_time_uuu111_time' },
    params: { speed: 1.0 },
  })
  verify('Time', timeNode, g, i)
}

// 24. UV Transform (uv-coords)
{
  const [g, i] = ctx({
    nodeId: 'uv-vvv222',
    inputs: { coords: 'node_quantize_xyz_coords' },
    outputs: { uv: 'node_uv_vvv222_uv' },
    params: { srt_scaleX: 1.0, srt_scaleY: 1.0, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0 },
  })
  verify('UV Transform', uvCoordsNode, g, i)
}

// 25. Resolution
{
  const [g, i] = ctx({
    nodeId: 'res-www333',
    inputs: {},
    outputs: { resolution: 'node_res_www333_resolution' },
    params: {},
  })
  verify('Resolution', resolutionNode, g, i)
}

// 26. Fragment Output
{
  const [g, i] = ctx({
    nodeId: 'out-xxx444',
    inputs: { color: 'node_mix_abc_result', alpha: 'u_out_xxx444_alpha' },
    outputs: {},
    params: { quality: 'adaptive' },
  })
  verify('Fragment Output', fragmentOutputNode, g, i)
}

// ===========================================================================
// New test cases — 15 additional nodes
// ===========================================================================

// 27. Float Constant
{
  const [g, i] = ctx({
    nodeId: 'float-aaa111',
    inputs: { value: 'u_float_aaa111_value' },
    outputs: { value: 'node_float_aaa111_value' },
    params: { value: 1.0 },
  })
  verify('Float Constant', floatConstantNode, g, i)
}

// 28. Color Constant
{
  const [g, i] = ctx({
    nodeId: 'color-bbb222',
    inputs: { color: 'u_color_bbb222_color' },
    outputs: { color: 'node_color_bbb222_color' },
    params: { color: [1.0, 0.0, 1.0, 1.0] },
  })
  verify('Color Constant', colorConstantNode, g, i)
}

// Fragment Output — alpha op (subtract) + premultiplied write
{
  const [g, i] = ctx({
    nodeId: 'fo-eee555',
    inputs: { color: 'node_src_color', alpha: 'u_fo_eee555_alpha' },
    outputs: {},
    params: { alphaOp: 'subtract', quality: 'adaptive', anchor: 'center', alpha: 0.5 },
  })
  verify('Fragment Output (alpha subtract)', fragmentOutputNode, g, i)
}

// 29. Vec2 Constant
{
  const [g, i] = ctx({
    nodeId: 'vec2-ccc333',
    inputs: { x: 'u_vec2_ccc333_x', y: 'u_vec2_ccc333_y' },
    outputs: { value: 'node_vec2_ccc333_value' },
    params: { x: 0.0, y: 0.0 },
  })
  verify('Vec2 Constant', vec2ConstantNode, g, i)
}

// 30. Random
{
  const [g, i] = ctx({
    nodeId: 'rand-ddd444',
    inputs: { min: 'u_rand_ddd444_min', max: 'u_rand_ddd444_max', decimals: 'u_rand_ddd444_decimals' },
    outputs: { value: 'node_rand_ddd444_value' },
    params: { min: 0, max: 1, decimals: 7, seed: 0 },
  })
  verify('Random', randomNode, g, i)
}

// 31. HSV to RGB
{
  const [g, i] = ctx({
    nodeId: 'hsv-eee555',
    inputs: { h: 'node_grad_aaa_value', s: 'u_hsv_eee555_s', v: 'u_hsv_eee555_v' },
    outputs: { rgb: 'node_hsv_eee555_rgb' },
    params: {},
  })
  verify('HSV to RGB', hsvToRgbNode, g, i, 'loose')

  // RGBA assertion — `rgb` output port migrated to `color` (vec4); opaque generator, a=1.0.
  testNum++
  console.log(`\n  ${testNum}. HSV to RGB — RGBA output assertion`)
  const refGLSL = hsvToRgbNode.glsl(g)
  let hsvOk = true
  if (!/vec4 node_hsv_eee555_rgb = vec4\(rgb_hsv_eee555, 1\.0\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 output assignment. Got:\n    ${refGLSL}`)
    hsvOk = false
  }
  const irOut = hsvToRgbNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_hsv_eee555_rgb = vec4\(rgb_hsv_eee555, 1\.0\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 output assignment. Got:\n    ${irGLSL}`)
    hsvOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_hsv_eee555_rgb: vec4f = vec4f\(rgb_hsv_eee555, 1\.0\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f output assignment. Got:\n    ${irWGSL}`)
    hsvOk = false
  }
  if (hsvOk) {
    console.log('  [PASS] hsv_to_rgb: rgb output is RGBA (vec4/vec4f) on both backends')
    passed++
  } else {
    failed++
  }
}

// 32. Color Ramp (smooth, 2 RGBA stops)
{
  const stops = [
    { position: 0.0, color: [0, 0, 0, 1] },
    { position: 1.0, color: [1, 1, 1, 0.5] },
  ]
  const [g, i] = ctx({
    nodeId: 'ramp-fff666',
    inputs: { t: 'node_grad_aaa_value' },
    outputs: { color: 'node_ramp_fff666_color' },
    params: { interpolation: 'smooth', stops },
  })
  verify('Color Ramp (smooth, RGBA stops)', colorRampNode, g, i, 'loose')

  // RGBA assertion — output port migrated to `color` (vec4); alpha interpolates
  // alongside rgb through the same mix() chain (see Task 5b RGBA migration).
  testNum++
  console.log(`\n  ${testNum}. Color Ramp — RGBA output assertion`)
  const refGLSL = colorRampNode.glsl(g)
  let rampOk = true
  if (!/vec4 node_ramp_fff666_color = vec4\(0\.0, 0\.0, 0\.0, 1\.0\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 init assignment. Got:\n    ${refGLSL}`)
    rampOk = false
  }
  if (!/node_ramp_fff666_color = mix\(node_ramp_fff666_color, vec4\(1\.0, 1\.0, 1\.0, 0\.5\), smoothstep\(0\.0, 1\.0, node_grad_aaa_value\)\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 mix() carrying alpha. Got:\n    ${refGLSL}`)
    rampOk = false
  }
  const irOut = colorRampNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_ramp_fff666_color = vec4\(0\.0, 0\.0, 0\.0, 1\.0\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 init. Got:\n    ${irGLSL}`)
    rampOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_ramp_fff666_color: vec4f = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f init. Got:\n    ${irWGSL}`)
    rampOk = false
  }
  if (!/node_ramp_fff666_color = mix\(node_ramp_fff666_color, vec4f\(1\.0, 1\.0, 1\.0, 0\.5\), smoothstep\(0\.0, 1\.0, node_grad_aaa_value\)\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f mix() carrying alpha. Got:\n    ${irWGSL}`)
    rampOk = false
  }
  if (rampOk) {
    console.log('  [PASS] color_ramp: output is RGBA (vec4/vec4f), alpha interpolated via mix()')
    passed++
  } else {
    failed++
  }
}

// 32b. Color Ramp — legacy 3-length stop backward-compat (opaque, a=1)
{
  const stops = [
    { position: 0.0, color: [0.2, 0.4, 0.6] },
    { position: 1.0, color: [0.8, 0.6, 0.4] },
  ]
  const [g, i] = ctx({
    nodeId: 'ramp-legacy1',
    inputs: { t: 'node_grad_bbb_value' },
    outputs: { color: 'node_ramp_legacy1_color' },
    params: { interpolation: 'linear', stops },
  })
  testNum++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${testNum}. Color Ramp — legacy 3-length stop backward-compat`)
  console.log('='.repeat(60))
  let legacyOk = true
  const refGLSL = colorRampNode.glsl(g)
  if (!/vec4 node_ramp_legacy1_color = vec4\(0\.2, 0\.4, 0\.6, 1\.0\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: legacy 3-length stop should pad alpha to 1.0. Got:\n    ${refGLSL}`)
    legacyOk = false
  }
  const irOut = colorRampNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_ramp_legacy1_color = vec4\(0\.2, 0\.4, 0\.6, 1\.0\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: legacy 3-length stop should pad alpha to 1.0. Got:\n    ${irGLSL}`)
    legacyOk = false
  }
  if (legacyOk) {
    console.log('  [PASS] color_ramp: legacy 3-length stops render opaque (a=1.0)')
    passed++
  } else {
    failed++
  }
}

// 33. Noise (simplex, non-texture mode)
{
  const [g, i] = ctx({
    nodeId: 'noise-ggg777',
    inputs: {
      coords: 'node_uv_aaa_uv',
      phase: 'u_noise_ggg777_phase',
      srt_scale: 'u_noise_ggg777_srt_scale',
      srt_translateX: 'u_noise_ggg777_srt_translateX',
      srt_translateY: 'u_noise_ggg777_srt_translateY',
      seed: 'u_noise_ggg777_seed',
    },
    outputs: { value: 'node_noise_ggg777_value' },
    params: { noiseType: 'simplex', seed: 12345, srt_scale: 4, srt_translateX: 0, srt_translateY: 0 },
  })
  verify('Noise (simplex)', noiseNode, g, i, 'loose')
}

// 34. Noise (value)
{
  const [g, i] = ctx({
    nodeId: 'noise-hhh888',
    inputs: {
      coords: 'node_uv_aaa_uv',
      phase: 'u_noise_hhh888_phase',
      srt_scale: 'u_noise_hhh888_srt_scale',
      srt_translateX: 'u_noise_hhh888_srt_translateX',
      srt_translateY: 'u_noise_hhh888_srt_translateY',
      seed: 'u_noise_hhh888_seed',
    },
    outputs: { value: 'node_noise_hhh888_value' },
    params: { noiseType: 'value', seed: 12345, srt_scale: 4, srt_translateX: 0, srt_translateY: 0 },
  })
  verify('Noise (value)', noiseNode, g, i, 'loose')
}

// 35. FBM (standard, simplex)
{
  const [g, i] = ctx({
    nodeId: 'fbm-iii999',
    inputs: {
      coords: 'node_uv_aaa_uv',
      phase: 'u_fbm_iii999_phase',
      srt_scale: 'u_fbm_iii999_srt_scale',
      srt_translateX: 'u_fbm_iii999_srt_translateX',
      srt_translateY: 'u_fbm_iii999_srt_translateY',
      seed: 'u_fbm_iii999_seed',
      lacunarity: 'u_fbm_iii999_lacunarity',
      gain: 'u_fbm_iii999_gain',
      octaves: 'u_fbm_iii999_octaves',
    },
    outputs: { value: 'node_fbm_iii999_value' },
    params: {
      noiseType: 'simplex', fractalMode: 'standard', octaves: 4,
      lacunarity: 2.0, gain: 0.5, seed: 12345,
      srt_scale: 4, srt_translateX: 0, srt_translateY: 0,
    },
  })
  verify('FBM (standard, simplex)', fbmNode, g, i, 'loose')
}

// 36. Tile (no mirror)
{
  const [g, i] = ctx({
    nodeId: 'tile-jjj000',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      countX: 'u_tile_jjj000_countX',
      countY: 'u_tile_jjj000_countY',
    },
    outputs: { color: 'node_tile_jjj000_color', uv: 'node_tile_jjj000_uv' },
    params: { countX: 4, countY: 4, mirror: 'none' },
  })
  verify('Tile (no mirror)', tileNode, g, i)
}

// 36b. Tile (no mirror, texture mode) — RGBA sample assertion
{
  const [g, i] = ctx({
    nodeId: 'tile-jjj001',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      countX: 'u_tile_jjj001_countX',
      countY: 'u_tile_jjj001_countY',
    },
    outputs: { color: 'node_tile_jjj001_color', uv: 'node_tile_jjj001_uv' },
    params: { countX: 4, countY: 4, mirror: 'none' },
    textureSamplers: { source: 'u_pass0_tex' },
  })
  verify('Tile (no mirror, texture mode)', tileNode, g, i, 'loose')

  // RGBA assertion — Spatial: full vec4 sample carries alpha through (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Tile (no mirror, texture mode) — RGBA sample assertion`)
  let tileTexOk = true
  const refGLSL = tileNode.glsl(g)
  if (!/vec4 node_tile_jjj001_color = texture\(u_pass0_tex, node_tile_jjj001_uv\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 texture() sample (no .rgb). Got:\n    ${refGLSL}`)
    tileTexOk = false
  }
  const irOut = tileNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_tile_jjj001_color = texture\(u_pass0_tex, node_tile_jjj001_uv\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected full vec4 sample. Got:\n    ${irGLSL}`)
    tileTexOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_tile_jjj001_color: vec4f = textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, node_tile_jjj001_uv\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f sample. Got:\n    ${irWGSL}`)
    tileTexOk = false
  }
  if (tileTexOk) {
    console.log('  [PASS] tile (texture mode): color output is full RGBA sample (vec4/vec4f), alpha carried')
    passed++
  } else {
    failed++
  }
}

// 37. Tile (mirror XY) — uses raw() with ternaries
{
  const [g, i] = ctx({
    nodeId: 'tile-kkk111',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      countX: 'u_tile_kkk111_countX',
      countY: 'u_tile_kkk111_countY',
    },
    outputs: { color: 'node_tile_kkk111_color', uv: 'node_tile_kkk111_uv' },
    params: { countX: 4, countY: 4, mirror: 'xy' },
  })
  verify('Tile (mirror XY)', tileNode, g, i, 'loose')
}

// 38. Warp (non-texture, clamp edge)
{
  const [g, i] = ctx({
    nodeId: 'warp-lll222',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      phase: 'u_warp_lll222_phase',
      srt_scale: 'u_warp_lll222_srt_scale',
      srt_translateX: 'u_warp_lll222_srt_translateX',
      srt_translateY: 'u_warp_lll222_srt_translateY',
      strength: 'u_warp_lll222_strength',
      seed: 'u_warp_lll222_seed',
    },
    outputs: { color: 'node_warp_lll222_color', warped: 'node_warp_lll222_warped', warpedPhase: 'node_warp_lll222_warpedPhase' },
    params: {
      noiseType: 'value', warpDepth: '2', edge: 'clamp',
      strength: 0.3, seed: 12345, srt_scale: 4, srt_translateX: 0, srt_translateY: 0,
    },
  })
  verify('Warp (non-texture, clamp)', warpNode, g, i, 'loose')
}

// 38b. Warp (texture mode, clamp edge) — RGBA sample assertion
{
  const [g, i] = ctx({
    nodeId: 'warp-lll223',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      phase: 'u_warp_lll223_phase',
      srt_scale: 'u_warp_lll223_srt_scale',
      srt_translateX: 'u_warp_lll223_srt_translateX',
      srt_translateY: 'u_warp_lll223_srt_translateY',
      strength: 'u_warp_lll223_strength',
      seed: 'u_warp_lll223_seed',
    },
    outputs: { color: 'node_warp_lll223_color', warped: 'node_warp_lll223_warped', warpedPhase: 'node_warp_lll223_warpedPhase' },
    params: {
      noiseType: 'value', warpDepth: '2', edge: 'clamp',
      strength: 0.3, seed: 12345, srt_scale: 4, srt_translateX: 0, srt_translateY: 0,
    },
    textureSamplers: { source: 'u_pass0_tex' },
  })
  verify('Warp (texture mode, clamp)', warpNode, g, i, 'loose')

  // RGBA assertion — Spatial: full vec4 sample carries alpha through (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Warp (texture mode, clamp) — RGBA sample assertion`)
  let warpTexOk = true
  const refGLSL = warpNode.glsl(g)
  if (!/vec4 node_warp_lll223_color = texture\(u_pass0_tex, dw_edge_warp_lll223\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 texture() sample (no .rgb). Got:\n    ${refGLSL}`)
    warpTexOk = false
  }
  const irOut = warpNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_warp_lll223_color = texture\(u_pass0_tex, dw_edge_warp_lll223\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected full vec4 sample. Got:\n    ${irGLSL}`)
    warpTexOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_warp_lll223_color: vec4f = textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, dw_edge_warp_lll223\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f sample. Got:\n    ${irWGSL}`)
    warpTexOk = false
  }
  if (warpTexOk) {
    console.log('  [PASS] warp (texture mode): color output is full RGBA sample (vec4/vec4f), alpha carried')
    passed++
  } else {
    failed++
  }
}

// 39. Pixelate (non-texture)
{
  const [g, i] = ctx({
    nodeId: 'pix-mmm333',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      pixelSize: 'u_pix_mmm333_pixelSize',
    },
    outputs: { color: 'node_pix_mmm333_color', uv: 'node_pix_mmm333_uv' },
    params: { pixelSize: 8 },
  })
  verify('Pixelate (non-texture)', pixelateNode, g, i, 'loose')
}

// 39b. Pixelate (texture mode) — RGBA sample assertion
{
  const [g, i] = ctx({
    nodeId: 'pix-mmm334',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      pixelSize: 'u_pix_mmm334_pixelSize',
    },
    outputs: { color: 'node_pix_mmm334_color', uv: 'node_pix_mmm334_uv' },
    params: { pixelSize: 8 },
    textureSamplers: { source: 'u_pass0_tex' },
  })
  verify('Pixelate (texture mode)', pixelateNode, g, i, 'loose')

  // RGBA assertion — Spatial: full vec4 sample carries alpha through (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Pixelate (texture mode) — RGBA sample assertion`)
  let pixTexOk = true
  const refGLSL = pixelateNode.glsl(g)
  if (!/vec4 node_pix_mmm334_color = texture\(u_pass0_tex, pxl_screenUV_pix_mmm334\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 texture() sample (no .rgb). Got:\n    ${refGLSL}`)
    pixTexOk = false
  }
  const irOut = pixelateNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_pix_mmm334_color = texture\(u_pass0_tex, pxl_screenUV_pix_mmm334\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected full vec4 sample. Got:\n    ${irGLSL}`)
    pixTexOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_pix_mmm334_color: vec4f = textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, pxl_screenUV_pix_mmm334\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f sample. Got:\n    ${irWGSL}`)
    pixTexOk = false
  }
  if (pixTexOk) {
    console.log('  [PASS] pixelate (texture mode): color output is full RGBA sample (vec4/vec4f), alpha carried')
    passed++
  } else {
    failed++
  }
}

// 40. Polar Coords (forward)
{
  const [g, i] = ctx({
    nodeId: 'polar-nnn444',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      centerX: 'u_polar_nnn444_centerX',
      centerY: 'u_polar_nnn444_centerY',
    },
    outputs: { color: 'node_polar_nnn444_color', polar: 'node_polar_nnn444_polar' },
    params: { mode: 'forward', centerX: 0.5, centerY: 0.5 },
  })
  verify('Polar Coords (forward)', polarCoordsNode, g, i)
}

// 40b. Polar Coords (forward, texture mode) — RGBA sample assertion
{
  const [g, i] = ctx({
    nodeId: 'polar-nnn445',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      centerX: 'u_polar_nnn445_centerX',
      centerY: 'u_polar_nnn445_centerY',
    },
    outputs: { color: 'node_polar_nnn445_color', polar: 'node_polar_nnn445_polar' },
    params: { mode: 'forward', centerX: 0.5, centerY: 0.5 },
    textureSamplers: { source: 'u_pass0_tex' },
  })
  verify('Polar Coords (forward, texture mode)', polarCoordsNode, g, i, 'loose')

  // RGBA assertion — Spatial: full vec4 sample carries alpha through (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Polar Coords (forward, texture mode) — RGBA sample assertion`)
  let polarTexOk = true
  const refGLSL = polarCoordsNode.glsl(g)
  if (!/vec4 node_polar_nnn445_color = texture\(u_pass0_tex, node_polar_nnn445_polar\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 texture() sample (no .rgb). Got:\n    ${refGLSL}`)
    polarTexOk = false
  }
  const irOut = polarCoordsNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_polar_nnn445_color = texture\(u_pass0_tex, node_polar_nnn445_polar\);/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected full vec4 sample. Got:\n    ${irGLSL}`)
    polarTexOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_polar_nnn445_color: vec4f = textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, node_polar_nnn445_polar\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f sample. Got:\n    ${irWGSL}`)
    polarTexOk = false
  }
  if (polarTexOk) {
    console.log('  [PASS] polar_coords (texture mode): color output is full RGBA sample (vec4/vec4f), alpha carried')
    passed++
  } else {
    failed++
  }
}

// 41. Polar Coords (inverse)
{
  const [g, i] = ctx({
    nodeId: 'polar-ooo555',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      centerX: 'u_polar_ooo555_centerX',
      centerY: 'u_polar_ooo555_centerY',
    },
    outputs: { color: 'node_polar_ooo555_color', polar: 'node_polar_ooo555_polar' },
    params: { mode: 'inverse', centerX: 0.5, centerY: 0.5 },
  })
  verify('Polar Coords (inverse)', polarCoordsNode, g, i)
}

// 42. Dither / Pixel Grid (circle shape)
{
  const [g, i] = ctx({
    nodeId: 'dith-ppp666',
    inputs: {
      color: 'node_noise_xyz_color',
      pixelSize: 'u_dith_ppp666_pixelSize',
      dither: 'u_dith_ppp666_dither',
    },
    outputs: { result: 'node_dith_ppp666_result' },
    params: { pixelSize: 8, shape: 'circle', threshold: 1.0, dither: 0.5 },
  })
  verify('Dither (circle)', ditherNode, g, i, 'loose')
}

// 43. Dither / Pixel Grid (square shape)
{
  const [g, i] = ctx({
    nodeId: 'dith-qqq777',
    inputs: {
      color: 'node_noise_xyz_color',
      pixelSize: 'u_dith_qqq777_pixelSize',
      dither: 'u_dith_qqq777_dither',
    },
    outputs: { result: 'node_dith_qqq777_result' },
    params: { pixelSize: 8, shape: 'square', threshold: 1.0, dither: 0.5 },
  })
  verify('Dither (square)', ditherNode, g, i, 'loose')

  // RGBA assertion — Spatial: mask multiplies the full vec4 color, alpha included
  // (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Dither (square) — RGBA mask-multiply assertion`)
  let dithOk = true
  const refGLSL = ditherNode.glsl(g)
  if (!/vec4 node_dith_qqq777_result = node_noise_xyz_color \* pg_m_dith_qqq777;/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 mask-multiply assignment (masks alpha too). Got:\n    ${refGLSL}`)
    dithOk = false
  }
  const irOut = ditherNode.ir!(i)
  const irGLSL = lowerNodeOutputToGLSL(irOut).join('\n')
  if (!/vec4 node_dith_qqq777_result = node_noise_xyz_color \* pg_m_dith_qqq777;/.test(irGLSL)) {
    console.log(`  [FAIL] IR->GLSL: expected vec4 mask-multiply assignment. Got:\n    ${irGLSL}`)
    dithOk = false
  }
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_dith_qqq777_result: vec4f = \(node_noise_xyz_color \* pg_m_dith_qqq777\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f mask-multiply assignment. Got:\n    ${irWGSL}`)
    dithOk = false
  }
  if (dithOk) {
    console.log('  [PASS] dither: color/result are RGBA (vec4/vec4f), mask multiplies alpha too')
    passed++
  } else {
    failed++
  }
}

// 44. Reeded Glass (straight, vertical, non-texture)
{
  const [g, i] = ctx({
    nodeId: 'reed-rrr888',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      ribWidth: 'u_reed_rrr888_ribWidth',
      ior: 'u_reed_rrr888_ior',
      curvature: 'u_reed_rrr888_curvature',
      frost: 'u_reed_rrr888_frost',
      srt_scaleX: 'u_reed_rrr888_srt_scaleX',
      srt_scaleY: 'u_reed_rrr888_srt_scaleY',
      srt_rotate: 'u_reed_rrr888_srt_rotate',
      srt_translateX: 'u_reed_rrr888_srt_translateX',
      srt_translateY: 'u_reed_rrr888_srt_translateY',
    },
    outputs: { color: 'node_reed_rrr888_color', coords: 'node_reed_rrr888_coords' },
    params: {
      direction: 'vertical', ribType: 'straight',
      ribWidth: 80, ior: 1.5, curvature: 0.8, frost: 0,
      srt_scaleX: 1, srt_scaleY: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
    },
  })
  verify('Reeded Glass (straight, non-texture)', reededGlassNode, g, i, 'loose')
}

// 44b. Reeded Glass (straight, vertical, texture mode) — RGBA sample/accumulate assertion
{
  const [g, i] = ctx({
    nodeId: 'reed-rrr889',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      ribWidth: 'u_reed_rrr889_ribWidth',
      ior: 'u_reed_rrr889_ior',
      curvature: 'u_reed_rrr889_curvature',
      frost: 'u_reed_rrr889_frost',
      srt_scaleX: 'u_reed_rrr889_srt_scaleX',
      srt_scaleY: 'u_reed_rrr889_srt_scaleY',
      srt_rotate: 'u_reed_rrr889_srt_rotate',
      srt_translateX: 'u_reed_rrr889_srt_translateX',
      srt_translateY: 'u_reed_rrr889_srt_translateY',
    },
    outputs: { color: 'node_reed_rrr889_color', coords: 'node_reed_rrr889_coords' },
    params: {
      direction: 'vertical', ribType: 'straight',
      ribWidth: 80, ior: 1.5, curvature: 0.8, frost: 0,
      srt_scaleX: 1, srt_scaleY: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
    },
    textureSamplers: { source: 'u_pass0_tex' },
  })
  verify('Reeded Glass (straight, texture mode)', reededGlassNode, g, i, 'loose')

  // RGBA assertion — Spatial: both the frost-blur accumulation loop and the plain sample
  // widen to full vec4 (both branches are emitted unconditionally; frost is a runtime
  // uniform, not a compile-time branch) — alpha rides with the pixel (see rgba-node-audit.md).
  testNum++
  console.log(`\n  ${testNum}. Reeded Glass (texture mode) — RGBA sample/accumulate assertion`)
  let reedTexOk = true
  const refGLSL = reededGlassNode.glsl(g)
  if (!/vec4 node_reed_rrr889_color;/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 color declaration. Got:\n    ${refGLSL}`)
    reedTexOk = false
  }
  if (!/vec4 rg_acc_reed_rrr889 = vec4\(0\.0\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected vec4 frost accumulator. Got:\n    ${refGLSL}`)
    reedTexOk = false
  }
  if (!/rg_acc_reed_rrr889 \+= texture\(u_pass0_tex, rg_sampleUV_reed_rrr889 \+ rg_jit_reed_rrr889\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 accumulation sample (no .rgb). Got:\n    ${refGLSL}`)
    reedTexOk = false
  }
  if (!/node_reed_rrr889_color = texture\(u_pass0_tex, rg_sampleUV_reed_rrr889\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected full vec4 plain sample (no .rgb). Got:\n    ${refGLSL}`)
    reedTexOk = false
  }
  const irOut = reededGlassNode.ir!(i)
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_reed_rrr889_color: vec4f;/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f color declaration. Got:\n    ${irWGSL}`)
    reedTexOk = false
  }
  if (!/var rg_acc_reed_rrr889: vec4f = vec4f\(0\.0\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected vec4f frost accumulator. Got:\n    ${irWGSL}`)
    reedTexOk = false
  }
  if (!/rg_acc_reed_rrr889 \+= textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, rg_sampleUV_reed_rrr889 \+ rg_jit_reed_rrr889\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f accumulation sample. Got:\n    ${irWGSL}`)
    reedTexOk = false
  }
  if (!/node_reed_rrr889_color = textureSample\(u_pass0_tex_tex, u_pass0_tex_samp, rg_sampleUV_reed_rrr889\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected full vec4f plain sample. Got:\n    ${irWGSL}`)
    reedTexOk = false
  }
  if (reedTexOk) {
    console.log('  [PASS] reeded_glass (texture mode): color output is full RGBA sample/accumulate (vec4/vec4f), alpha carried')
    passed++
  } else {
    failed++
  }
}

// 45. Reeded Glass (wave, sine, non-texture)
{
  const [g, i] = ctx({
    nodeId: 'reed-sss999',
    inputs: {
      source: 'node_noise_xyz_color',
      coords: 'node_uv_aaa_uv',
      ribWidth: 'u_reed_sss999_ribWidth',
      ior: 'u_reed_sss999_ior',
      curvature: 'u_reed_sss999_curvature',
      frost: 'u_reed_sss999_frost',
      amplitude: 'u_reed_sss999_amplitude',
      frequency: 'u_reed_sss999_frequency',
      srt_scaleX: 'u_reed_sss999_srt_scaleX',
      srt_scaleY: 'u_reed_sss999_srt_scaleY',
      srt_rotate: 'u_reed_sss999_srt_rotate',
      srt_translateX: 'u_reed_sss999_srt_translateX',
      srt_translateY: 'u_reed_sss999_srt_translateY',
    },
    outputs: { color: 'node_reed_sss999_color', coords: 'node_reed_sss999_coords' },
    params: {
      direction: 'vertical', ribType: 'wave', waveShape: 'sine',
      ribWidth: 80, ior: 1.5, curvature: 0.8, frost: 0, amplitude: 0.3, frequency: 4.0,
      srt_scaleX: 1, srt_scaleY: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
    },
  })
  verify('Reeded Glass (wave sine, non-texture)', reededGlassNode, g, i, 'loose')
}

// 46. Image (no image data — non-texture path)
{
  const [g, i] = ctx({
    nodeId: 'img-ttt000',
    inputs: {
      coords: 'node_uv_aaa_uv',
      srt_scaleX: 'u_img_ttt000_srt_scaleX',
      srt_scaleY: 'u_img_ttt000_srt_scaleY',
      srt_rotate: 'u_img_ttt000_srt_rotate',
      srt_translateX: 'u_img_ttt000_srt_translateX',
      srt_translateY: 'u_img_ttt000_srt_translateY',
    },
    outputs: { color: 'node_img_ttt000_color', alpha: 'node_img_ttt000_alpha' },
    params: { imageData: 0, imageName: 0, imageAspect: 1, fitMode: 'contain',
      srt_scaleX: 1, srt_scaleY: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
    },
  })
  verify('Image (no data)', imageNode, g, i, 'loose')

  // RGBA assertion — `color` output port migrated to `color` (vec4); no-image
  // placeholder path is opaque (a=1.0). Separate `alpha` float output is unchanged.
  testNum++
  console.log(`\n  ${testNum}. Image (no data) — RGBA output assertion`)
  let imgNoDataOk = true
  const refGLSL = imageNode.glsl(g)
  if (!/vec4 node_img_ttt000_color = vec4\(vec3\(0\.5\), 1\.0\);/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected opaque vec4 placeholder. Got:\n    ${refGLSL}`)
    imgNoDataOk = false
  }
  if (!/float node_img_ttt000_alpha = 1\.0;/.test(refGLSL)) {
    console.log(`  [FAIL] GLSL: alpha output port regressed. Got:\n    ${refGLSL}`)
    imgNoDataOk = false
  }
  const irOut = imageNode.ir!(i)
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!/var node_img_ttt000_color: vec4f = vec4f\(vec3f\(0\.5\), 1\.0\);/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected opaque vec4f placeholder. Got:\n    ${irWGSL}`)
    imgNoDataOk = false
  }
  if (!/var node_img_ttt000_alpha: f32 = 1\.0;/.test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: alpha output port regressed. Got:\n    ${irWGSL}`)
    imgNoDataOk = false
  }
  if (imgNoDataOk) {
    console.log('  [PASS] image (no data): color output is opaque RGBA (vec4/vec4f), alpha port unchanged')
    passed++
  } else {
    failed++
  }
}

// 47. Image (loaded — texture-sample path)
{
  const [g, i] = ctx({
    nodeId: 'img-uuu111',
    inputs: {
      coords: 'node_uv_aaa_uv',
      imageAspect: 'u_img_uuu111_imageAspect',
      srt_scaleX: 'u_img_uuu111_srt_scaleX',
      srt_scaleY: 'u_img_uuu111_srt_scaleY',
      srt_rotate: 'u_img_uuu111_srt_rotate',
      srt_translateX: 'u_img_uuu111_srt_translateX',
      srt_translateY: 'u_img_uuu111_srt_translateY',
    },
    outputs: { color: 'node_img_uuu111_color', alpha: 'node_img_uuu111_alpha' },
    params: { imageData: 1, imageName: 1, imageAspect: 1.5, fitMode: 'contain',
      srt_scaleX: 1, srt_scaleY: 1, srt_rotate: 0, srt_translateX: 0, srt_translateY: 0,
    },
    imageSamplers: new Set<string>(),
  })
  verify('Image (loaded, contain fit)', imageNode, g, i, 'loose')

  // RGBA assertion — loaded path combines sampled rgb + alpha into the RGBA `color`
  // output; separate `alpha` float output stays a passthrough of the same sample's `.a`.
  testNum++
  console.log(`\n  ${testNum}. Image (loaded) — RGBA output assertion`)
  let imgLoadedOk = true
  const refGLSL = imageNode.glsl(g)
  const sampleVar = 'node_img_uuu111_sample'
  if (!new RegExp(`vec4 node_img_uuu111_color = vec4\\(${sampleVar}\\.rgb, ${sampleVar}\\.a\\);`).test(refGLSL)) {
    console.log(`  [FAIL] GLSL: expected color output to combine sampled rgb+alpha. Got:\n    ${refGLSL}`)
    imgLoadedOk = false
  }
  if (!new RegExp(`float node_img_uuu111_alpha = ${sampleVar}\\.a;`).test(refGLSL)) {
    console.log(`  [FAIL] GLSL: alpha output port regressed. Got:\n    ${refGLSL}`)
    imgLoadedOk = false
  }
  const irOut = imageNode.ir!(i)
  const irWGSL = lowerNodeOutputToWGSL(irOut).join('\n')
  if (!new RegExp(`let node_img_uuu111_color: vec4f = vec4f\\(${sampleVar}\\.rgb, ${sampleVar}\\.a\\);`).test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: expected color output to combine sampled rgb+alpha. Got:\n    ${irWGSL}`)
    imgLoadedOk = false
  }
  if (!new RegExp(`let node_img_uuu111_alpha: f32 = ${sampleVar}\\.a;`).test(irWGSL)) {
    console.log(`  [FAIL] IR->WGSL: alpha output port regressed. Got:\n    ${irWGSL}`)
    imgLoadedOk = false
  }
  if (imgLoadedOk) {
    console.log('  [PASS] image (loaded): color output is RGBA (sampled rgb+a), alpha port unchanged')
    passed++
  } else {
    failed++
  }
}

// ===========================================================================
// Regression: color_constant real-codegen-path RGBA check
// ===========================================================================
//
// The `verify()` fixtures above hand-supply `inputs`/`outputs` directly,
// bypassing the real `paramGlslType()`-driven uniform declaration — so they
// did NOT catch a vec4->vec3 mismatch found mid-Task-2 (the `color` param
// uniform is vec4, but color_constant's own codegen assigned it into a
// vec3). This block drives color_constant through the REAL node-graph
// compile path — `generateNodeGlsl` / `generateNodeIR`, the exact functions
// `compileGraph()` / `compileGraphIR()` call per node — so the `color`
// uniform is declared via the real `paramGlslType('color')` (vec4), and
// asserts the node's output declaration stays vec4 end to end on both
// backends. Reverting color_constant to `vec3 x = <vec4 uniform>.rgb` (GLSL)
// or `vec3f` (WGSL) makes this FAIL.
{
  testNum++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${testNum}. REGRESSION: color_constant real-codegen-path (RGBA)`)
  console.log('='.repeat(60))

  const nodeId = 'regress-color-1'
  const sanitizedId = nodeId.replace(/-/g, '_')
  const node: Node<NodeData> = {
    id: nodeId,
    type: 'shaderNode',
    position: { x: 0, y: 0 },
    data: { type: 'color_constant', params: { color: [1.0, 0.0, 1.0, 0.4] } },
  }
  const nodeMap = new Map<string, Node<NodeData>>([[nodeId, node]])
  const edgesByTarget = new Map<string, Edge<EdgeData>[]>()

  let regressionOk = true

  // --- Real GLSL path (generateNodeGlsl — same fn compileGraph() calls) ---
  const glslUserUniforms: UniformSpec[] = []
  const glslResult = generateNodeGlsl(
    nodeId, nodeMap, edgesByTarget,
    new Set<string>(), [], new Map<string, string>(), glslUserUniforms,
  )
  const glslLines = glslResult.glslLines.join('\n')

  if (glslResult.errors.length > 0) {
    console.log(`  [FAIL] generateNodeGlsl errors: ${glslResult.errors.map((e) => e.message).join('; ')}`)
    regressionOk = false
  }

  const glslColorUniform = glslUserUniforms.find((u) => u.paramId === 'color')
  if (glslColorUniform?.glslType !== 'vec4') {
    console.log(`  [FAIL] GLSL: color uniform not declared vec4 via paramGlslType — got: ${glslColorUniform?.glslType}`)
    regressionOk = false
  } else {
    console.log('  [PASS] GLSL: color uniform declared vec4 (real paramGlslType path)')
  }

  const glslAssignRe = new RegExp(`vec4 node_${sanitizedId}_color = u_${sanitizedId}_color;`)
  if (!glslAssignRe.test(glslLines)) {
    console.log(`  [FAIL] GLSL: output assignment is not a plain vec4 passthrough. Got:\n    ${glslLines.trim()}`)
    regressionOk = false
  } else if (/\.rgb\b/.test(glslLines)) {
    console.log(`  [FAIL] GLSL: output still truncates alpha with .rgb: ${glslLines.trim()}`)
    regressionOk = false
  } else {
    console.log('  [PASS] GLSL: output assignment is vec4 (no vec4->vec3 mismatch)')
  }

  // --- Real IR/WGSL path (generateNodeIR — same fn compileGraphIR() calls) ---
  const irUserUniforms: UniformSpec[] = []
  const irResult = generateNodeIR(
    nodeId, nodeMap, edgesByTarget,
    new Set<string>(), irUserUniforms, new Set<string>(),
  )

  if (irResult.errors.length > 0 || !irResult.output) {
    console.log(`  [FAIL] generateNodeIR errors: ${irResult.errors.map((e) => e.message).join('; ')}`)
    regressionOk = false
  } else {
    const irColorUniform = irUserUniforms.find((u) => u.paramId === 'color')
    if (irColorUniform?.glslType !== 'vec4') {
      console.log(`  [FAIL] IR: color uniform not declared vec4 via paramGlslType — got: ${irColorUniform?.glslType}`)
      regressionOk = false
    } else {
      console.log('  [PASS] IR: color uniform declared vec4 (real paramGlslType path)')
    }

    const wgslLines = lowerNodeOutputToWGSL(irResult.output).join('\n')
    const wgslDeclareRe = new RegExp(`var node_${sanitizedId}_color:\\s*vec4f\\s*=\\s*u_${sanitizedId}_color;`)
    if (!wgslDeclareRe.test(wgslLines)) {
      console.log(`  [FAIL] WGSL: declare is not a vec4f passthrough. Got:\n    ${wgslLines.trim()}`)
      regressionOk = false
    } else if (/vec3f/.test(wgslLines)) {
      console.log(`  [FAIL] WGSL: output still declares vec3f: ${wgslLines.trim()}`)
      regressionOk = false
    } else {
      console.log('  [PASS] WGSL: declare is vec4f (no vec4->vec3 mismatch)')
    }
  }

  if (regressionOk) {
    console.log('  [PASS] color_constant real-codegen-path RGBA regression')
    passed++
  } else {
    failed++
  }
}

// ===========================================================================
// Regression: legacy 3-tuple `color` param pads to opaque RGBA (a=1.0)
// ===========================================================================
//
// Saved `.sombra` files from before the RGBA migration store `color` params
// as 3-tuples `[r, g, b]`. `padColorUniformValue()` (glsl-generator.ts) is
// what pads these to `[r, g, b, 1.0]` before upload so a legacy graph still
// renders fully opaque instead of reading a garbage/undefined 4th component.
// This drives `color_constant` with a legacy 3-tuple through the REAL
// node-graph compile path — `generateNodeGlsl` / `generateNodeIR`, the exact
// functions `compileGraph()` / `compileGraphIR()` call per node — and asserts
// the *uploaded uniform value* (not just its declared GLSL type) is a padded
// 4-element array ending in `1.0`. If `padColorUniformValue()` regresses
// (e.g. the `value.length === 3` branch is removed or its `a` fallback
// changes from `1.0` to something else), this test fails because the
// uniform's `value` array stays length-3 or its 4th element isn't `1.0`.
{
  testNum++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${testNum}. REGRESSION: legacy 3-tuple color param pads to opaque (a=1.0)`)
  console.log('='.repeat(60))

  const nodeId = 'regress-color-legacy-1'
  const legacyRgb = [0.2, 0.6, 0.9]
  const node: Node<NodeData> = {
    id: nodeId,
    type: 'shaderNode',
    position: { x: 0, y: 0 },
    data: { type: 'color_constant', params: { color: legacyRgb } }, // legacy 3-tuple, no alpha
  }
  const nodeMap = new Map<string, Node<NodeData>>([[nodeId, node]])
  const edgesByTarget = new Map<string, Edge<EdgeData>[]>()

  let legacyOk = true

  const assertPadded = (label: string, uniform: UniformSpec | undefined) => {
    if (!uniform) {
      console.log(`  [FAIL] ${label}: no "color" uniform found`)
      return false
    }
    if (uniform.glslType !== 'vec4') {
      console.log(`  [FAIL] ${label}: uniform type not vec4 — got: ${uniform.glslType}`)
      return false
    }
    const value = uniform.value
    if (!Array.isArray(value) || value.length !== 4) {
      console.log(`  [FAIL] ${label}: uniform value not padded to 4 components — got: ${JSON.stringify(value)}`)
      return false
    }
    if (value[0] !== legacyRgb[0] || value[1] !== legacyRgb[1] || value[2] !== legacyRgb[2]) {
      console.log(`  [FAIL] ${label}: rgb components mutated during padding — got: ${JSON.stringify(value)}`)
      return false
    }
    if (value[3] !== 1.0) {
      console.log(`  [FAIL] ${label}: alpha not padded to 1.0 — got: ${JSON.stringify(value)}`)
      return false
    }
    console.log(`  [PASS] ${label}: [${legacyRgb.join(', ')}] padded to [${value.join(', ')}] (opaque)`)
    return true
  }

  // --- Real GLSL path ---
  const glslUserUniforms: UniformSpec[] = []
  const glslResult = generateNodeGlsl(
    nodeId, nodeMap, edgesByTarget,
    new Set<string>(), [], new Map<string, string>(), glslUserUniforms,
  )
  if (glslResult.errors.length > 0) {
    console.log(`  [FAIL] generateNodeGlsl errors: ${glslResult.errors.map((e) => e.message).join('; ')}`)
    legacyOk = false
  }
  if (!assertPadded('GLSL', glslUserUniforms.find((u) => u.paramId === 'color'))) legacyOk = false

  // --- Real IR path (same padColorUniformValue() call, ir-compiler.ts) ---
  const irUserUniforms: UniformSpec[] = []
  const irResult = generateNodeIR(
    nodeId, nodeMap, edgesByTarget,
    new Set<string>(), irUserUniforms, new Set<string>(),
  )
  if (irResult.errors.length > 0 || !irResult.output) {
    console.log(`  [FAIL] generateNodeIR errors: ${irResult.errors.map((e) => e.message).join('; ')}`)
    legacyOk = false
  }
  if (!assertPadded('IR', irUserUniforms.find((u) => u.paramId === 'color'))) legacyOk = false

  if (legacyOk) {
    console.log('  [PASS] legacy 3-tuple color param pads to opaque RGBA')
    passed++
  } else {
    failed++
  }
}

// ===========================================================================
// Regression: `color`-output preview/pass fragColor assembly is NOT re-wrapped
// ===========================================================================
//
// `color` is an RGBA (vec4) port type. `outputTypeToFragColor()`
// (glsl-generator.ts) assembles a node's output variable into the fragColor
// assignment used by BOTH per-node preview thumbnails (subgraph-compiler.ts /
// ir-subgraph-compiler.ts) and multi-pass texture-boundary/relay passes
// (glsl-generator.ts / ir-compiler.ts). Since a `color` var is already vec4,
// wrapping it again (`vec4(colorVar, 1.0)` / `vec4f(colorVar, 1.0)`) produces
// an invalid 5-component constructor call that fails to compile on both
// GLSL and WGSL. This drives the REAL preview-compile entry points
// (`compileNodePreview` / `compileNodePreviewIR` — the exact functions the
// app calls for per-node thumbnails) with a single `color_constant` node
// (color-typed output) and asserts the emitted fragColor line is a plain
// passthrough (`fragColor = <var>;` / `return <var>;`), never re-wrapped.
{
  testNum++
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  ${testNum}. REGRESSION: color-output fragColor assembly is not re-wrapped (5-component vec4)`)
  console.log('='.repeat(60))

  const nodeId = 'regress-color-passthrough-1'
  const previewNode: Node<NodeData> = {
    id: nodeId,
    type: 'shaderNode',
    position: { x: 0, y: 0 },
    data: { type: 'color_constant', params: { color: [1.0, 0.0, 1.0, 1.0] } },
  }
  const previewNodes = [previewNode]
  const previewEdges: Edge<EdgeData>[] = []

  let wrapOk = true

  // --- GLSL preview path (compileNodePreview → outputTypeToFragColor) ---
  const glslPreview = compileNodePreview(previewNodes, previewEdges, nodeId)
  if (!glslPreview.success) {
    console.log(`  [FAIL] compileNodePreview errors: ${glslPreview.errors.map((e) => e.message).join('; ')}`)
    wrapOk = false
  } else {
    const fragLine = glslPreview.fragmentShader.split('\n').find((l) => l.includes('fragColor ='))
    if (!fragLine) {
      console.log('  [FAIL] GLSL preview: no fragColor assignment found in fragment shader')
      wrapOk = false
    } else if (/fragColor\s*=\s*vec4\(/.test(fragLine)) {
      console.log(`  [FAIL] GLSL preview: color output re-wrapped in vec4(...) — got: "${fragLine.trim()}"`)
      wrapOk = false
    } else {
      console.log(`  [PASS] GLSL preview: fragColor is a plain passthrough — "${fragLine.trim()}"`)
    }
    // Belt-and-suspenders: no N-ary vec4 construct with more than 4 args anywhere.
    if (/vec4\(\s*[^()]*(?:,\s*[^,()]+){4,}\)/.test(glslPreview.fragmentShader)) {
      console.log('  [FAIL] GLSL preview: found a vec4(...) construct with 5+ arguments')
      wrapOk = false
    }
  }

  // --- IR/WGSL preview path (compileNodePreviewIR → outputTypeToFragColor → WGSL) ---
  const irPreview = compileNodePreviewIR(previewNodes, previewEdges, nodeId)
  if (!irPreview.success) {
    console.log(`  [FAIL] compileNodePreviewIR errors: ${irPreview.errors.map((e) => e.message).join('; ')}`)
    wrapOk = false
  } else {
    const shaderCode = irPreview.wgslPasses.map((p) => p.shaderCode).join('\n')
    // Scope to the fragment entry point only — the vertex stage (vs_main) also
    // has a `return out;` and would give a false pass if matched first.
    const fsMarker = shaderCode.indexOf('fn fs_main')
    const fsBody = fsMarker === -1 ? shaderCode : shaderCode.slice(fsMarker)
    const returnLine = fsBody.split('\n').find((l) => l.includes('return ') && l.includes(';'))
    if (fsMarker === -1) {
      console.log('  [FAIL] WGSL preview: no fs_main fragment entry point found')
      wrapOk = false
    } else if (!returnLine) {
      console.log('  [FAIL] WGSL preview: no fragment return statement found')
      wrapOk = false
    } else if (/return\s+vec4f\(/.test(returnLine)) {
      console.log(`  [FAIL] WGSL preview: color output re-wrapped in vec4f(...) — got: "${returnLine.trim()}"`)
      wrapOk = false
    } else {
      console.log(`  [PASS] WGSL preview: fragment return is a plain passthrough — "${returnLine.trim()}"`)
    }
    if (/vec4f\(\s*[^()]*(?:,\s*[^,()]+){4,}\)/.test(fsBody)) {
      console.log('  [FAIL] WGSL preview: found a vec4f(...) construct with 5+ arguments')
      wrapOk = false
    }
  }

  // --- Multi-pass texture-boundary path: color_constant -> pixelate.source (textureInput) -> fragment_output ---
  // Exercises the OTHER call site of outputTypeToFragColor(): the boundary/relay
  // resolveGroup() helpers in glsl-generator.ts (compileMultiPass) and
  // ir-compiler.ts (compileMultiPassIR), which wrap the source node's output
  // (here color_constant's `color` output) into the intermediate pass's
  // fragColor/return, separately from the single-node preview path above.
  const mpColorId = 'regress-mp-color'
  const mpPixelateId = 'regress-mp-pixelate'
  const mpOutputId = 'regress-mp-output'
  const mpNodes: Node<NodeData>[] = [
    {
      id: mpColorId, type: 'shaderNode', position: { x: 0, y: 0 },
      data: { type: 'color_constant', params: { color: [0.3, 0.6, 0.9, 1.0] } },
    },
    {
      id: mpPixelateId, type: 'shaderNode', position: { x: 200, y: 0 },
      data: { type: 'pixelate', params: { pixelSize: 8 } },
    },
    {
      id: mpOutputId, type: 'shaderNode', position: { x: 400, y: 0 },
      data: { type: 'fragment_output', params: {} },
    },
  ]
  const mpEdges: Edge<EdgeData>[] = [
    {
      id: 'mp-edge-1', source: mpColorId, target: mpPixelateId,
      sourceHandle: 'color', targetHandle: 'source',
      data: { sourcePort: 'color', targetPort: 'source' },
    },
    {
      id: 'mp-edge-2', source: mpPixelateId, target: mpOutputId,
      sourceHandle: 'color', targetHandle: 'color',
      data: { sourcePort: 'color', targetPort: 'color' },
    },
  ]

  const mpGlsl = compileGraph(mpNodes, mpEdges)
  if (!mpGlsl.success || mpGlsl.passes.length < 2) {
    console.log(`  [FAIL] compileGraph (multipass) did not produce a 2+ pass plan: success=${mpGlsl.success}, passes=${mpGlsl.passes.length}, errors=${mpGlsl.errors.map((e) => e.message).join('; ')}`)
    wrapOk = false
  } else {
    const boundaryPass = mpGlsl.passes[0]
    const fragLine = boundaryPass.fragmentShader.split('\n').find((l) => l.includes('fragColor ='))
    if (!fragLine) {
      console.log('  [FAIL] GLSL multipass boundary: no fragColor assignment found')
      wrapOk = false
    } else if (/fragColor\s*=\s*vec4\(/.test(fragLine)) {
      console.log(`  [FAIL] GLSL multipass boundary: color output re-wrapped in vec4(...) — got: "${fragLine.trim()}"`)
      wrapOk = false
    } else {
      console.log(`  [PASS] GLSL multipass boundary: fragColor is a plain passthrough — "${fragLine.trim()}"`)
    }
  }

  const mpIr = compileGraphIR(mpNodes, mpEdges)
  if (!mpIr || mpIr.passes.length < 2) {
    console.log(`  [FAIL] compileGraphIR (multipass) did not produce a 2+ pass plan: passes=${mpIr?.passes.length ?? 0}`)
    wrapOk = false
  } else {
    const boundaryShader = mpIr.passes[0].shaderCode
    const fsMarker = boundaryShader.indexOf('fn fs_main')
    const fsBody = fsMarker === -1 ? boundaryShader : boundaryShader.slice(fsMarker)
    const returnLine = fsBody.split('\n').find((l) => l.includes('return ') && l.includes(';'))
    if (!returnLine) {
      console.log('  [FAIL] WGSL multipass boundary: no fragment return statement found')
      wrapOk = false
    } else if (/return\s+vec4f\(/.test(returnLine)) {
      console.log(`  [FAIL] WGSL multipass boundary: color output re-wrapped in vec4f(...) — got: "${returnLine.trim()}"`)
      wrapOk = false
    } else {
      console.log(`  [PASS] WGSL multipass boundary: fragment return is a plain passthrough — "${returnLine.trim()}"`)
    }
  }

  if (wrapOk) {
    console.log('  [PASS] color-output fragColor/return assembly is a plain passthrough on both backends (preview + multipass boundary)')
    passed++
  } else {
    failed++
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed
console.log(`\n${'='.repeat(60)}`)
console.log(`  SUMMARY: ${passed} passed, ${failed} failed, ${warned} warnings out of ${total} tests`)
console.log('='.repeat(60))

if (failed > 0) {
  process.exit(1)
}
