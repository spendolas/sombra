/**
 * WGSL Shader Assembler — IR → complete WGSL program.
 *
 * Takes collected IR node outputs (statements, functions, uniforms) and produces
 * a complete WGSL module with vertex + fragment entry points, a uniform buffer
 * struct with proper alignment, and texture/sampler bindings.
 *
 * Supports both single-pass and multi-pass graphs.
 */

import type { IRNodeOutput, IRFunction } from './types'
import { lowerStmtToWGSL, lowerFunctionToWGSL, lowerSpatialTransformToWGSL } from './wgsl-backend'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UniformBufferLayout {
  /** Total buffer size in bytes, rounded up to 16-byte boundary. */
  totalSize: number
  /** Uniform name → byte offset in the buffer. */
  offsets: Map<string, number>
  /** WGSL struct declaration string (e.g., "struct Uniforms { ... }"). */
  struct: string
}

export interface TextureBinding {
  /** Original sampler2D name (e.g., "u_abc_image"). */
  samplerName: string
  /** @binding index for the texture_2d<f32>. */
  textureBinding: number
  /** @binding index for the sampler. */
  samplerBinding: number
  /** @group index. */
  group: number
}

export interface WGSLAssemblerOutput {
  /** Complete WGSL module (vertex + fragment entry points). */
  shaderCode: string
  /** Byte layout for JS-side uniform buffer writes. */
  uniformLayout: UniformBufferLayout
  /** Texture/sampler binding indices for image nodes. */
  textureBindings: TextureBinding[]
}

// ---------------------------------------------------------------------------
// Uniform type info
// ---------------------------------------------------------------------------

interface UniformField {
  name: string
  wgslType: string
  size: number   // bytes
  align: number  // bytes
}

const IR_TYPE_TO_UNIFORM: Record<string, { wgslType: string; size: number; align: number }> = {
  float: { wgslType: 'f32', size: 4, align: 4 },
  vec2:  { wgslType: 'vec2f', size: 8, align: 8 },
  vec3:  { wgslType: 'vec3f', size: 12, align: 16 },
  vec4:  { wgslType: 'vec4f', size: 16, align: 16 },
  int:   { wgslType: 'i32', size: 4, align: 4 },
}

/** Map GLSL uniform type strings to WGSL uniform info. */
function glslTypeToUniformInfo(glslType: string): { wgslType: string; size: number; align: number } {
  return IR_TYPE_TO_UNIFORM[glslType] ?? IR_TYPE_TO_UNIFORM.float
}

// ---------------------------------------------------------------------------
// Uniform buffer layout computation
// ---------------------------------------------------------------------------

/**
 * Compute the byte-aligned uniform buffer layout.
 * Returns the struct declaration, total size, and per-field byte offsets.
 */
function computeUniformLayout(
  standardUniforms: Set<string>,
  userUniforms: Array<{ name: string; glslType: string }>,
): UniformBufferLayout {
  const fields: UniformField[] = []

  // Built-in uniforms in a fixed order
  if (standardUniforms.has('u_time'))
    fields.push({ name: 'u_time', wgslType: 'f32', size: 4, align: 4 })
  // u_resolution is vec2f (align 8) — may need pad after u_time
  if (standardUniforms.has('u_resolution'))
    fields.push({ name: 'u_resolution', wgslType: 'vec2f', size: 8, align: 8 })
  if (standardUniforms.has('u_dpr'))
    fields.push({ name: 'u_dpr', wgslType: 'f32', size: 4, align: 4 })
  if (standardUniforms.has('u_ref_size'))
    fields.push({ name: 'u_ref_size', wgslType: 'f32', size: 4, align: 4 })
  if (standardUniforms.has('u_anchor'))
    fields.push({ name: 'u_anchor', wgslType: 'vec2f', size: 8, align: 8 })
  if (standardUniforms.has('u_viewport'))
    fields.push({ name: 'u_viewport', wgslType: 'vec2f', size: 8, align: 8 })
  if (standardUniforms.has('u_mouse'))
    fields.push({ name: 'u_mouse', wgslType: 'vec2f', size: 8, align: 8 })

  // User-defined uniforms
  for (const u of userUniforms) {
    const info = glslTypeToUniformInfo(u.glslType)
    fields.push({ name: u.name, wgslType: info.wgslType, size: info.size, align: info.align })
  }

  // Lay out fields with alignment padding
  const offsets = new Map<string, number>()
  const structLines: string[] = []
  let offset = 0
  let padIndex = 0

  for (const field of fields) {
    // Align offset
    const remainder = offset % field.align
    if (remainder !== 0) {
      const padding = field.align - remainder
      // Insert padding field(s) — f32 padding entries (4 bytes each)
      const padCount = padding / 4
      for (let p = 0; p < padCount; p++) {
        structLines.push(`  _pad${padIndex}: f32,`)
        padIndex++
      }
      offset += padding
    }

    offsets.set(field.name, offset)
    structLines.push(`  ${field.name}: ${field.wgslType},`)
    offset += field.size
  }

  // WGSL requires at least one member in a struct.
  // Nodes with no uniforms (pure math) would produce an empty struct.
  if (structLines.length === 0) {
    structLines.push(`  _pad0: f32,`)
    offset = 4
  }

  // Round total size up to 16-byte boundary (GPU buffer alignment)
  const totalSize = Math.ceil(offset / 16) * 16

  const struct = `struct Uniforms {\n${structLines.join('\n')}\n}`

  return { totalSize, offsets, struct }
}

// ---------------------------------------------------------------------------
// Uniform name rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite bare uniform references in WGSL code to struct member access.
 * `u_time` → `uniforms.u_time`, `u_resolution` → `uniforms.u_resolution`, etc.
 *
 * Only rewrites names that are actual uniforms (passed in the known set).
 * Avoids rewriting variable names that happen to start with `u_` but are
 * local variables (e.g., node output vars like `node_abc_u_something`).
 */
function rewriteUniformReferences(code: string, uniformNames: Set<string>): string {
  if (uniformNames.size === 0) return code

  // Build a regex that matches any known uniform name as a whole word,
  // but NOT when preceded by a dot (already rewritten) or alphanumeric/underscore
  // (part of a larger identifier like node_abc_u_time).
  const escaped = [...uniformNames].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(
    `(?<![.\\w])(${escaped.join('|')})\\b`,
    'g',
  )
  return code.replace(pattern, 'uniforms.$1')
}

// ---------------------------------------------------------------------------
// gl_FragCoord → in.position substitution
// ---------------------------------------------------------------------------

/**
 * Replace gl_FragCoord references with the WGSL fragment input parameter.
 * In WGSL, the fragment position comes from @builtin(position) on the
 * fragment function's input struct.
 */
function rewriteFragCoord(code: string): string {
  return code.replace(/gl_FragCoord/g, 'in.position')
}

// ---------------------------------------------------------------------------
// v_uv → in.v_uv substitution
// ---------------------------------------------------------------------------

/**
 * Replace bare v_uv references with the WGSL fragment input member.
 * In WGSL, the UV varying comes from the VertexOutput struct via `in.v_uv`.
 * This is safe to apply to bodyCode/functionsCode — the VertexOutput struct
 * and vertex shader are emitted as template strings, not through this path.
 */
function rewriteVaryingReferences(code: string): string {
  // Negative lookbehind avoids double-rewriting `in.v_uv` → `in.in.v_uv`
  return code.replace(/(?<!\.)v_uv\b/g, 'in.v_uv')
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble a complete WGSL program from collected IR node outputs.
 *
 * @param nodeOutputs  - IR outputs from each node, in execution order
 * @param standardUniforms - Set of built-in uniform names used (u_time, etc.)
 * @param userUniforms - User-defined uniforms with name and GLSL type
 * @param imageSamplerNames - Image node sampler names (for texture bindings)
 * @param passInputSamplers - Inter-pass texture sampler names (e.g. "u_pass0_tex")
 */
export function assembleWGSL(
  nodeOutputs: IRNodeOutput[],
  standardUniforms: Set<string>,
  userUniforms: Array<{ name: string; glslType: string }>,
  imageSamplerNames: string[] = [],
  passInputSamplers: string[] = [],
): WGSLAssemblerOutput {
  // 1. Compute uniform buffer layout
  const uniformLayout = computeUniformLayout(standardUniforms, userUniforms)

  // 2. Collect and deduplicate shared functions
  const allFunctions: IRFunction[] = []
  for (const output of nodeOutputs) {
    if (output.functions) {
      allFunctions.push(...output.functions)
    }
  }
  const seenKeys = new Set<string>()
  const dedupedFunctions: string[] = []
  for (const fn of allFunctions) {
    if (seenKeys.has(fn.key)) continue
    seenKeys.add(fn.key)
    dedupedFunctions.push(lowerFunctionToWGSL(fn))
  }

  // 3. Generate per-node WGSL code lines for the fragment function body
  const bodyLines: string[] = []
  for (const output of nodeOutputs) {
    // Spatial transform preamble
    if (output.spatialTransform) {
      const srtLines = lowerSpatialTransformToWGSL(output.spatialTransform)
      for (const line of srtLines) {
        bodyLines.push(`  ${line}`)
      }
    }
    // Main statements
    for (const stmt of output.statements) {
      bodyLines.push(`  ${lowerStmtToWGSL(stmt)}`)
    }
  }

  // 4. Build set of all uniform names for reference rewriting
  const allUniformNames = new Set<string>()
  for (const name of standardUniforms) allUniformNames.add(name)
  for (const u of userUniforms) allUniformNames.add(u.name)

  // 5. Rewrite uniform references, gl_FragCoord, v_uv, and fragColor in body lines
  let bodyCode = bodyLines.join('\n')
  bodyCode = rewriteUniformReferences(bodyCode, allUniformNames)
  bodyCode = rewriteFragCoord(bodyCode)
  bodyCode = rewriteVaryingReferences(bodyCode)
  // WGSL fragment functions return a value instead of assigning to fragColor.
  // Rewrite `fragColor = expr;` → `return expr;`
  bodyCode = bodyCode.replace(/fragColor\s*=\s*(.+);/g, 'return $1;')

  let functionsCode = dedupedFunctions.join('\n\n')
  functionsCode = rewriteUniformReferences(functionsCode, allUniformNames)
  functionsCode = rewriteFragCoord(functionsCode)
  functionsCode = rewriteVaryingReferences(functionsCode)

  // 6. Build texture bindings (inter-pass textures first, then image nodes)
  const textureBindings: TextureBinding[] = []
  const textureDeclarations: string[] = []
  let bindingIndex = 0

  // Inter-pass texture inputs (from previous passes)
  for (const samplerName of passInputSamplers) {
    const texBinding = bindingIndex
    const sampBinding = bindingIndex + 1
    textureBindings.push({
      samplerName,
      textureBinding: texBinding,
      samplerBinding: sampBinding,
      group: 1,
    })
    textureDeclarations.push(
      `@group(1) @binding(${texBinding}) var ${samplerName}_tex: texture_2d<f32>;`,
      `@group(1) @binding(${sampBinding}) var ${samplerName}_samp: sampler;`,
    )
    bindingIndex += 2
  }

  // Image node textures
  for (const samplerName of imageSamplerNames) {
    const texBinding = bindingIndex
    const sampBinding = bindingIndex + 1
    textureBindings.push({
      samplerName,
      textureBinding: texBinding,
      samplerBinding: sampBinding,
      group: 1,
    })
    textureDeclarations.push(
      `@group(1) @binding(${texBinding}) var ${samplerName}_tex: texture_2d<f32>;`,
      `@group(1) @binding(${sampBinding}) var ${samplerName}_samp: sampler;`,
    )
    bindingIndex += 2
  }

  // 7. Emit sombra_mod helpers if needed (WGSL has no mod() function)
  const allCode = functionsCode + '\n' + bodyCode
  let modHelpers = ''
  if (allCode.includes('sombra_mod(')) {
    const variants: string[] = []
    // Detect which overloads are actually used
    // f32 is always needed if sombra_mod appears
    variants.push('fn sombra_mod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }')
    // vec2f overload — check for vec2f arguments
    if (/sombra_mod\(vec2f\(/.test(allCode) || /:\s*vec2f\s*=\s*sombra_mod/.test(allCode)) {
      variants.push('fn sombra_mod_v2(x: vec2f, y: vec2f) -> vec2f { return x - y * floor(x / y); }')
    }
    modHelpers = variants.join('\n') + '\n\n'
  }

  // 8. Assemble the complete WGSL module
  const shaderCode = `// Generated by Sombra WGSL Assembler
${uniformLayout.struct}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

${textureDeclarations.length > 0 ? textureDeclarations.join('\n') + '\n' : ''}struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) v_uv: vec2f,
}

@vertex fn vs_main(@location(0) a_position: vec2f) -> VertexOutput {
  var out: VertexOutput;
  out.v_uv = a_position * 0.5 + 0.5;
  out.position = vec4f(a_position, 0.0, 1.0);
  return out;
}

${modHelpers}${functionsCode}

@fragment fn fs_main(in: VertexOutput) -> @location(0) vec4f {
${bodyCode}
}
`

  return { shaderCode, uniformLayout, textureBindings }
}
