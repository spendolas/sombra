/**
 * The IR's control-flow constructs, on both backends and on real GPUs.
 *
 * Why this exists: the IR had no `if` statement at all — only `ternary` for expressions — so
 * any node with a multi-statement branch chain had to fall back to `raw()` text written
 * separately per backend. That is how `reeded-glass.ts` reached 38 `raw()` against 10
 * structured builders: its core is a four-way chain (frost / minification / seam-split /
 * single-tap) that the IR could not express. `forLoop` existed with `earlyBreak` and a
 * comment saying "used by FBM octave loops", and no node had ever constructed one.
 *
 * Three levels of check, because the weaker ones pass on broken output:
 *   1. structure — an else-if chain must lower FLAT, not as nested `else { if ... }`
 *   2. compiles  — the lowered source must actually build on its backend; a string
 *                  assertion cannot tell valid GLSL from a syntax error
 *   3. agrees    — the same IR must produce the same pixels through both backends, which
 *                  is the whole point of having an IR
 *
 * Run: npx tsx scripts/verify-ir-control-flow.ts
 */
import { test, run, assert } from './blur-bakeoff/lib/test-util'
import { createRig } from './blur-bakeoff/lib/gpu-rig'
import {
  ifStmt, forLoop, declare, assign, binary, variable, literal, call, construct,
} from '../src/compiler/ir/types'
import type { IRStmt } from '../src/compiler/ir/types'
import { lowerStmtToGLSL } from '../src/compiler/ir/glsl-backend'
import { lowerStmtToWGSL } from '../src/compiler/ir/wgsl-backend'

const glsl = (s: IRStmt) => lowerStmtToGLSL(s, '')
const wgsl = (s: IRStmt) => lowerStmtToWGSL(s, '')

// ---------------------------------------------------------------------------
// 1. Structure
// ---------------------------------------------------------------------------

test('a single-branch if lowers to a plain if on both backends', () => {
  const s = ifStmt([{ cond: binary('>', variable('t'), literal('float', 0.5), 'bool'),
                      body: [assign('c', literal('float', 1.0))] }])
  assert(/^if \(+t > 0\.5\)+ \{/.test(glsl(s)), `GLSL: ${glsl(s)}`)
  assert(/^if \(+t > 0\.5\)+ \{/.test(wgsl(s)), `WGSL: ${wgsl(s)}`)
  assert(!glsl(s).includes('else'), 'no else expected')
  assert(!wgsl(s).includes('else'), 'no else expected')
})

test('an else-if chain lowers FLAT, not as nested else { if }', () => {
  const s = ifStmt(
    [
      { cond: binary('>', variable('t'), literal('float', 0.9), 'bool'), body: [assign('c', literal('float', 3.0))] },
      { cond: binary('>', variable('t'), literal('float', 0.5), 'bool'), body: [assign('c', literal('float', 2.0))] },
      { cond: binary('>', variable('t'), literal('float', 0.1), 'bool'), body: [assign('c', literal('float', 1.0))] },
    ],
    [assign('c', literal('float', 0.0))],
  )
  for (const [name, out] of [['GLSL', glsl(s)], ['WGSL', wgsl(s)]] as const) {
    // Two `else if` and exactly one bare `else`. A nested lowering would produce
    // three `else {` and increasing indentation instead.
    const elseIfs = (out.match(/else if \(/g) || []).length
    assert(elseIfs === 2, `${name}: expected 2 "else if", got ${elseIfs}\n${out}`)
    assert(/\}\s*else \{/.test(out), `${name}: expected a final bare else\n${out}`)
    assert(!/else \{\s*if \(/.test(out), `${name}: chain nested instead of flattening\n${out}`)
  }
})

test('an if nested in a for loop indents its body correctly', () => {
  const s = forLoop('i', literal('int', 0), literal('int', 4),
    [ifStmt([{ cond: binary('<', variable('i'), literal('int', 2), 'bool'),
               body: [assign('acc', binary('+', variable('acc'), literal('float', 1.0), 'float'))] }])],
    literal('float', 4.0))
  for (const [name, out] of [['GLSL', glsl(s)], ['WGSL', wgsl(s)]] as const) {
    const lines = out.split('\n')
    const ifLine = lines.find((l) => /^if \(+i </.test(l.trimStart()))
    assert(!!ifLine, `${name}: no nested if found\n${out}`)
    const ind = ifLine!.length - ifLine!.trimStart().length
    assert(ind >= 4, `${name}: nested if indented ${ind}, expected >= 4\n${out}`)
    const bodyLine = lines.find((l) => l.includes('acc = '))
    const bodyInd = bodyLine!.length - bodyLine!.trimStart().length
    assert(bodyInd > ind, `${name}: if body not indented past the if\n${out}`)
  }
})

test('forLoop is reachable as a structured builder at all', () => {
  // The construct existed for months with zero node call sites. This asserts it lowers,
  // so a future reader knows it is live rather than decorative.
  const s = forLoop('k', literal('int', 0), literal('int', 3), [assign('acc', variable('acc'))])
  assert(glsl(s).startsWith('for (int k = 0'), `GLSL: ${glsl(s)}`)
  assert(wgsl(s).startsWith('for (var k: i32 = 0'), `WGSL: ${wgsl(s)}`)
})

// ---------------------------------------------------------------------------
// 2 + 3. Compiles on real GPUs, and both backends agree
// ---------------------------------------------------------------------------

/** An if-chain that maps v_uv.x into four bands. Same IR, lowered per backend. */
function bandStmts(): IRStmt[] {
  const t = variable('t')
  return [
    declare('band', 'float', literal('float', 0.0)),
    ifStmt(
      [
        { cond: binary('>', t, literal('float', 0.75), 'bool'), body: [assign('band', literal('float', 1.0))] },
        { cond: binary('>', t, literal('float', 0.50), 'bool'), body: [assign('band', literal('float', 0.6))] },
        { cond: binary('>', t, literal('float', 0.25), 'bool'), body: [assign('band', literal('float', 0.3))] },
      ],
      [assign('band', literal('float', 0.0))],
    ),
    // A loop whose body branches — the combination reeded-glass actually needs.
    declare('acc', 'float', literal('float', 0.0)),
    forLoop('i', literal('int', 0), literal('int', 8),
      [ifStmt([{ cond: binary('>', call('float', [variable('i')], 'float'), binary('*', t, literal('float', 8.0), 'float'), 'bool'),
                 body: [assign('acc', binary('+', variable('acc'), literal('float', 0.125), 'float'))] }])],
      literal('float', 8.0)),
  ]
}

const rig = await createRig()
const anyBackend = rig.available.webgpu || rig.available.webgl2
test('at least one backend is available (a skipped run is a failure, not a pass)', () => {
  assert(anyBackend, 'neither WebGPU nor WebGL2 available — this gate proved nothing')
})

const captures: Record<string, { data: Uint8Array; width: number; height: number }> = {}
const captureErrors: Record<string, string> = {}

// Captured EAGERLY at top level, not inside test(): `test()` only registers a callback and
// `run()` executes them, so awaiting the rig inside a test and closing it below would close
// the browser before any test had run.
for (const backend of ['webgpu', 'webgl2'] as const) {
  if (!rig.available[backend]) {
    console.log(`  [SKIP] ${backend} unavailable`)
    continue
  }
  const lower = backend === 'webgpu' ? wgsl : glsl
  const decl = backend === 'webgpu' ? 'let t = uv.x;' : 'float t = uv.x;'
  const v4 = backend === 'webgpu' ? 'vec4f' : 'vec4'
  const body = [decl, ...bandStmts().map((st) => lower(st)), `return ${v4}(band, acc, 0.0, 1.0);`].join('\n')
  try {
    captures[backend] = await rig.capture({ backend, width: 64, height: 64, passes: [{ body }] })
  } catch (e) {
    captureErrors[backend] = e instanceof Error ? e.message : String(e)
  }
}
await rig.close()

for (const backend of ['webgpu', 'webgl2'] as const) {
  if (!rig.available[backend]) continue
  test(`${backend}: the lowered if-chain and loop COMPILE and render`, () => {
    assert(!captureErrors[backend], `${backend} failed to compile/render: ${captureErrors[backend]}`)
    const img = captures[backend]
    let lit = 0
    for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4] > 0) lit++
    // The three bands cover 3/4 of the frame. A blank render means no branch ever took.
    assert(lit > img.width * img.height * 0.5,
      `${backend}: only ${lit} of ${img.width * img.height} px lit — branches did not execute`)
  })
}

test('both backends produce identical pixels from the same IR', () => {
  // Both backends REQUIRED here. Returning early on a missing backend would let this
  // pass while proving nothing — the same vacuity the guardrails warn about.
  assert(!!captures.webgpu && !!captures.webgl2,
    `cross-backend check needs both: webgpu=${!!captures.webgpu} webgl2=${!!captures.webgl2}`)
  const a = captures.webgpu, b = captures.webgl2
  let max = 0
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i] - b.data[i]))
  assert(max <= 1, `backends diverged by ${max} codes on the same IR — the point of an IR is that they cannot`)
})

await run('ir-control-flow')
