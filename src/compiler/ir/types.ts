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

/**
 * Texture sampling — GLSL `texture(sampler, coords)`, WGSL `textureSample(tex, samp, coords)`.
 *
 * Set `level` to sample at an explicit LOD: GLSL `textureLod`, WGSL `textureSampleLevel`.
 * That is REQUIRED inside any branch whose condition varies per fragment, because WGSL
 * forbids implicit-derivative sampling under non-uniform control flow. Violating it is
 * silent and total — `createRenderPipeline` does not throw on an already-invalid module, so
 * the renderer reports compile SUCCESS and then the invalid pipeline invalidates the whole
 * command buffer at draw time, dropping every frame including the pass's `loadOp: 'clear'`.
 * The graph keeps working on WebGL2, which has no uniformity rule, so it looks
 * backend-specific rather than like a shader error. See commit b56c19c.
 *
 * These render targets have no mips, so level 0 is the only level.
 */
export interface IRTextureSample {
  readonly kind: 'textureSample'
  readonly sampler: string   // sampler uniform name (e.g. "u_pass0_tex", "u_image_abc")
  readonly coords: IRExpr    // UV coordinates
  readonly type: IRType      // return type (typically 'vec4')
  readonly level?: IRExpr    // explicit LOD — mandatory under non-uniform control flow
}

export type IRExpr =
  | IRLiteral
  | IRVariable
  | IRBinaryOp
  | IRCall
  | IRSwizzle
  | IRConstruct
  | IRTernary
  | IRTextureSample | IRFragCoord | IRFramebufferY

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
 * The fragment's pixel coordinate.
 *
 * The two languages disagree on the Y origin: GLSL's `gl_FragCoord` is y-UP (origin
 * bottom-left) while WGSL's `in.position` is y-DOWN (origin top-left). The WGSL assembler
 * rewrites the NAME textually but cannot fix the orientation, so every node needing this had
 * to hand-write both arms — and getting it wrong is silent. The audit records a vertically
 * mirrored distortion field that shipped on WebGPU only.
 *
 * `space: 'yDown'` gives top-left-origin pixels on BOTH backends — the orientation Sombra's
 * pattern space and `auto_uv` use. `space: 'native'` gives each backend's own framebuffer
 * orientation, which is what you want when the result indexes a texture that was itself
 * rendered in that orientation (sampling your own fragment must be the identity).
 *
 * `'yDown'` needs `u_resolution` on the GLSL side — declare it as a standard uniform.
 */
export interface IRFragCoord {
  readonly kind: 'fragCoord'
  readonly space: 'yDown' | 'native'
}

/**
 * Reorient a vector onto the backend's framebuffer Y axis.
 *
 * A displacement computed in some pattern basis cannot be added to a native framebuffer
 * coordinate directly, because GLSL's framebuffer Y runs up and WGSL's runs down. `from`
 * states which basis the input is already in, and the lowering negates Y only on the backend
 * whose framebuffer disagrees with it.
 *
 * Both directions are real and both occur in this codebase: `auto_uv` works in a y-DOWN
 * pattern space, while reeded-glass's seam normals and sub-sample deltas are y-UP. Getting the
 * direction backwards is silent and mirrors the effect vertically on one backend only — the
 * audit records exactly that shipping in `warp`. Passing `from` explicitly is what makes the
 * choice reviewable instead of implied.
 */
export interface IRFramebufferY {
  readonly kind: 'framebufferY'
  readonly expr: IRExpr
  /** The Y orientation the input vector is already expressed in. */
  readonly from: 'yUp' | 'yDown'
}

/** One arm of an if / else-if chain. */
export interface IRIfBranch {
  readonly cond: IRExpr        // must evaluate to bool in both languages
  readonly body: IRStmt[]
}

/**
 * Conditional STATEMENT — an if / else-if chain with an optional else.
 *
 * `ternary` only covers conditional expressions, so before this existed a node with a
 * multi-statement branch had no choice but `raw()` text written once per backend. That is
 * the direct cause of `reeded-glass.ts` carrying 38 `raw()` calls against 10 structured
 * builders: its core is a four-way chain (frost / minification / seam-split / single-tap)
 * the IR could not represent.
 *
 * Branches are held as a flat list rather than nesting an if inside the previous `else`,
 * because both backends have native `else if` and a nested representation would force each
 * lowering to special-case "an else containing exactly one if" to avoid emitting a staircase.
 * One branch and no `fallback` is a plain `if`.
 *
 * WGSL caveat: a texture fetch inside a branch whose condition is NOT uniform across the
 * quad is illegal — `textureSample` must be called from uniform control flow. Use
 * `textureSampleLevel` (explicit LOD) inside a branch driven by a connectable/varying value.
 * Getting this wrong does not fail loudly: the pipeline is created without error and then
 * drops every frame at draw time. See `docs/research/` and commit b56c19c.
 */
export interface IRIfStmt {
  readonly kind: 'if'
  readonly branches: readonly IRIfBranch[]   // at least one
  readonly fallback?: IRStmt[]               // the trailing `else` block
}

/**
 * Raw code escape hatch — for complex helper function bodies (noise, HSV, bayer)
 * where decomposing every line into IR nodes adds no value.
 * The GLSL backend emits `glsl` as-is; the WGSL backend emits `wgsl` (or transforms `glsl`).
 *
 * The two-argument form hands a different literal to each backend and skips mechanical
 * translation entirely, so the two arms drift by construction. It is budgeted and ratcheted
 * — see `npm run verify:raw-budget` and the Guardrails section of CLAUDE.md. Prefer adding
 * an IR construct over reaching for it.
 */
export interface IRRawCode {
  readonly kind: 'raw'
  readonly glsl: string
  readonly wgsl?: string  // explicit WGSL override; if absent, backend does mechanical translation
}

export type IRStmt = IRDeclare | IRAssign | IRForLoop | IRIfStmt | IRRawCode

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
  /** True when compiling for a node mini-preview thumbnail (fixed 80×80, centre
   *  anchor). Nodes may render a canonical, placement-independent view — e.g. the
   *  gradient shows itself centred + fitted rather than at its pinned position. */
  readonly isPreview?: boolean
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

/**
 * if / else-if / else statement. `branches` must hold at least one arm; pass `fallback` for
 * the trailing `else`. Both backends emit a flat chain — see IRIfStmt.
 */
export function ifStmt(branches: IRIfBranch[], fallback?: IRStmt[]): IRIfStmt {
  if (branches.length === 0) throw new Error('ifStmt() needs at least one branch')
  return { kind: 'if', branches, fallback }
}

export function fragCoord(space: 'yDown' | 'native' = 'yDown'): IRFragCoord {
  return { kind: 'fragCoord', space }
}

export function framebufferY(expr: IRExpr, from: 'yUp' | 'yDown'): IRFramebufferY {
  return { kind: 'framebufferY', expr, from }
}

export function textureSample(
  sampler: string, coords: IRExpr, type: IRType = 'vec4', level?: IRExpr,
): IRTextureSample {
  return { kind: 'textureSample', sampler, coords, type, level }
}

export function raw(glsl: string, wgsl?: string): IRRawCode {
  return { kind: 'raw', glsl, wgsl }
}
