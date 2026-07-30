/**
 * The pyramid blur emits per-backend shader text from ONE source (`emit()`, gated by a
 * `wgsl` flag), wrapped as a single-emitter `raw(emit('glsl'), emit('wgsl'))`. The GPU shape
 * gate (verify-pyramid-blur-gpu.ts) measures only the GLSL width, because the raw-capture rig
 * is WebGL. This closes the WGSL side WITHOUT a GPU, by proving the two texts cannot differ
 * numerically: the `wgsl` flag swaps only SYNTAX (vec4↔vec4f, textureLod↔textureSampleLevel,
 * ternary↔select, gl_FragCoord↔in.position, decl form) — every tap offset, kernel weight,
 * divisor, srcFactor and dpr scale is interpolated into BOTH strings by the same code path.
 *
 * For every radius (N=0..3) and every sub-pass, this emits the ACTUAL node text on both
 * backends and asserts:
 *   1. the two variants really ARE glsl vs wgsl (structural markers present) — no vacuous
 *      "identical text" pass;
 *   2. their NUMERIC-LITERAL multisets are exactly equal — so the WGSL blur has the same tap
 *      geometry and weights as the GLSL blur whose width is GPU-verified. WGSL width therefore
 *      equals GLSL width by construction.
 * The only backend-divergent SEMANTIC element left is the fragCoord y-orientation, which is a
 * registration/orientation question (visually confirmed on live WebGPU), orthogonal to width.
 *
 * Run: npx tsx scripts/verify-blur-backend-parity.ts
 */
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import type { GLSLContext } from '../src/nodes/types'
import type { IRContext, IRRawCode } from '../src/compiler/ir/types'
import { pyramidPlan } from '../src/nodes/effect/pyramid-blur'
import { test, run, assert } from './blur-bakeoff/lib/test-util'

initializeNodeLibrary()
const blur = nodeRegistry.get('pyramid_blur')
if (!blur || !blur.ir) throw new Error('blur node or its ir() missing')

/** All numeric literals in shader text: floats (with a decimal, incl. sci-notation), NOT the
 *  digits inside identifiers/type names (vec4f, b_uv_x). toPrecision/toFixed always emit a
 *  decimal point, so every tap offset/weight/divisor is a float literal and is captured. */
function numericLiterals(src: string): string[] {
  const m = src.match(/(?<![A-Za-z0-9_.])\d+\.\d+(?:e[+-]?\d+)?/g) ?? []
  // Normalise so 0.5 and 0.500000000 compare equal (both backends format identically anyway,
  // but this makes the assertion about VALUE, not spelling).
  return m.map((s) => String(parseFloat(s))).sort()
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// nodeId without digits, so variable-name digits can't pollute the literal scan.
const NODE_ID = 'blur_parity_test'
const SAMPLER = 'u_tex_blur_parity_test'

function emitBoth(radius: number, subPass: number): { glsl: string; wgsl: string } {
  const inputs = { source: 'v_source_in' }
  const outputs = { color: 'v_blur_out' }
  const params = { radius, __subPass: subPass }

  const glslCtx: GLSLContext = {
    nodeId: NODE_ID, inputs, outputs, params,
    uniforms: new Set(), functions: [], functionRegistry: new Map(),
    textureSamplers: { source: SAMPLER },
  }
  const glsl = blur.glsl(glslCtx)

  const irCtx: IRContext = {
    nodeId: NODE_ID, inputs, outputs, params,
    textureSamplers: { source: SAMPLER },
  }
  const irOut = blur.ir!(irCtx)
  const rawStmt = irOut.statements.find((s): s is IRRawCode => s.kind === 'raw')
  if (!rawStmt) throw new Error(`r${radius} p${subPass}: ir() produced no raw statement`)
  if (rawStmt.wgsl == null) throw new Error(`r${radius} p${subPass}: raw statement has no wgsl arm (would fall to mechanical translation)`)
  return { glsl, wgsl: rawStmt.wgsl }
}

// Radii spanning N=0,1,2,3 (N = clamp(floor(log2((r/3)/4)),0,5)); include the cap.
const RADII = [6, 12, 24, 48, 96, 128]

for (const radius of RADII) {
  const plan = pyramidPlan(radius)
  test(`r${radius} (N=${plan.N}, ${plan.passes.length} passes): WGSL and GLSL numeric geometry identical`, () => {
    for (let i = 0; i < plan.passes.length; i++) {
      const { glsl, wgsl } = emitBoth(radius, i)
      const role = plan.passes[i].role

      // (1) Prove these are genuinely the two different backends — else the numeric-equality
      // check below is vacuous (comparing a string to itself).
      assert(glsl.includes('gl_FragCoord') && !glsl.includes('in.position'),
        `r${radius} p${i} (${role}): glsl arm missing gl_FragCoord`)
      assert(wgsl.includes('in.position') && !wgsl.includes('gl_FragCoord'),
        `r${radius} p${i} (${role}): wgsl arm missing in.position (not the WGSL variant?)`)
      assert(wgsl.includes('vec4f') && !/\bvec4\(/.test(wgsl),
        `r${radius} p${i} (${role}): wgsl arm not using vec4f`)
      assert(/\btextureSampleLevel\b/.test(wgsl) && /\btextureLod\b/.test(glsl),
        `r${radius} p${i} (${role}): sampler intrinsics not the per-backend forms`)

      // (2) The load-bearing assertion: same tap offsets, weights, divisors on both backends.
      const gNums = numericLiterals(glsl)
      const wNums = numericLiterals(wgsl)
      assert(gNums.length >= 5,
        `r${radius} p${i} (${role}): only ${gNums.length} numeric literals found — scan likely broken`)
      assert(eq(gNums, wNums),
        `r${radius} p${i} (${role}): numeric literals DIFFER between backends\n` +
        `      glsl(${gNums.length}): ${gNums.join(',')}\n` +
        `      wgsl(${wNums.length}): ${wNums.join(',')}`)
    }
  })
}

await run('blur-backend-parity')
