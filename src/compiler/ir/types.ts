/**
 * Shader IR (Intermediate Representation) for the WebGPU migration.
 *
 * The IR is a typed AST representing shader operations without committing
 * to GLSL or WGSL syntax. Each node's `ir()` function produces an IRNodeOutput,
 * which is then lowered to the target language by a backend.
 *
 * Phase 1a: covers trivial nodes (function calls, swizzles, arithmetic).
 * Phase 1b: adds IRFunction (shared functions), IRForLoop, IRSpatialTransform, IRTextureSample.
 */

// ---------------------------------------------------------------------------
// Type system
// ---------------------------------------------------------------------------

export type IRType = 'float' | 'vec2' | 'vec3' | 'vec4' | 'int' | 'bool' | 'sampler2D'

// ---------------------------------------------------------------------------
// Expressions (discriminated union on `kind`)
// ---------------------------------------------------------------------------

export interface IRLiteral {
  readonly kind: 'literal'
  readonly type: IRType
  readonly value: number | number[]
}

export interface IRVariable {
  readonly kind: 'variable'
  readonly name: string
  readonly type?: IRType
}

export interface IRBinaryOp {
  readonly kind: 'binary'
  readonly op: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||'
  readonly left: IRExpr
  readonly right: IRExpr
  readonly type: IRType
}

export interface IRCall {
  readonly kind: 'call'
  readonly name: string
  readonly args: IRExpr[]
  readonly type: IRType
}

export interface IRSwizzle {
  readonly kind: 'swizzle'
  readonly expr: IRExpr
  readonly components: string  // e.g. 'x', 'xy', 'rgb', 'xyzw'
  readonly type: IRType
}

export interface IRConstruct {
  readonly kind: 'construct'
  readonly type: IRType
  readonly args: IRExpr[]
}

export interface IRTernary {
  readonly kind: 'ternary'
  readonly cond: IRExpr
  readonly ifTrue: IRExpr
  readonly ifFalse: IRExpr
  readonly type: IRType
}

/** Texture sampling — GLSL: texture(sampler, coords), WGSL: textureSample(tex, sampler, coords) */
export interface IRTextureSample {
  readonly kind: 'textureSample'
  readonly sampler: string   // sampler uniform name (e.g. "u_pass0_tex", "u_image_abc")
  readonly coords: IRExpr    // UV coordinates
  readonly type: IRType      // return type (typically 'vec4')
}

export type IRExpr =
  | IRLiteral
  | IRVariable
  | IRBinaryOp
  | IRCall
  | IRSwizzle
  | IRConstruct
  | IRTernary
  | IRTextureSample

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface IRDeclare {
  readonly kind: 'declare'
  readonly name: string
  readonly type: IRType
  readonly value: IRExpr
}

export interface IRAssign {
  readonly kind: 'assign'
  readonly name: string
  readonly value: IRExpr
}

/** For loop with optional early break — used by FBM octave loops */
export interface IRForLoop {
  readonly kind: 'for'
  readonly iterVar: string
  readonly from: IRExpr
  readonly to: IRExpr        // may be a literal (baked octave count) or variable
  readonly body: IRStmt[]
  readonly earlyBreak?: IRExpr  // condition for `if (cond) break;`
}

/**
 * Raw code escape hatch — for complex helper function bodies (noise, HSV, bayer)
 * where decomposing every line into IR nodes adds no value.
 * The GLSL backend emits `glsl` as-is; the WGSL backend emits `wgsl` (or transforms `glsl`).
 */
export interface IRRawCode {
  readonly kind: 'raw'
  readonly glsl: string
  readonly wgsl?: string  // explicit WGSL override; if absent, backend does mechanical translation
}

export type IRStmt = IRDeclare | IRAssign | IRForLoop | IRRawCode

// ---------------------------------------------------------------------------
// Uniform declarations
// ---------------------------------------------------------------------------

export interface IRUniform {
  readonly name: string
  readonly type: IRType
  readonly updateMode: 'recompile' | 'uniform'
}

// ---------------------------------------------------------------------------
// Shared function declarations (emitted outside main)
// ---------------------------------------------------------------------------

/** A shared helper function (noise, HSV, bayer, etc.) registered with dedup key. */
export interface IRFunction {
  /** Content-addressed dedup key (e.g. "snoise3d_01", "fbm_standard_simplex") */
  readonly key: string
  /** Function name in generated code */
  readonly name: string
  /** Function parameters */
  readonly params: ReadonlyArray<{ readonly name: string; readonly type: IRType }>
  /** Return type */
  readonly returnType: IRType
  /** Function body as IR statements */
  readonly body: IRStmt[]
}

// ---------------------------------------------------------------------------
// Spatial transform (SRT framework preamble)
// ---------------------------------------------------------------------------

/** Framework-managed coordinate transform emitted before node statements. */
export interface IRSpatialTransform {
  /** Input coords variable name */
  readonly coordsVar: string
  /** Output transformed coords variable name */
  readonly outputVar: string
  /** Scale uniform name (if scale transform enabled) */
  readonly scaleUniform?: string
  /** Scale X uniform name (if non-uniform scale enabled) */
  readonly scaleXUniform?: string
  /** Scale Y uniform name (if non-uniform scale enabled) */
  readonly scaleYUniform?: string
  /** Rotate uniform name (if rotate transform enabled) */
  readonly rotateUniform?: string
  /** Translate X uniform name (if translate enabled) */
  readonly translateXUniform?: string
  /** Translate Y uniform name (if translate enabled) */
  readonly translateYUniform?: string
}

// ---------------------------------------------------------------------------
// Node output bundle — what a single node contributes to the shader
// ---------------------------------------------------------------------------

export interface IRNodeOutput {
  /** Statements this node adds to main() */
  readonly statements: IRStmt[]
  /** Uniform declarations this node requires */
  readonly uniforms: IRUniform[]
  /** Built-in uniform names needed (e.g. 'u_time', 'u_resolution') */
  readonly standardUniforms: Set<string>
  /** Shared functions to register (deduplicated by key). Phase 1b+. */
  readonly functions?: IRFunction[]
  /** Spatial coordinate transform preamble. Phase 1b+. */
  readonly spatialTransform?: IRSpatialTransform
}

// ---------------------------------------------------------------------------
// IR context — passed to node ir() functions
// ---------------------------------------------------------------------------

/**
 * Context for IR code generation. Similar to GLSLContext but produces
 * IR nodes instead of GLSL strings.
 *
 * inputs/outputs contain GLSL-style variable names (e.g. "node_abc_value").
 * The ir() function wraps them in IRVariable nodes. This keeps the
 * variable naming convention in the compiler, not in the IR.
 */
export interface IRContext {
  /** Unique node instance ID (React Flow ID) */
  readonly nodeId: string
  /** Input port/param IDs → resolved variable names */
  readonly inputs: Record<string, string>
  /** Output port IDs → output variable names */
  readonly outputs: Record<string, string>
  /** Current parameter values */
  readonly params: Record<string, unknown>
  /**
   * portId → sampler2D uniform name for multi-pass texture inputs.
   * Mirrors GLSLContext.textureSamplers. Present when the node's textureInput
   * port is wired and the compiler has allocated an FBO pass boundary.
   * The sampler name (e.g. "u_pass0_tex") is used with textureSample() IR nodes.
   */
  readonly textureSamplers?: Record<string, string>
  /**
   * Set of image sampler2D uniform names (for Image nodes).
   * Mirrors GLSLContext.imageSamplers.
   */
  readonly imageSamplers?: Set<string>
}

// ---------------------------------------------------------------------------
// Builder helpers — ergonomic IR construction
// ---------------------------------------------------------------------------

export function literal(type: IRType, value: number | number[]): IRLiteral {
  return { kind: 'literal', type, value }
}

export function variable(name: string, type?: IRType): IRVariable {
  return { kind: 'variable', name, type }
}

export function binary(op: IRBinaryOp['op'], left: IRExpr, right: IRExpr, type: IRType): IRBinaryOp {
  return { kind: 'binary', op, left, right, type }
}

export function call(name: string, args: IRExpr[], type: IRType): IRCall {
  return { kind: 'call', name, args, type }
}

export function swizzle(expr: IRExpr, components: string, type: IRType): IRSwizzle {
  return { kind: 'swizzle', expr, components, type }
}

export function construct(type: IRType, args: IRExpr[]): IRConstruct {
  return { kind: 'construct', type, args }
}

export function ternary(cond: IRExpr, ifTrue: IRExpr, ifFalse: IRExpr, type: IRType): IRTernary {
  return { kind: 'ternary', cond, ifTrue, ifFalse, type }
}

export function declare(name: string, type: IRType, value: IRExpr): IRDeclare {
  return { kind: 'declare', name, type, value }
}

export function assign(name: string, value: IRExpr): IRAssign {
  return { kind: 'assign', name, value }
}

export function forLoop(
  iterVar: string,
  from: IRExpr,
  to: IRExpr,
  body: IRStmt[],
  earlyBreak?: IRExpr,
): IRForLoop {
  return { kind: 'for', iterVar, from, to, body, earlyBreak }
}

export function textureSample(sampler: string, coords: IRExpr, type: IRType = 'vec4'): IRTextureSample {
  return { kind: 'textureSample', sampler, coords, type }
}

export function raw(glsl: string, wgsl?: string): IRRawCode {
  return { kind: 'raw', glsl, wgsl }
}
