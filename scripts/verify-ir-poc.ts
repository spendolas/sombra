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

function makeIRContext(overrides: IRContext): IRContext {
  return overrides
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
  { pattern: /[^\/]\?[^?].*:(?!:)/, msg: 'Possible GLSL ternary (? :) — should be select()' },
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
    inputs: { color: 'node_mix_abc_result' },
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
    params: { color: [1.0, 0.0, 1.0] },
  })
  verify('Color Constant', colorConstantNode, g, i)
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
}

// 32. Color Ramp (smooth, 2 stops)
{
  const stops = [
    { position: 0.0, color: [0, 0, 0] },
    { position: 1.0, color: [1, 1, 1] },
  ]
  const [g, i] = ctx({
    nodeId: 'ramp-fff666',
    inputs: { t: 'node_grad_aaa_value' },
    outputs: { color: 'node_ramp_fff666_color' },
    params: { interpolation: 'smooth', stops },
  })
  verify('Color Ramp (smooth)', colorRampNode, g, i, 'loose')
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
