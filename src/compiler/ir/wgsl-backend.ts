/**
 * IR → WGSL lowering backend.
 *
 * Converts IR expressions and statements into WGSL source strings.
 * Key differences from GLSL:
 *   - Type names: float→f32, vec2→vec2f, vec3→vec3f, vec4→vec4f, int→i32
 *   - Declarations: `float x = expr;` → `let x: f32 = expr;`
 *   - Constructors: `vec3(a, b, c)` → `vec3f(a, b, c)`
 *   - Ternary: `c ? t : f` → `select(f, t, c)`
 *   - Most math builtins (mix, clamp, sin, cos, etc.) are identical.
 */

import type { IRExpr, IRStmt, IRNodeOutput, IRType, IRFunction, IRSpatialTransform } from './types'

// ---------------------------------------------------------------------------
// Float formatting
// ---------------------------------------------------------------------------

function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

// ---------------------------------------------------------------------------
// WGSL type names
// ---------------------------------------------------------------------------

const WGSL_TYPE_MAP: Record<IRType, string> = {
  float: 'f32',
  vec2: 'vec2f',
  vec3: 'vec3f',
  vec4: 'vec4f',
  int: 'i32',
  bool: 'bool',
  sampler2D: 'texture_2d<f32>',
}

function wgslTypeName(t: IRType): string {
  return WGSL_TYPE_MAP[t] ?? t
}

/** WGSL constructor name (used for type constructors like vec3f(...)). */
function wgslConstructorName(t: IRType): string {
  return WGSL_TYPE_MAP[t] ?? t
}

// ---------------------------------------------------------------------------
// Mechanical GLSL → WGSL translation (for raw code blocks)
// ---------------------------------------------------------------------------

/**
 * Mechanical GLSL → WGSL translation for raw code blocks.
 * Handles type names, variable declarations, const syntax, and for-loop init.
 * NOT a full transpiler — only for well-structured helper functions.
 */
function mechanicalGlslToWgsl(glsl: string): string {
  // Process line-by-line for declaration rewrites
  const lines = glsl.split('\n')
  const result = lines.map(line => {
    let l = line

    // --- Issue 1: const TYPE NAME = ... → const NAME: TYPE = ... ---
    // Must run BEFORE type replacement so we match GLSL type names
    l = l.replace(
      /\bconst\s+(float|int|uint|vec[234]|uvec[234]|ivec[23]|mat[234]|bool)\s+(\w+)\s*=/,
      (_m, type: string, name: string) => `const ${name}: ${glslTypeToWgsl(type)} =`,
    )

    // --- Issue 3: for (TYPE NAME = ...) → for (var NAME: TYPE = ...) ---
    // Match for-loop init declarations
    l = l.replace(
      /\bfor\s*\(\s*(float|int|uint|vec[234]|uvec[234]|ivec[23])\s+(\w+)\s*=/,
      (_m, type: string, name: string) => `for (var ${name}: ${glslTypeToWgsl(type)} =`,
    )

    // --- Issue 2a: bare TYPE NAME = ... → var NAME: TYPE = ... ---
    // Match variable declarations at line start (with optional leading whitespace)
    // Must NOT match: const, for, return, if, else, or already-converted lines
    l = l.replace(
      /^(\s*)(float|int|uint|vec[234]|uvec[234]|ivec[23]|mat[234]|bool)\s+(\w+)\s*=/,
      (_m, indent: string, type: string, name: string) => `${indent}var ${name}: ${glslTypeToWgsl(type)} =`,
    )

    // --- Issue 2b: bare TYPE NAME; → var NAME: TYPE; (uninitialized) ---
    // Same as 2a but for declarations without initializer (e.g. `vec3 color;`)
    l = l.replace(
      /^(\s*)(float|int|uint|vec[234]|uvec[234]|ivec[23]|mat[234]|bool)\s+(\w+)\s*;/,
      (_m, indent: string, type: string, name: string) => `${indent}var ${name}: ${glslTypeToWgsl(type)};`,
    )

    // --- GLSL builtins with no WGSL equivalent ---
    l = l.replace(/\bfloatBitsToUint\b/g, 'bitcast<u32>')
    l = l.replace(/\buintBitsToFloat\b/g, 'bitcast<f32>')

    // --- mod() → sombra_mod() (WGSL has no mod function; % has different sign semantics) ---
    l = l.replace(/\bmod\(/g, 'sombra_mod(')

    // --- texture(sampler, coords) → textureSample(sampler_tex, sampler_samp, coords) ---
    l = l.replace(/\btexture\(\s*(\w+)\s*,/g, 'textureSample($1_tex, $1_samp,')

    // --- Type name replacements (for remaining uses: constructors, casts, etc.) ---
    // Unsigned types must come before their signed counterparts to avoid partial matches
    l = l.replace(/\buvec2\b/g, 'vec2<u32>')
    l = l.replace(/\buvec3\b/g, 'vec3<u32>')
    l = l.replace(/\buvec4\b/g, 'vec4<u32>')
    l = l.replace(/\buint\b/g, 'u32')
    l = l.replace(/\bfloat\b/g, 'f32')
    l = l.replace(/\bint\b/g, 'i32')
    l = l.replace(/\bvec2\b(?!<)/g, 'vec2f')
    l = l.replace(/\bvec3\b(?!<)/g, 'vec3f')
    l = l.replace(/\bvec4\b(?!<)/g, 'vec4f')
    l = l.replace(/\bivec2\b/g, 'vec2i')
    l = l.replace(/\bivec3\b/g, 'vec3i')
    l = l.replace(/\bmat2\b/g, 'mat2x2f')
    l = l.replace(/\bmat3\b/g, 'mat3x3f')
    l = l.replace(/\bmat4\b/g, 'mat4x4f')

    // --- Ternary operator: a ? b : c → select(c, b, a) ---
    // Handle simple ternaries (no nested ternaries). Match the pattern greedily
    // but correctly by finding the ? and : at the same nesting level.
    l = rewriteTernaries(l)

    return l
  })

  // Post-passes: WGSL requires braces on all control flow bodies.
  let code = result.join('\n')
  code = wrapBracelessForLoops(code)
  code = wrapBracelessIfStatements(code)
  return code
}

/**
 * Wrap braceless `for (...)` statements in `{}`.
 * Handles nested braceless loops like `for (z) for (y) for (x) { ... }`.
 */
function wrapBracelessForLoops(code: string): string {
  const lines = code.split('\n')
  const out: string[] = []
  let pendingCloses = 0

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd()

    // Detect a for-loop line that doesn't open a brace
    if (/^\s*for\s*\(.*\)\s*$/.test(trimmed)) {
      out.push(trimmed + ' {')
      pendingCloses++
    } else {
      out.push(lines[i])

      // When we see a `}` that closes the innermost braced block,
      // emit closing braces for all pending braceless loops.
      if (pendingCloses > 0 && /^\s*\}\s*$/.test(trimmed)) {
        const indent = trimmed.match(/^(\s*)/)?.[1] ?? ''
        while (pendingCloses > 0) {
          out.push(indent + '}')
          pendingCloses--
        }
      }
    }
  }
  return out.join('\n')
}

/**
 * Wrap braceless `if (cond) stmt;` into `if (cond) { stmt; }`.
 * WGSL requires braces on all if/else bodies.
 * Uses paren-counting to find the end of the condition (handles nested parens).
 */
function wrapBracelessIfStatements(code: string): string {
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)if\s*\(/)
    if (!match) continue

    const indent = match[1]
    const line = lines[i]
    // Find the matching ')' for the condition
    const condStart = line.indexOf('(', match[0].length - 1)
    let depth = 0
    let condEnd = -1
    for (let j = condStart; j < line.length; j++) {
      if (line[j] === '(') depth++
      else if (line[j] === ')') { depth--; if (depth === 0) { condEnd = j; break } }
    }
    if (condEnd === -1) continue

    // Check what follows the condition
    const after = line.substring(condEnd + 1).trimStart()
    if (after === '' || after === '{' || after.startsWith('{ ')) continue // already has brace or multi-line

    // Braceless single-line if — wrap body in braces
    const condition = line.substring(indent.length, condEnd + 1)
    lines[i] = `${indent}${condition} { ${after} }`
  }
  return lines.join('\n')
}

/**
 * Rewrite GLSL ternary expressions (`cond ? ifTrue : ifFalse`) to WGSL `select(ifFalse, ifTrue, cond)`.
 * Handles multiple ternaries per line and respects parenthesis nesting.
 * Works iteratively from right-to-left to handle cases where ternaries appear in sequence.
 */
function rewriteTernaries(line: string): string {
  // Keep rewriting until no more ternaries remain
  let result = line
  let safety = 20 // prevent infinite loops
  while (result.includes('?') && safety-- > 0) {
    const rewritten = rewriteOneTernary(result)
    if (rewritten === result) break // no more ternaries to rewrite
    result = rewritten
  }
  return result
}

/**
 * Find and rewrite the rightmost ternary operator in a line.
 * Working right-to-left avoids issues with nested ternaries.
 */
function rewriteOneTernary(line: string): string {
  // Find the rightmost '?' that is a ternary operator (not inside a string)
  let qIdx = -1
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] === '?') {
      qIdx = i
      break
    }
  }
  if (qIdx < 0) return line

  // Find the matching ':' after '?' at the same paren nesting level
  let colonIdx = -1
  let depth = 0
  for (let i = qIdx + 1; i < line.length; i++) {
    if (line[i] === '(') depth++
    else if (line[i] === ')') depth--
    else if (line[i] === ':' && depth === 0) {
      colonIdx = i
      break
    }
  }
  if (colonIdx < 0) return line // no matching colon — not a ternary

  // Extract condition (everything before '?' up to a natural boundary)
  // Walk left from '?' to find the start of the condition expression
  const condEnd = qIdx
  const condStart = findExprStart(line, condEnd - 1)

  // Extract ifTrue (between '?' and ':')
  const ifTrue = line.substring(qIdx + 1, colonIdx).trim()

  // Extract ifFalse (after ':' to end of expression)
  const ifFalseStart = colonIdx + 1
  const ifFalseEnd = findExprEnd(line, ifFalseStart)
  const ifFalse = line.substring(ifFalseStart, ifFalseEnd).trim()

  const cond = line.substring(condStart, condEnd).trim()

  // Build select(ifFalse, ifTrue, cond)
  const prefix = line.substring(0, condStart)
  const needsSpace = condStart > 0 && !/\s$/.test(prefix)
  const replacement = `${needsSpace ? ' ' : ''}select(${ifFalse}, ${ifTrue}, ${cond})`

  return prefix + replacement + line.substring(ifFalseEnd)
}

/** Walk left to find the start of a condition expression before '?'. */
function findExprStart(line: string, pos: number): number {
  let depth = 0
  let i = pos
  // Skip trailing whitespace
  while (i >= 0 && line[i] === ' ') i--
  // Walk backwards through the expression
  for (; i >= 0; i--) {
    const ch = line[i]
    if (ch === ')') depth++
    else if (ch === '(') {
      if (depth === 0) return i + 1 // hit an unmatched open paren — expression starts after it
      depth--
    } else if (depth === 0) {
      // Stop at statement-level delimiters
      if (ch === '=' && i > 0 && line[i - 1] !== '!' && line[i - 1] !== '<' && line[i - 1] !== '>') {
        // Assignment or comparison — check if it's ==
        if (i > 0 && line[i - 1] === '=') continue // part of ==
        return i + 1
      }
      if (ch === ',' || ch === ';') return i + 1
    }
  }
  return 0
}

/** Walk right to find the end of an expression after ':'. */
function findExprEnd(line: string, pos: number): number {
  let depth = 0
  let i = pos
  // Skip leading whitespace
  while (i < line.length && line[i] === ' ') i++
  for (; i < line.length; i++) {
    const ch = line[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) return i // hit an unmatched close paren — expression ends before it
      depth--
    } else if (depth === 0) {
      if (ch === ',' || ch === ';') return i
    }
  }
  return line.length
}

/** Map a GLSL type name to its WGSL equivalent (used during mechanical translation). */
function glslTypeToWgsl(glslType: string): string {
  const map: Record<string, string> = {
    float: 'f32', int: 'i32', uint: 'u32', bool: 'bool',
    vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f',
    uvec2: 'vec2<u32>', uvec3: 'vec3<u32>', uvec4: 'vec4<u32>',
    ivec2: 'vec2i', ivec3: 'vec3i',
    mat2: 'mat2x2f', mat3: 'mat3x3f', mat4: 'mat4x4f',
  }
  return map[glslType] ?? glslType
}

/**
 * Map to store WGSL-disambiguated function names for overloaded GLSL functions.
 * Key: original GLSL name, Value: map of dedup key → WGSL name.
 */
const WGSL_OVERLOAD_NAMES: Record<string, Record<string, string>> = {
  mod289: {
    mod289_vec3: 'mod289_v3',
    mod289_vec4: 'mod289_v4',
  },
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

export function lowerExprToWGSL(expr: IRExpr): string {
  switch (expr.kind) {
    case 'literal': {
      if (typeof expr.value === 'number') {
        return formatFloat(expr.value)
      }
      // Vector literal: vec3f(1.0, 0.0, 0.0)
      const args = (expr.value as number[]).map(formatFloat).join(', ')
      return `${wgslConstructorName(expr.type)}(${args})`
    }

    case 'variable':
      return expr.name

    case 'binary':
      return `(${lowerExprToWGSL(expr.left)} ${expr.op} ${lowerExprToWGSL(expr.right)})`

    case 'call': {
      // WGSL builtin name differences
      let fnName = expr.name
      if (fnName === 'mod') fnName = 'sombra_mod'
      if (fnName === 'atan' && expr.args.length === 2) fnName = 'atan2'

      // WGSL builtins like clamp/min/max/mix/smoothstep require matching types.
      // Promote scalar literal args to vector constructors when return type is vector.
      const vecReturnType = expr.type === 'vec2' || expr.type === 'vec3' || expr.type === 'vec4'
      const PROMOTE_BUILTINS = new Set(['clamp', 'min', 'max', 'mix', 'smoothstep', 'step'])
      if (vecReturnType && PROMOTE_BUILTINS.has(expr.name)) {
        const ctor = wgslConstructorName(expr.type)
        const promoted = expr.args.map(a => {
          if (a.kind === 'literal' && a.type === 'float') return `${ctor}(${lowerExprToWGSL(a)})`
          return lowerExprToWGSL(a)
        })
        return `${fnName}(${promoted.join(', ')})`
      }

      const args = expr.args.map(lowerExprToWGSL).join(', ')
      return `${fnName}(${args})`
    }

    case 'swizzle':
      return `${lowerExprToWGSL(expr.expr)}.${expr.components}`

    case 'construct': {
      const args = expr.args.map(lowerExprToWGSL).join(', ')
      return `${wgslConstructorName(expr.type)}(${args})`
    }

    case 'ternary':
      // WGSL uses select(falseVal, trueVal, condition)
      return `select(${lowerExprToWGSL(expr.ifFalse)}, ${lowerExprToWGSL(expr.ifTrue)}, ${lowerExprToWGSL(expr.cond)})`

    case 'textureSample':
      // WGSL separates texture and sampler objects
      return `textureSample(${expr.sampler}_tex, ${expr.sampler}_samp, ${lowerExprToWGSL(expr.coords)})`
  }
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

export function lowerStmtToWGSL(stmt: IRStmt, indent = ''): string {
  switch (stmt.kind) {
    case 'declare':
      // Use `var` — WGSL `let` is immutable, but IR doesn't track mutability.
      // Variables may be reassigned by later IRAssign statements (e.g., Color Ramp loops).
      return `${indent}var ${stmt.name}: ${wgslTypeName(stmt.type)} = ${lowerExprToWGSL(stmt.value)};`

    case 'assign':
      return `${indent}${stmt.name} = ${lowerExprToWGSL(stmt.value)};`

    case 'raw':
      // Use explicit WGSL if provided, otherwise do mechanical type replacement
      if (stmt.wgsl) return stmt.wgsl.split('\n').map(l => `${indent}${l}`).join('\n')
      return mechanicalGlslToWgsl(stmt.glsl).split('\n').map(l => `${indent}${l}`).join('\n')

    case 'for': {
      const lines: string[] = []
      lines.push(`${indent}for (var ${stmt.iterVar}: i32 = ${lowerExprToWGSL(stmt.from)}; ${stmt.iterVar} < ${lowerExprToWGSL(stmt.to)}; ${stmt.iterVar}++) {`)
      if (stmt.earlyBreak) {
        lines.push(`${indent}    if (f32(${stmt.iterVar}) >= ${lowerExprToWGSL(stmt.earlyBreak)}) { break; }`)
      }
      for (const bodyStmt of stmt.body) {
        lines.push(lowerStmtToWGSL(bodyStmt, `${indent}    `))
      }
      lines.push(`${indent}}`)
      return lines.join('\n')
    }
  }
}

// ---------------------------------------------------------------------------
// Function declaration lowering
// ---------------------------------------------------------------------------

export function lowerFunctionToWGSL(fn: IRFunction): string {
  // Issue 4: Disambiguate overloaded function names for WGSL
  const wgslName = resolveWgslFunctionName(fn.name, fn.key)
  let bodyCode = fn.body.map(s => lowerStmtToWGSL(s, '  ')).join('\n')
  // Rename call sites within the body for overloaded functions
  bodyCode = applyWgslOverloadRenames(bodyCode)

  // Detect mutated parameters: WGSL function params are immutable (let).
  // If the body assigns to a parameter, rename it to `name_in` in the signature
  // and insert `var name = name_in;` at the top.
  const mutatedParams = fn.params.filter(p => {
    // Check for `p = ...`, `p +=`, `p -=`, `p *=`, `p.x = ...` etc.
    const re = new RegExp(`\\b${p.name}\\s*[+\\-*\\/]?=`)
    return re.test(bodyCode)
  })
  let paramsCode: string
  if (mutatedParams.length > 0) {
    paramsCode = fn.params.map(p => {
      const isMutated = mutatedParams.includes(p)
      return `${isMutated ? p.name + '_in' : p.name}: ${wgslTypeName(p.type)}`
    }).join(', ')
    // Insert var copies for mutated params at the top of the body
    const copies = mutatedParams.map(p =>
      `  var ${p.name}: ${wgslTypeName(p.type)} = ${p.name}_in;`
    ).join('\n')
    bodyCode = copies + '\n' + bodyCode
  } else {
    paramsCode = fn.params.map(p => `${p.name}: ${wgslTypeName(p.type)}`).join(', ')
  }

  return `fn ${wgslName}(${paramsCode}) -> ${wgslTypeName(fn.returnType)} {\n${bodyCode}\n}`
}

/** Resolve the WGSL-safe function name for potentially overloaded GLSL functions. */
function resolveWgslFunctionName(glslName: string, dedupKey: string): string {
  const overloads = WGSL_OVERLOAD_NAMES[glslName]
  if (overloads && overloads[dedupKey]) return overloads[dedupKey]
  return glslName
}

/**
 * Replace overloaded GLSL function calls in a WGSL body with disambiguated names.
 * E.g., `mod289(someVec3f)` → `mod289_v3(someVec3f)` if the arg is vec3f-typed.
 *
 * For simplex noise, mod289 is called with vec3 args in snoise3d (which operates on vec3)
 * and with vec4 args in permute. We detect by the function context:
 * - In snoise3d body: `mod289(i)` where `i` is vec3f → `mod289_v3(i)`
 * - In permute body: `mod289(...)` where arg is vec4 → `mod289_v4(...)`
 *
 * Pragmatic approach: replace `mod289(` with a version that checks context.
 * Since the permute function only takes vec4 and snoise3d uses mod289 with vec3,
 * we use a simple heuristic: the function signatures make the types unambiguous.
 * For now, we use explicit per-function WGSL overrides for affected functions.
 */
function applyWgslOverloadRenames(wgsl: string): string {
  // Replace mod289 calls based on the dedup key context
  // This is applied to the body text after lowering, so it sees the WGSL-translated code
  // The snoise3d body calls mod289 on a vec3f arg: `i = mod289(i)` → `i = mod289_v3(i)`
  // The permute body calls mod289 on a vec4f expression → `mod289_v4(...)`
  // Since we can't easily type-check in string replacement, we provide explicit WGSL
  // overrides on the IRRawCode nodes for functions that call overloaded functions.
  return wgsl
}

// ---------------------------------------------------------------------------
// Spatial transform lowering (SRT preamble)
// ---------------------------------------------------------------------------

export function lowerSpatialTransformToWGSL(srt: IRSpatialTransform): string[] {
  const lines: string[] = []
  const v = srt.outputVar

  lines.push(`var ${v}: vec2f = ${srt.coordsVar} - vec2f(0.5);`)

  // Scale
  if (srt.scaleUniform) {
    lines.push(`${v} /= vec2f(${srt.scaleUniform});`)
  } else if (srt.scaleXUniform && srt.scaleYUniform) {
    lines.push(`${v} /= vec2f(${srt.scaleXUniform}, ${srt.scaleYUniform});`)
  }

  // Rotate (aspect-corrected)
  if (srt.rotateUniform) {
    const asp = `${v}_asp`
    const rad = `${v}_rad`
    const c = `${v}_c`
    const s = `${v}_s`
    lines.push(`let ${asp}: f32 = u_resolution.x / u_resolution.y;`)
    lines.push(`let ${rad}: f32 = ${srt.rotateUniform} * 0.01745329;`)
    lines.push(`let ${c}: f32 = cos(${rad}); let ${s}: f32 = sin(${rad});`)
    lines.push(`${v}.x *= ${asp};`)
    lines.push(`${v} = vec2f(${v}.x * ${c} - ${v}.y * ${s}, ${v}.x * ${s} + ${v}.y * ${c});`)
    lines.push(`${v}.x /= ${asp};`)
  }

  // Translate
  if (srt.translateXUniform && srt.translateYUniform) {
    lines.push(`${v} -= vec2f(${srt.translateXUniform}, -(${srt.translateYUniform})) / (u_dpr * u_ref_size);`)
  }

  lines.push(`${v} += vec2f(0.5);`)
  return lines
}

// ---------------------------------------------------------------------------
// Node output lowering — produces array of WGSL lines
// ---------------------------------------------------------------------------

export function lowerNodeOutputToWGSL(output: IRNodeOutput): string[] {
  const lines: string[] = []

  // Spatial transform preamble
  if (output.spatialTransform) {
    lines.push(...lowerSpatialTransformToWGSL(output.spatialTransform))
  }

  // Main statements
  for (const stmt of output.statements) {
    lines.push(lowerStmtToWGSL(stmt))
  }

  return lines
}

// ---------------------------------------------------------------------------
// Function list lowering
// ---------------------------------------------------------------------------

export function lowerFunctionsToWGSL(functions: IRFunction[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const fn of functions) {
    if (seen.has(fn.key)) continue
    seen.add(fn.key)
    result.push(lowerFunctionToWGSL(fn))
  }
  return result
}
