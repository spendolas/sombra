/**
 * GLSL code generator - compiles node graph to shader code
 *
 * Phase 6: Produces a RenderPlan (array of render passes) instead of a
 * single shader. Single-pass graphs compile to a plan with one pass
 * (zero overhead — [P1]). Multi-pass graphs are created when textureInput
 * ports are wired, auto-inserting pass boundaries.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, GLSLContext, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import { coerceType } from '../nodes/type-coercion'

export function uniformName(sanitizedNodeId: string, paramId: string): string {
  return `u_${sanitizedNodeId}_${paramId}`
}

export function paramGlslType(paramType: string): 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (paramType === 'vec2') return 'vec2'
  if (paramType === 'vec3' || paramType === 'color') return 'vec3'
  if (paramType === 'vec4') return 'vec4'
  return 'float'
}

// ---------------------------------------------------------------------------
// Multi-pass types
// ---------------------------------------------------------------------------

/**
 * A single render pass in a multi-pass pipeline.
 */
export interface RenderPass {
  index: number
  fragmentShader: string
  vertexShader: string
  userUniforms: UniformSpec[]
  /** samplerName → source pass index. Empty for the first pass. */
  inputTextures: Record<string, number>
  isTimeLive: boolean
  /** Texture filtering hint for this pass's output FBO. */
  textureFilter?: 'linear' | 'nearest'
}

/**
 * Complete render plan produced by the compiler.
 * Single-pass graphs have exactly one pass. Multi-pass graphs have 2+.
 */
export interface RenderPlan {
  success: boolean
  passes: RenderPass[]
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLiveAtOutput: boolean
  qualityTier: string
  // Backward compat — final pass's shaders:
  vertexShader: string
  fragmentShader: string
  userUniforms: UniformSpec[]
}

/** @deprecated Use RenderPlan instead */
export type CompilationResult = RenderPlan

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Standard vertex shader (passthrough with UV)
 */
const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------
// Pass partitioning
// ---------------------------------------------------------------------------

/**
 * Compute per-node pass depth based on textureInput boundaries.
 * Returns null if the graph is single-pass (no wired textureInputs).
 *
 * Algorithm: each node's depth = max over all inputs of:
 *   - textureInput wired → sourceDepth + 1
 *   - normal input wired → sourceDepth
 *
 * [P1] Returns null (single-pass fast path) when no textureInput is wired.
 * [P11] Only textureInput ports trigger boundaries — consecutive non-spatial
 * nodes naturally merge into one pass.
 */
function partitionPasses(
  executionOrder: string[],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
): string[][] | null {
  // Quick check: any wired textureInput?
  let hasTextureBoundary = false
  for (const nodeId of executionOrder) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const def = nodeRegistry.get(node.data.type)
    if (!def) continue
    const incoming = edgesByTarget.get(nodeId) || []
    for (const input of def.inputs) {
      if (input.textureInput && incoming.some(e => e.targetHandle === input.id)) {
        hasTextureBoundary = true
        break
      }
    }
    if (hasTextureBoundary) break
  }

  if (!hasTextureBoundary) return null

  // Compute depth per node
  const depth = new Map<string, number>()
  for (const id of executionOrder) depth.set(id, 0)

  for (const nodeId of executionOrder) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const def = nodeRegistry.get(node.data.type)
    if (!def) continue
    const incoming = edgesByTarget.get(nodeId) || []

    let maxDepth = 0

    const resolvedInputs = def.dynamicInputs
      ? def.dynamicInputs(node.data.params || {})
      : def.inputs

    for (const input of resolvedInputs) {
      const edge = incoming.find(e => e.targetHandle === input.id)
      if (!edge) continue
      const sourceDepth = depth.get(edge.source) ?? 0
      if (input.textureInput) {
        maxDepth = Math.max(maxDepth, sourceDepth + 1)
      } else {
        maxDepth = Math.max(maxDepth, sourceDepth)
      }
    }

    // Connectable params are same-pass (not texture inputs)
    if (def.params) {
      for (const param of def.params) {
        if (!param.connectable) continue
        const edge = incoming.find(e => e.targetHandle === param.id)
        if (!edge) continue
        maxDepth = Math.max(maxDepth, depth.get(edge.source) ?? 0)
      }
    }

    depth.set(nodeId, maxDepth)
  }

  // Group by depth, preserving execution order within each group
  const maxDepth = Math.max(...depth.values())
  const passes: string[][] = []
  for (let d = 0; d <= maxDepth; d++) {
    const passNodes = executionOrder.filter(id => depth.get(id) === d)
    if (passNodes.length > 0) passes.push(passNodes)
  }

  return passes
}

// ---------------------------------------------------------------------------
// Texture boundary info (used by multi-pass codegen)
// ---------------------------------------------------------------------------

interface TextureBoundaryEdge {
  consumerId: string
  consumingPortId: string
  sourcePassIndex: number
  samplerName: string
}

/**
 * Find all texture boundary edges in a partitioned graph.
 */
function findTextureBoundaries(
  passes: string[][],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
): TextureBoundaryEdge[] {
  const boundaries: TextureBoundaryEdge[] = []

  // nodeId → passIndex lookup
  const nodePassIndex = new Map<string, number>()
  for (let i = 0; i < passes.length; i++) {
    for (const nodeId of passes[i]) nodePassIndex.set(nodeId, i)
  }

  let samplerCounter = 0
  for (let passIdx = 1; passIdx < passes.length; passIdx++) {
    for (const nodeId of passes[passIdx]) {
      const node = nodeMap.get(nodeId)
      if (!node) continue
      const def = nodeRegistry.get(node.data.type)
      if (!def) continue
      const incoming = edgesByTarget.get(nodeId) || []

      for (const input of def.inputs) {
        if (!input.textureInput) continue
        const edge = incoming.find(e => e.targetHandle === input.id)
        if (!edge) continue
        const sourcePass = nodePassIndex.get(edge.source)
        if (sourcePass === undefined || sourcePass >= passIdx) continue

        boundaries.push({
          consumerId: nodeId,
          consumingPortId: input.id,
          sourcePassIndex: sourcePass,
          samplerName: `u_pass${samplerCounter}_tex`,
        })
        samplerCounter++
      }
    }
  }

  return boundaries
}

// ---------------------------------------------------------------------------
// Error plan helper
// ---------------------------------------------------------------------------

function errorPlan(errors: Array<{ message: string; nodeId?: string }>): RenderPlan {
  return {
    success: false,
    passes: [],
    errors,
    isTimeLiveAtOutput: false,
    qualityTier: 'adaptive',
    vertexShader: '',
    fragmentShader: '',
    userUniforms: [],
  }
}

// ---------------------------------------------------------------------------
// Input resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an input port to its default value (auto_uv, auto_fragcoord, or literal).
 * Returns true if a default was found, false if the port has no default.
 */
function resolveInputDefault(
  inputPort: { id: string; type: string; default?: unknown },
  sanitizedNodeId: string,
  preambleLines: string[],
  inputs: Record<string, string>,
  uniforms: Set<string>,
): boolean {
  if (inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
    const autoUvVar = `node_${sanitizedNodeId}_auto_uv`
    preambleLines.push(`vec2 ${autoUvVar} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;`)
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    inputs[inputPort.id] = autoUvVar
    return true
  }
  if (inputPort.default === 'auto_fragcoord' && inputPort.type === 'vec2') {
    const autoFcVar = `node_${sanitizedNodeId}_auto_fc`
    preambleLines.push(`vec2 ${autoFcVar} = gl_FragCoord.xy;`)
    inputs[inputPort.id] = autoFcVar
    return true
  }
  if (inputPort.default !== undefined) {
    inputs[inputPort.id] = formatDefaultValue(inputPort.default, inputPort.type)
    return true
  }
  return false
}

/**
 * Resolve a connectable param that isn't wired — use param value or uniform.
 */
function resolveParamFallback(
  param: import('../nodes/types').NodeParameter,
  node: Node<NodeData>,
  sanitizedNodeId: string,
  inputs: Record<string, string>,
  userUniforms: UniformSpec[],
) {
  const paramValue = node.data.params?.[param.id] ?? param.default
  if (param.updateMode === 'uniform') {
    const uName = uniformName(sanitizedNodeId, param.id)
    userUniforms.push({
      name: uName,
      glslType: paramGlslType(param.type),
      value: paramValue as number | number[],
      nodeId: node.id,
      paramId: param.id,
    })
    inputs[param.id] = uName
  } else {
    inputs[param.id] = formatDefaultValue(paramValue, param.type)
  }
}

// ---------------------------------------------------------------------------
// Per-node codegen
// ---------------------------------------------------------------------------

interface NodeCodegenResult {
  glslLines: string[]
  errors: Array<{ message: string; nodeId?: string }>
}

/**
 * Generate GLSL for a single node, resolving inputs from edges or defaults.
 * Shared between single-pass and multi-pass compilation.
 */
function generateNodeGlsl(
  nodeId: string,
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  uniforms: Set<string>,
  functions: string[],
  functionRegistry: Map<string, string>,
  userUniforms: UniformSpec[],
  textureBoundaries?: TextureBoundaryEdge[],
): NodeCodegenResult {
  const errors: Array<{ message: string; nodeId?: string }> = []
  const glslLines: string[] = []

  const node = nodeMap.get(nodeId)
  if (!node) return { glslLines, errors }

  const definition = nodeRegistry.get(node.data.type)
  if (!definition) {
    errors.push({ message: `Unknown node type: ${node.data.type}`, nodeId: node.id })
    return { glslLines, errors }
  }

  const inputs: Record<string, string> = {}
  const incomingEdges = edgesByTarget.get(nodeId) || []
  const sanitizedNodeId = nodeId.replace(/-/g, '_')
  const preambleLines: string[] = []
  const textureSamplers: Record<string, string> = {}

  // Texture boundary ports for this node (multi-pass)
  const boundariesForNode = textureBoundaries?.filter(b => b.consumerId === nodeId) || []
  const texturePortIds = new Set(boundariesForNode.map(b => b.consumingPortId))

  // Resolve inputs
  const resolvedInputs = definition.dynamicInputs
    ? definition.dynamicInputs(node.data.params || {})
    : definition.inputs

  resolvedInputs.forEach((inputPort) => {
    // If this port is satisfied by a texture boundary, skip normal resolution
    if (texturePortIds.has(inputPort.id)) {
      const boundary = boundariesForNode.find(b => b.consumingPortId === inputPort.id)
      if (boundary) {
        textureSamplers[inputPort.id] = boundary.samplerName
      }
      return
    }

    const edge = incomingEdges.find((e) => e.targetHandle === inputPort.id)

    if (edge) {
      const sourceNode = nodeMap.get(edge.source)
      if (sourceNode) {
        const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
        if (sourceDefinition) {
          const sourcePort = sourceDefinition.outputs.find(
            (p) => p.id === edge.sourceHandle
          )
          if (sourcePort) {
            const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
            if (sourcePort.type !== inputPort.type) {
              inputs[inputPort.id] = coerceType(sourceVarName, sourcePort.type, inputPort.type)
            } else {
              inputs[inputPort.id] = sourceVarName
            }
          }
        }
      } else {
        // Source node deleted — fall back to default
        resolveInputDefault(inputPort, sanitizedNodeId, preambleLines, inputs, uniforms)
      }
    } else {
      // Not connected — use default or report error
      if (!resolveInputDefault(inputPort, sanitizedNodeId, preambleLines, inputs, uniforms)) {
        errors.push({
          message: `Input "${inputPort.label}" on ${definition.label} has no connection and no default`,
          nodeId: node.id,
        })
      }
    }
  })

  // Resolve connectable params
  if (definition.params) {
    for (const param of definition.params) {
      if (!param.connectable) continue

      const edge = incomingEdges.find((e) => e.targetHandle === param.id)

      if (edge) {
        const sourceNode = nodeMap.get(edge.source)
        if (sourceNode) {
          const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
          if (sourceDefinition) {
            const sourcePort = sourceDefinition.outputs.find(
              (p) => p.id === edge.sourceHandle
            )
            if (sourcePort) {
              const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
              if (sourcePort.type !== param.type) {
                inputs[param.id] = coerceType(
                  sourceVarName,
                  sourcePort.type,
                  param.type as import('../nodes/types').PortType
                )
              } else {
                inputs[param.id] = sourceVarName
              }
            }
          }
        } else {
          resolveParamFallback(param, node, sanitizedNodeId, inputs, userUniforms)
        }
      } else {
        resolveParamFallback(param, node, sanitizedNodeId, inputs, userUniforms)
      }
    }
  }

  // Non-connectable uniform params
  if (definition.params) {
    for (const param of definition.params) {
      if (param.connectable || param.updateMode !== 'uniform') continue
      const uName = uniformName(sanitizedNodeId, param.id)
      const paramValue = node.data.params?.[param.id] ?? param.default
      userUniforms.push({
        name: uName,
        glslType: paramGlslType(param.type),
        value: paramValue as number | number[],
        nodeId: node.id,
        paramId: param.id,
      })
      inputs[param.id] = uName
    }
  }

  // Framework SRT injection — transforms coords input for spatial nodes
  if (definition.spatial && inputs.coords) {
    const srtVar = `srt_${sanitizedNodeId}`
    const spatial = definition.spatial
    const hasScale = spatial.transforms.includes('scale')
    const hasScaleXY = spatial.transforms.includes('scaleXY')
    const hasRotate = spatial.transforms.includes('rotate')
    const hasTranslate = spatial.transforms.includes('translate')

    preambleLines.push(`vec2 ${srtVar} = ${inputs.coords} - 0.5;`)

    // Scale (new convention: coords /= scale → scale=2 means twice as large)
    if (hasScale) {
      preambleLines.push(`${srtVar} /= vec2(${inputs._srt_scale});`)
    } else if (hasScaleXY) {
      preambleLines.push(`${srtVar} /= vec2(${inputs._srt_scaleX}, ${inputs._srt_scaleY});`)
    }

    // Rotate
    if (hasRotate) {
      const cVar = `srt_c_${sanitizedNodeId}`
      const sVar = `srt_s_${sanitizedNodeId}`
      preambleLines.push(`float ${cVar} = cos(${inputs._srt_rotate}); float ${sVar} = sin(${inputs._srt_rotate});`)
      preambleLines.push(`${srtVar} = vec2(${srtVar}.x * ${cVar} - ${srtVar}.y * ${sVar}, ${srtVar}.x * ${sVar} + ${srtVar}.y * ${cVar});`)
    }

    // Translate
    if (hasTranslate) {
      preambleLines.push(`${srtVar} += vec2(${inputs._srt_translateX}, ${inputs._srt_translateY});`)
    }

    preambleLines.push(`${srtVar} += 0.5;`)

    // Replace coords input with transformed variable
    inputs.coords = srtVar
  }

  // Build output variable names
  const outputs: Record<string, string> = {}
  definition.outputs.forEach((outputPort) => {
    outputs[outputPort.id] = `node_${sanitizedNodeId}_${outputPort.id}`
  })

  // Generate GLSL
  const context: GLSLContext = {
    nodeId: node.id,
    inputs,
    outputs,
    params: node.data.params || {},
    uniforms,
    functions,
    functionRegistry,
    textureSamplers: Object.keys(textureSamplers).length > 0 ? textureSamplers : undefined,
  }

  try {
    const glsl = definition.glsl(context)
    glslLines.push(`  // ${definition.label} (${node.id})`)
    for (const line of preambleLines) {
      glslLines.push(`  ${line}`)
    }
    glslLines.push(`  ${glsl}`)
  } catch (error) {
    errors.push({
      message: `GLSL generation failed: ${error instanceof Error ? error.message : String(error)}`,
      nodeId: node.id,
    })
  }

  return { glslLines, errors }
}

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

/**
 * Compile node graph to a RenderPlan (array of render passes).
 * Single-pass graphs produce a plan with one pass ([P1] zero overhead).
 */
export function compileGraph(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[]
): RenderPlan {
  try {
    if (hasCycles(nodes, edges)) {
      return errorPlan([{ message: 'Graph contains cycles. Remove circular dependencies.' }])
    }

    const executionOrder = topologicalSort(nodes, edges)
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    // Build edge lookup
    const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
    edges.forEach((edge) => {
      if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
      edgesByTarget.get(edge.target)!.push(edge)
    })

    // [P1] Try to partition into passes — returns null for single-pass graphs
    const passPartition = partitionPasses(executionOrder, nodeMap, edgesByTarget)

    if (!passPartition) {
      return compileSinglePass(executionOrder, nodeMap, edgesByTarget, nodes)
    }

    return compileMultiPass(passPartition, nodeMap, edgesByTarget, nodes)
  } catch (error) {
    return errorPlan([{
      message: `Compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    }])
  }
}

// ---------------------------------------------------------------------------
// Single-pass compilation — [P1] zero overhead for non-multi-pass graphs
// ---------------------------------------------------------------------------

function compileSinglePass(
  executionOrder: string[],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  nodes: Node<NodeData>[],
): RenderPlan {
  const errors: Array<{ message: string; nodeId?: string }> = []
  const uniforms = new Set<string>()
  const functions: string[] = []
  const functionRegistry = new Map<string, string>()
  const userUniforms: UniformSpec[] = []
  const allGlslLines: string[] = []

  for (const nodeId of executionOrder) {
    const result = generateNodeGlsl(
      nodeId, nodeMap, edgesByTarget,
      uniforms, functions, functionRegistry, userUniforms,
    )
    allGlslLines.push(...result.glslLines)
    errors.push(...result.errors)
  }

  if (errors.length > 0) return errorPlan(errors)

  const fragmentShader = assembleFragmentShader(
    uniforms, functions, functionRegistry, allGlslLines, userUniforms,
  )

  // Debug: Log generated shader
  console.log('[Sombra] Generated Fragment Shader:')
  console.log(fragmentShader)

  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const qualityTier = (outputNode?.data.params?.quality as string) ?? 'adaptive'
  const isTimeLive = uniforms.has('u_time')

  const pass: RenderPass = {
    index: 0,
    fragmentShader,
    vertexShader: VERTEX_SHADER,
    userUniforms,
    inputTextures: {},
    isTimeLive,
  }

  return {
    success: true,
    passes: [pass],
    errors: [],
    isTimeLiveAtOutput: isTimeLive,
    qualityTier,
    vertexShader: VERTEX_SHADER,
    fragmentShader,
    userUniforms,
  }
}

// ---------------------------------------------------------------------------
// Multi-pass compilation
// ---------------------------------------------------------------------------

function compileMultiPass(
  passPartition: string[][],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  nodes: Node<NodeData>[],
): RenderPlan {
  const boundaries = findTextureBoundaries(passPartition, nodeMap, edgesByTarget)
  const passes: RenderPass[] = []
  const allUserUniforms: UniformSpec[] = []

  for (let passIdx = 0; passIdx < passPartition.length; passIdx++) {
    const passNodeIds = passPartition[passIdx]
    const isLastPass = passIdx === passPartition.length - 1

    const uniforms = new Set<string>()
    const functions: string[] = []
    const functionRegistry = new Map<string, string>()
    const passUserUniforms: UniformSpec[] = []
    const glslLines: string[] = []

    // Boundaries consumed by nodes in this pass
    const passBoundaries = boundaries.filter(b => passNodeIds.includes(b.consumerId))
    const samplerNames = passBoundaries.map(b => b.samplerName)

    // Build inputTextures map
    const inputTextures: Record<string, number> = {}
    for (const b of passBoundaries) {
      inputTextures[b.samplerName] = b.sourcePassIndex
    }

    // Generate GLSL for each node in this pass
    const allErrors: Array<{ message: string; nodeId?: string }> = []
    for (const nodeId of passNodeIds) {
      const result = generateNodeGlsl(
        nodeId, nodeMap, edgesByTarget,
        uniforms, functions, functionRegistry, passUserUniforms,
        passBoundaries,
      )
      glslLines.push(...result.glslLines)
      allErrors.push(...result.errors)
    }

    if (allErrors.length > 0) return errorPlan(allErrors)

    // Intermediate passes: write the pass output node's value to fragColor
    if (!isLastPass) {
      const outputBoundary = boundaries.find(b => b.sourcePassIndex === passIdx)
      if (outputBoundary) {
        const consumerIncoming = edgesByTarget.get(outputBoundary.consumerId) || []
        const texEdge = consumerIncoming.find(e => e.targetHandle === outputBoundary.consumingPortId)
        if (texEdge) {
          const sourceDef = nodeMap.get(texEdge.source)
            ? nodeRegistry.get(nodeMap.get(texEdge.source)!.data.type)
            : undefined
          const sourcePort = sourceDef?.outputs.find(p => p.id === texEdge.sourceHandle)
          if (sourcePort) {
            const sourceVar = `node_${texEdge.source.replace(/-/g, '_')}_${texEdge.sourceHandle}`
            glslLines.push(outputTypeToFragColor(sourceVar, sourcePort.type))
          }
        }
      }
    }

    const fragmentShader = assembleFragmentShader(
      uniforms, functions, functionRegistry, glslLines, passUserUniforms, samplerNames,
    )

    passes.push({
      index: passIdx,
      fragmentShader,
      vertexShader: VERTEX_SHADER,
      userUniforms: passUserUniforms,
      inputTextures,
      isTimeLive: uniforms.has('u_time'),
    })

    allUserUniforms.push(...passUserUniforms)
  }

  const lastPass = passes[passes.length - 1]
  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const qualityTier = (outputNode?.data.params?.quality as string) ?? 'adaptive'

  console.log(`[Sombra] Generated ${passes.length}-pass RenderPlan:`)
  for (const pass of passes) {
    console.log(`  Pass ${pass.index}: ${Object.keys(pass.inputTextures).length} texture inputs`)
    console.log(pass.fragmentShader)
  }

  return {
    success: true,
    passes,
    errors: [],
    isTimeLiveAtOutput: lastPass.isTimeLive,
    qualityTier,
    vertexShader: VERTEX_SHADER,
    fragmentShader: lastPass.fragmentShader,
    userUniforms: allUserUniforms,
  }
}

/** Convert an output variable to a fragColor assignment based on port type. */
function outputTypeToFragColor(varName: string, type: string): string {
  switch (type) {
    case 'float':
      return `  fragColor = vec4(vec3(${varName}), 1.0);`
    case 'vec2':
      return `  fragColor = vec4(${varName}, 0.0, 1.0);`
    case 'vec3':
    case 'color':
      return `  fragColor = vec4(${varName}, 1.0);`
    case 'vec4':
      return `  fragColor = ${varName};`
    default:
      return `  fragColor = vec4(vec3(${varName}), 1.0);`
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Coerce unknown value to a safe GLSL float literal (NaN/Infinity → 0.0) */
function safeFloat(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0.0'
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

/**
 * Format a default value as GLSL
 */
export function formatDefaultValue(value: unknown, type: string): string {
  if (type === 'float') return safeFloat(value)
  if (type === 'vec2' && Array.isArray(value)) {
    return `vec2(${safeFloat(value[0])}, ${safeFloat(value[1])})`
  }
  if (type === 'vec3' && Array.isArray(value)) {
    return `vec3(${safeFloat(value[0])}, ${safeFloat(value[1])}, ${safeFloat(value[2])})`
  }
  if (type === 'vec4' && Array.isArray(value)) {
    return `vec4(${safeFloat(value[0])}, ${safeFloat(value[1])}, ${safeFloat(value[2])}, ${safeFloat(value[3])})`
  }
  return '0.0'
}

/**
 * Assemble the complete fragment shader
 */
export function assembleFragmentShader(
  uniforms: Set<string>,
  functions: string[],
  functionRegistry: Map<string, string>,
  glslLines: string[],
  userUniforms: UniformSpec[],
  /** sampler2D uniform names for multi-pass texture inputs */
  samplers?: string[],
): string {
  const uniformDeclarations: string[] = []

  // Standard uniforms
  if (uniforms.has('u_time')) {
    uniformDeclarations.push('uniform float u_time;')
  }
  if (uniforms.has('u_resolution')) {
    uniformDeclarations.push('uniform vec2 u_resolution;')
  }
  if (uniforms.has('u_mouse')) {
    uniformDeclarations.push('uniform vec2 u_mouse;')
  }
  if (uniforms.has('u_ref_size')) {
    uniformDeclarations.push('uniform float u_ref_size;')
  }
  if (uniforms.has('u_dpr')) {
    uniformDeclarations.push('uniform float u_dpr;')
  }

  // User-defined uniforms from uniform-mode params
  for (const spec of userUniforms) {
    uniformDeclarations.push(`uniform ${spec.glslType} ${spec.name};`)
  }

  // Texture sampler uniforms (multi-pass)
  if (samplers) {
    for (const name of samplers) {
      uniformDeclarations.push(`uniform sampler2D ${name};`)
    }
  }

  return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

${uniformDeclarations.join('\n')}

${[...functionRegistry.values(), ...functions].join('\n\n')}

void main() {
${glslLines.join('\n')}
}
`
}
