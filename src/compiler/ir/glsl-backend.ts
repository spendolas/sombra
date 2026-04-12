/**
 * IR → GLSL ES 3.0 lowering backend.
 *
 * Converts IR expressions and statements into GLSL source strings.
 * The output should match what the hand-written glsl() functions produce,
 * so the IR path can be verified against the existing codegen.
 */

import type { IRExpr, IRStmt, IRNodeOutput, IRType, IRFunction, IRSpatialTransform } from './types'

// ---------------------------------------------------------------------------
// Float formatting — must match glsl-generator.ts `safeFloat()`
// ---------------------------------------------------------------------------

function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

// ---------------------------------------------------------------------------
// GLSL type names (identity — GLSL uses the same names as IRType)
// ---------------------------------------------------------------------------

function glslTypeName(t: IRType): string {
  // IRType values map 1:1 to GLSL type names
  return t
}

// ---------------------------------------------------------------------------
// Operator precedence (for minimal parenthesization)
// ---------------------------------------------------------------------------

/** GLSL operator precedence — higher number = tighter binding */
const PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
}

function getPrec(op: string): number {
  return PRECEDENCE[op] ?? 0
}

// ---------------------------------------------------------------------------
// Expression lowering
// ---------------------------------------------------------------------------

/**
 * Lower an IR expression to GLSL.
 * @param expr The expression to lower
 * @param parentPrec The precedence of the parent expression (0 = top-level / no parent)
 * @param isRightOfParent Whether this expr is the right operand of a binary parent
 */
export function lowerExprToGLSL(expr: IRExpr, parentPrec = 0, isRightOfParent = false): string {
  switch (expr.kind) {
    case 'literal': {
      if (typeof expr.value === 'number') {
        return formatFloat(expr.value)
      }
      const args = (expr.value as number[]).map(formatFloat).join(', ')
      return `${glslTypeName(expr.type)}(${args})`
    }

    case 'variable':
      return expr.name

    case 'binary': {
      const myPrec = getPrec(expr.op)
      const left = lowerExprToGLSL(expr.left, myPrec, false)
      const right = lowerExprToGLSL(expr.right, myPrec, true)
      const inner = `${left} ${expr.op} ${right}`
      // Parenthesize when:
      // 1. Our precedence is lower than parent (parent binds tighter)
      // 2. Same precedence AND we're on the right side of a non-commutative op (- or /)
      const needsParens = myPrec < parentPrec
        || (myPrec === parentPrec && isRightOfParent)
      return needsParens ? `(${inner})` : inner
    }

    case 'call': {
      const args = expr.args.map(a => lowerExprToGLSL(a)).join(', ')
      return `${expr.name}(${args})`
    }

    case 'swizzle':
      return `${lowerExprToGLSL(expr.expr)}.${expr.components}`

    case 'construct': {
      const args = expr.args.map(a => lowerExprToGLSL(a)).join(', ')
      return `${glslTypeName(expr.type)}(${args})`
    }

    case 'ternary':
      return `(${lowerExprToGLSL(expr.cond)} ? ${lowerExprToGLSL(expr.ifTrue)} : ${lowerExprToGLSL(expr.ifFalse)})`

    case 'textureSample':
      return `texture(${expr.sampler}, ${lowerExprToGLSL(expr.coords)})`
  }
}

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

export function lowerStmtToGLSL(stmt: IRStmt, indent = ''): string {
  switch (stmt.kind) {
    case 'declare':
      return `${indent}${glslTypeName(stmt.type)} ${stmt.name} = ${lowerExprToGLSL(stmt.value)};`

    case 'assign':
      return `${indent}${stmt.name} = ${lowerExprToGLSL(stmt.value)};`

    case 'raw':
      return stmt.glsl.split('\n').map(l => `${indent}${l}`).join('\n')

    case 'for': {
      const lines: string[] = []
      lines.push(`${indent}for (int ${stmt.iterVar} = ${lowerExprToGLSL(stmt.from)}; ${stmt.iterVar} < ${lowerExprToGLSL(stmt.to)}; ${stmt.iterVar}++) {`)
      if (stmt.earlyBreak) {
        lines.push(`${indent}    if (float(${stmt.iterVar}) >= ${lowerExprToGLSL(stmt.earlyBreak)}) break;`)
      }
      for (const bodyStmt of stmt.body) {
        lines.push(lowerStmtToGLSL(bodyStmt, `${indent}    `))
      }
      lines.push(`${indent}}`)
      return lines.join('\n')
    }
  }
}

// ---------------------------------------------------------------------------
// Function declaration lowering
// ---------------------------------------------------------------------------

export function lowerFunctionToGLSL(fn: IRFunction): string {
  const params = fn.params.map(p => `${glslTypeName(p.type)} ${p.name}`).join(', ')
  const bodyLines = fn.body.map(s => lowerStmtToGLSL(s, '  '))
  return `${glslTypeName(fn.returnType)} ${fn.name}(${params}) {\n${bodyLines.join('\n')}\n}`
}

// ---------------------------------------------------------------------------
// Spatial transform lowering (SRT preamble)
// ---------------------------------------------------------------------------

export function lowerSpatialTransformToGLSL(srt: IRSpatialTransform): string[] {
  const lines: string[] = []
  const v = srt.outputVar

  lines.push(`vec2 ${v} = ${srt.coordsVar} - u_anchor;`)

  // Scale
  if (srt.scaleUniform) {
    lines.push(`${v} /= vec2(${srt.scaleUniform});`)
  } else if (srt.scaleXUniform && srt.scaleYUniform) {
    lines.push(`${v} /= vec2(${srt.scaleXUniform}, ${srt.scaleYUniform});`)
  }

  // Rotate (aspect-corrected)
  if (srt.rotateUniform) {
    const asp = `${v}_asp`
    const rad = `${v}_rad`
    const c = `${v}_c`
    const s = `${v}_s`
    lines.push(`float ${asp} = u_resolution.x / u_resolution.y;`)
    lines.push(`float ${rad} = ${srt.rotateUniform} * 0.01745329;`)
    lines.push(`float ${c} = cos(${rad}); float ${s} = sin(${rad});`)
    lines.push(`${v}.x *= ${asp};`)
    lines.push(`${v} = vec2(${v}.x * ${c} - ${v}.y * ${s}, ${v}.x * ${s} + ${v}.y * ${c});`)
    lines.push(`${v}.x /= ${asp};`)
  }

  // Translate
  if (srt.translateXUniform && srt.translateYUniform) {
    lines.push(`${v} -= vec2(${srt.translateXUniform}, -(${srt.translateYUniform})) / (u_dpr * u_ref_size);`)
  }

  lines.push(`${v} += u_anchor;`)
  return lines
}

// ---------------------------------------------------------------------------
// Node output lowering — produces array of GLSL lines
// ---------------------------------------------------------------------------

export function lowerNodeOutputToGLSL(output: IRNodeOutput): string[] {
  const lines: string[] = []

  // Spatial transform preamble
  if (output.spatialTransform) {
    lines.push(...lowerSpatialTransformToGLSL(output.spatialTransform))
  }

  // Main statements
  for (const stmt of output.statements) {
    lines.push(lowerStmtToGLSL(stmt))
  }

  return lines
}

// ---------------------------------------------------------------------------
// Function list lowering — produces all shared function declarations
// ---------------------------------------------------------------------------

export function lowerFunctionsToGLSL(functions: IRFunction[]): string[] {
  // Deduplicate by key (same key = same function, emit once)
  const seen = new Set<string>()
  const result: string[] = []
  for (const fn of functions) {
    if (seen.has(fn.key)) continue
    seen.add(fn.key)
    result.push(lowerFunctionToGLSL(fn))
  }
  return result
}
