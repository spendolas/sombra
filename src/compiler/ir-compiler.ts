/**
 * IR-based compiler — compiles node graph to a RenderPlan with WGSL output.
 *
 * Mirrors glsl-generator.ts but calls each node's ir() function instead of
 * glsl(). Produces IRNodeOutput objects that are assembled into a complete
 * WGSL program by the wgsl-assembler.
 *
 * Supports both single-pass and multi-pass graphs.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, UniformSpec, PortType, NodeParameter } from '../nodes/types'
import type { IRNodeOutput, IRContext, IRSpatialTransform } from './ir/types'
import { raw } from './ir/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import {
  partitionPasses, findTextureBoundaries, outputTypeToFragColor,
  resolveSourceEdge, groupBoundariesBySourceOutput,
  uniformName, paramGlslType, formatDefaultValue,
} from './glsl-generator'
import type { TextureBoundaryEdge } from './glsl-generator'
import { assembleWGSL } from './ir/wgsl-assembler'

// ---------------------------------------------------------------------------
// WGSL type coercion (IR-level, parallel to type-coercion.ts GLSL rules)
// ---------------------------------------------------------------------------

/**
 * Apply type coercion for IR compilation.
 *
 * Uses WGSL constructor names (vec2f, vec3f, vec4f) because coerced
 * expressions end up as variable names inside IR nodes, not in raw GLSL
 * blocks that go through mechanical translation.
 */
export function coerceTypeForIR(varName: string, from: PortType, to: PortType): string {
  if (from === to) return varName
  // color is alias for vec3
  if ((from === 'color' && to === 'vec3') || (from === 'vec3' && to === 'color')) return varName

  const rules: Record<string, Record<string, (v: string) => string>> = {
    float: {
      vec2: (v) => `vec2f(${v})`,
      vec3: (v) => `vec3f(${v})`,
      vec4: (v) => `vec4f(${v})`,
    },
    vec2: {
      float: (v) => `${v}.x`,
      vec3: (v) => `vec3f(${v}, 0.0)`,
      vec4: (v) => `vec4f(${v}, 0.0, 1.0)`,
    },
    vec3: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec4: (v) => `vec4f(${v}, 1.0)`,
    },
    color: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec4: (v) => `vec4f(${v}, 1.0)`,
    },
    vec4: {
      float: (v) => `${v}.x`,
      vec2: (v) => `${v}.xy`,
      vec3: (v) => `${v}.rgb`,
    },
  }

  const fromRules = rules[from]
  if (fromRules && fromRules[to]) return fromRules[to](varName)

  // Fallback — identity (shouldn't happen for valid connections)
  return varName
}

// ---------------------------------------------------------------------------
// Safe float formatting (same as glsl-generator.ts)
// ---------------------------------------------------------------------------

export function formatDefaultValueIR(value: unknown, type: string): string {
  // For IR, we generate GLSL-syntax defaults that the raw() node or
  // the WGSL backend's mechanical translation will handle.
  return formatDefaultValue(value, type)
}

// ---------------------------------------------------------------------------
// Per-node IR generation
// ---------------------------------------------------------------------------

export interface NodeIRResult {
  output: IRNodeOutput | null
  errors: Array<{ message: string; nodeId?: string }>
  /** Preamble IR statements (auto_uv, SRT transforms) injected before node IR. */
  preambleStatements: import('./ir/types').IRStmt[]
}

/**
 * Generate IR for a single node — parallel to generateNodeGlsl().
 * Resolves inputs from edges or defaults, handles connectable params,
 * injects SRT spatial transforms, and calls definition.ir().
 */
export function generateNodeIR(
  nodeId: string,
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  collectedStandardUniforms: Set<string>,
  userUniforms: UniformSpec[],
  imageSamplers: Set<string>,
  textureBoundaries?: TextureBoundaryEdge[],
): NodeIRResult {
  const errors: Array<{ message: string; nodeId?: string }> = []
  const preambleStatements: import('./ir/types').IRStmt[] = []

  const node = nodeMap.get(nodeId)
  if (!node) return { output: null, errors, preambleStatements }

  const definition = nodeRegistry.get(node.data.type)
  if (!definition) {
    errors.push({ message: `Unknown node type: ${node.data.type}`, nodeId: node.id })
    return { output: null, errors, preambleStatements }
  }

  // Must have ir() function
  if (!definition.ir) {
    errors.push({ message: `Node "${definition.label}" has no ir() function`, nodeId: node.id })
    return { output: null, errors, preambleStatements }
  }

  const inputs: Record<string, string> = {}
  const incomingEdges = edgesByTarget.get(nodeId) || []
  const sanitizedNodeId = nodeId.replace(/-/g, '_')
  const textureSamplers: Record<string, string> = {}

  // Texture boundary ports for this node (multi-pass)
  const boundariesForNode = textureBoundaries?.filter(b => b.consumerId === nodeId) || []
  const texturePortIds = new Set(boundariesForNode.map(b => b.consumingPortId))

  // Texture mode: node has at least one wired textureInput
  const isTextureMode = boundariesForNode.length > 0

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
            (p) => p.id === edge.sourceHandle,
          )
          if (sourcePort) {
            const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
            inputs[inputPort.id] = coerceTypeForIR(sourceVarName, sourcePort.type, inputPort.type)
          }
        }
      } else {
        resolveInputDefaultIR(inputPort, sanitizedNodeId, preambleStatements, inputs, collectedStandardUniforms)
      }
    } else {
      // In texture mode, use gl_FragCoord.xy/viewport (screen space 0-1) instead of auto_uv.
      // Uses FragCoord because on WGSL in.position.y=0 at top matches WebGPU texture convention.
      if (isTextureMode && inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
        const screenUvVar = `node_${sanitizedNodeId}_screen_uv`
        preambleStatements.push(raw(
          `vec2 ${screenUvVar} = gl_FragCoord.xy / u_viewport;`,
          `let ${screenUvVar}: vec2f = in.position.xy / uniforms.u_viewport;`,
        ))
        collectedStandardUniforms.add('u_viewport')
        inputs[inputPort.id] = screenUvVar
      } else if (!resolveInputDefaultIR(inputPort, sanitizedNodeId, preambleStatements, inputs, collectedStandardUniforms)) {
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
              (p) => p.id === edge.sourceHandle,
            )
            if (sourcePort) {
              const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
              inputs[param.id] = coerceTypeForIR(
                sourceVarName,
                sourcePort.type,
                param.type as PortType,
              )
            }
          }
        } else {
          resolveParamFallbackIR(param, node, sanitizedNodeId, inputs, userUniforms)
        }
      } else {
        resolveParamFallbackIR(param, node, sanitizedNodeId, inputs, userUniforms)
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

  // Build output variable names
  const outputs: Record<string, string> = {}
  definition.outputs.forEach((outputPort) => {
    outputs[outputPort.id] = `node_${sanitizedNodeId}_${outputPort.id}`
  })

  // Build IR context
  const irContext: IRContext = {
    nodeId: node.id,
    inputs,
    outputs,
    params: node.data.params || {},
    textureSamplers: Object.keys(textureSamplers).length > 0 ? textureSamplers : undefined,
    imageSamplers: imageSamplers.size > 0 ? imageSamplers : undefined,
  }

  // Framework SRT injection — build IRSpatialTransform if applicable
  let spatialTransform: IRSpatialTransform | undefined
  if (definition.spatial && inputs.coords) {
    const srtVar = `srt_${sanitizedNodeId}`
    const spatial = definition.spatial

    spatialTransform = {
      coordsVar: inputs.coords,
      outputVar: srtVar,
      scaleUniform: spatial.transforms.includes('scale') ? inputs.srt_scale : undefined,
      scaleXUniform: spatial.transforms.includes('scaleXY') ? inputs.srt_scaleX : undefined,
      scaleYUniform: spatial.transforms.includes('scaleXY') ? inputs.srt_scaleY : undefined,
      rotateUniform: spatial.transforms.includes('rotate') ? inputs.srt_rotate : undefined,
      translateXUniform: spatial.transforms.includes('translate') ? inputs.srt_translateX : undefined,
      translateYUniform: spatial.transforms.includes('translate') ? inputs.srt_translateY : undefined,
    }

    // Add standard uniforms needed by SRT
    collectedStandardUniforms.add('u_anchor')
    if (spatial.transforms.includes('rotate')) {
      collectedStandardUniforms.add('u_resolution')
    }
    if (spatial.transforms.includes('translate')) {
      collectedStandardUniforms.add('u_dpr')
      collectedStandardUniforms.add('u_ref_size')
    }

    // Replace coords input with the SRT output variable
    irContext.inputs.coords = srtVar
  }

  // Call ir() function
  try {
    const irOutput = definition.ir(irContext)

    // Merge standard uniforms from the node
    for (const u of irOutput.standardUniforms) {
      collectedStandardUniforms.add(u)
    }

    // Track image samplers
    if (irContext.imageSamplers) {
      for (const name of irContext.imageSamplers) {
        imageSamplers.add(name)
      }
    }

    // Attach spatial transform if present
    const finalOutput: IRNodeOutput = spatialTransform
      ? { ...irOutput, spatialTransform }
      : irOutput

    return { output: finalOutput, errors, preambleStatements }
  } catch (error) {
    errors.push({
      message: `IR generation failed: ${error instanceof Error ? error.message : String(error)}`,
      nodeId: node.id,
    })
    return { output: null, errors, preambleStatements }
  }
}

// ---------------------------------------------------------------------------
// Input resolution helpers (IR-specific)
// ---------------------------------------------------------------------------

/**
 * Resolve an input port default for IR compilation.
 *
 * auto_uv: In WGSL, @builtin(position).y already goes top-to-bottom,
 * so the y-flip used in GLSL (u_resolution.y - gl_FragCoord.y) is NOT needed.
 * We emit raw GLSL that the assembler will mechanically rewrite:
 * - gl_FragCoord → in.position (assembler rewrite)
 * - vec2 → vec2f (WGSL backend mechanical translation)
 * - u_resolution → uniforms.u_resolution (assembler rewrite)
 */
export function resolveInputDefaultIR(
  inputPort: { id: string; type: string; default?: unknown },
  sanitizedNodeId: string,
  preambleStatements: import('./ir/types').IRStmt[],
  inputs: Record<string, string>,
  uniforms: Set<string>,
): boolean {
  if (inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
    const autoUvVar = `node_${sanitizedNodeId}_auto_uv`
    // WGSL: in.position.y is already top-to-bottom — NO y-flip needed
    preambleStatements.push(raw(
      `vec2 ${autoUvVar} = (vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) - u_resolution * u_anchor) / (u_dpr * u_ref_size) + u_anchor;`,
      `let ${autoUvVar}: vec2f = (in.position.xy - uniforms.u_resolution * uniforms.u_anchor) / (uniforms.u_dpr * uniforms.u_ref_size) + uniforms.u_anchor;`,
    ))
    uniforms.add('u_resolution')
    uniforms.add('u_anchor')
    uniforms.add('u_dpr')
    uniforms.add('u_ref_size')
    inputs[inputPort.id] = autoUvVar
    return true
  }
  if (inputPort.default === 'screen_uv' && inputPort.type === 'vec2') {
    inputs[inputPort.id] = 'in.v_uv'
    return true
  }
  if (inputPort.default === 'auto_fragcoord' && inputPort.type === 'vec2') {
    const autoFcVar = `node_${sanitizedNodeId}_auto_fc`
    preambleStatements.push(raw(
      `vec2 ${autoFcVar} = gl_FragCoord.xy - u_resolution * u_anchor;`,
      `let ${autoFcVar}: vec2f = in.position.xy - uniforms.u_resolution * uniforms.u_anchor;`,
    ))
    uniforms.add('u_resolution')
    uniforms.add('u_anchor')
    inputs[inputPort.id] = autoFcVar
    return true
  }
  if (inputPort.default !== undefined) {
    inputs[inputPort.id] = formatDefaultValueIR(inputPort.default, inputPort.type)
    return true
  }
  return false
}

/**
 * Resolve a connectable param fallback for IR compilation.
 */
export function resolveParamFallbackIR(
  param: NodeParameter,
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
    inputs[param.id] = formatDefaultValueIR(paramValue, param.type)
  }
}

// ---------------------------------------------------------------------------
// Multi-pass WGSL result (per-pass assembler outputs)
// ---------------------------------------------------------------------------

export interface WGSLPassOutput {
  shaderCode: string
  uniformLayout: import('./ir/wgsl-assembler').UniformBufferLayout
  textureBindings: import('./ir/wgsl-assembler').TextureBinding[]
  inputTextures: Array<{ passIndex: number; samplerName: string }>
  isTimeLive: boolean
  textureFilter?: 'linear' | 'nearest'
}

export interface WGSLMultiPassOutput {
  passes: WGSLPassOutput[]
}

// ---------------------------------------------------------------------------
// Main compile function
// ---------------------------------------------------------------------------

/**
 * Compile a node graph to WGSL via the IR path.
 *
 * Returns a WGSLMultiPassOutput on success (single-pass has 1 pass), or null if:
 * - Any node lacks an ir() function
 * - Compilation fails
 */
export function compileGraphIR(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
): WGSLMultiPassOutput | null {
  try {
    if (hasCycles(nodes, edges)) return null

    const executionOrder = topologicalSort(nodes, edges)
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    // Build edge lookup
    const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
    edges.forEach((edge) => {
      if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
      edgesByTarget.get(edge.target)!.push(edge)
    })

    // Check all nodes have ir() functions
    for (const nodeId of executionOrder) {
      const node = nodeMap.get(nodeId)
      if (!node) continue
      const def = nodeRegistry.get(node.data.type)
      if (!def) return null
      if (!def.ir) return null
    }

    const passPartition = partitionPasses(executionOrder, nodeMap, edgesByTarget)

    if (passPartition === null) {
      // Single-pass fast path
      return compileSinglePassIR(executionOrder, nodeMap, edgesByTarget)
    }

    // Multi-pass compilation
    return compileMultiPassIR(passPartition, nodeMap, edgesByTarget)
  } catch (error) {
    console.error('[Sombra] IR compilation failed:', error)
    return null
  }
}

/**
 * Single-pass IR compilation (no texture boundaries).
 */
function compileSinglePassIR(
  executionOrder: string[],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
): WGSLMultiPassOutput | null {
  const standardUniforms = new Set<string>()
  const userUniforms: UniformSpec[] = []
  const allOutputs: IRNodeOutput[] = []
  const imageSamplers = new Set<string>()

  for (const nodeId of executionOrder) {
    const result = generateNodeIR(
      nodeId, nodeMap, edgesByTarget,
      standardUniforms, userUniforms, imageSamplers,
    )

    if (result.errors.length > 0) return null
    if (!result.output) return null

    if (result.preambleStatements.length > 0) {
      allOutputs.push({
        statements: result.preambleStatements,
        uniforms: [],
        standardUniforms: new Set(),
      })
    }

    allOutputs.push(result.output)
  }

  const assembled = assembleWGSL(
    allOutputs,
    standardUniforms,
    userUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
    [...imageSamplers],
  )

  return {
    passes: [{
      shaderCode: assembled.shaderCode,
      uniformLayout: assembled.uniformLayout,
      textureBindings: assembled.textureBindings,
      inputTextures: [],
      isTimeLive: standardUniforms.has('u_time'),
    }],
  }
}

/**
 * Multi-pass IR compilation — mirrors compileMultiPass() in glsl-generator.ts.
 */
function compileMultiPassIR(
  passPartition: string[][],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
): WGSLMultiPassOutput | null {
  const boundaries = findTextureBoundaries(passPartition, nodeMap, edgesByTarget)
  const passes: WGSLPassOutput[] = []
  const samplerCompiledIndex = new Map<string, number>()

  // nodeId → passIndex lookup
  const nodePassIndex = new Map<string, number>()
  for (let i = 0; i < passPartition.length; i++) {
    for (const id of passPartition[i]) nodePassIndex.set(id, i)
  }

  // Build set of texture boundary target handles for re-emission filtering
  const textureBoundaryKeys = new Set(
    boundaries.map(b => `${b.consumerId}:${b.consumingPortId}`)
  )

  for (let passIdx = 0; passIdx < passPartition.length; passIdx++) {
    const passNodeIds = passPartition[passIdx]
    const isLastPass = passIdx === passPartition.length - 1

    const standardUniforms = new Set<string>()
    const passUserUniforms: UniformSpec[] = []
    const allOutputs: IRNodeOutput[] = []
    const imageSamplers = new Set<string>()

    // Find cross-pass non-texture dependencies that need re-emission
    const reEmitSet = new Set<string>()
    if (passIdx > 0) {
      const queue: string[] = []

      for (const nodeId of passNodeIds) {
        const incoming = edgesByTarget.get(nodeId) || []
        for (const edge of incoming) {
          const sourcePass = nodePassIndex.get(edge.source)
          if (sourcePass !== undefined && sourcePass < passIdx) {
            if (textureBoundaryKeys.has(`${nodeId}:${edge.targetHandle}`)) continue
            if (!reEmitSet.has(edge.source)) {
              reEmitSet.add(edge.source)
              queue.push(edge.source)
            }
          }
        }
      }

      // Transitively include upstream dependencies
      while (queue.length > 0) {
        const id = queue.pop()!
        const incoming = edgesByTarget.get(id) || []
        for (const edge of incoming) {
          const sourcePass = nodePassIndex.get(edge.source)
          if (sourcePass !== undefined && sourcePass < passIdx && !reEmitSet.has(edge.source)) {
            reEmitSet.add(edge.source)
            queue.push(edge.source)
          }
        }
      }
    }

    // Boundaries consumed by nodes in this pass OR by re-emitted nodes.
    // Re-emitted textureInput nodes need their boundaries so they sample
    // the intermediate texture instead of emitting fallback code.
    const passBoundaries = boundaries.filter(b =>
      passNodeIds.includes(b.consumerId) || reEmitSet.has(b.consumerId)
    )

    // Build inputTextures map — use relay compiled index if available
    const inputTextures: Array<{ passIndex: number; samplerName: string }> = []
    const passInputSamplers: string[] = []
    for (const b of passBoundaries) {
      const compiledIdx = samplerCompiledIndex.get(b.samplerName) ?? b.sourcePassIndex
      inputTextures.push({ passIndex: compiledIdx, samplerName: b.samplerName })
      passInputSamplers.push(b.samplerName)
    }

    // Combine re-emitted nodes (in execution order) with pass nodes
    const reEmitNodes = passPartition
      .slice(0, passIdx)
      .flat()
      .filter(id => reEmitSet.has(id))
    const combinedNodeIds = [...reEmitNodes, ...passNodeIds]

    // Generate IR for each node in this pass
    for (const nodeId of combinedNodeIds) {
      const result = generateNodeIR(
        nodeId, nodeMap, edgesByTarget,
        standardUniforms, passUserUniforms, imageSamplers,
        passBoundaries,
      )

      if (result.errors.length > 0) return null
      if (!result.output) return null

      if (result.preambleStatements.length > 0) {
        allOutputs.push({
          statements: result.preambleStatements,
          uniforms: [],
          standardUniforms: new Set(),
        })
      }

      allOutputs.push(result.output)
    }

    // Intermediate passes: fragColor + relay passes for multi-output conflicts
    if (!isLastPass) {
      const outBounds = boundaries.filter(b => b.sourcePassIndex === passIdx)
      const groups = groupBoundariesBySourceOutput(outBounds, edgesByTarget)

      // Save body BEFORE appending any fragColor
      const bodyOutputs = [...allOutputs]

      const resolveGroup = (group: TextureBoundaryEdge[]) => {
        const edge = resolveSourceEdge(group[0], edgesByTarget)
        if (!edge) return null
        const srcDef = nodeMap.get(edge.source) ? nodeRegistry.get(nodeMap.get(edge.source)!.data.type) : undefined
        const srcPort = srcDef?.outputs.find(p => p.id === edge.sourceHandle)
        if (!srcPort) return null
        const srcVar = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
        return {
          fragOutput: { statements: [raw(outputTypeToFragColor(srcVar, srcPort.type))], uniforms: [], standardUniforms: new Set() } as IRNodeOutput,
          textureFilter: srcDef?.textureFilter as 'linear' | 'nearest' | undefined,
        }
      }

      // --- Primary pass ---
      const primaryResolved = groups.length > 0 ? resolveGroup(groups[0]) : null
      if (primaryResolved) allOutputs.push(primaryResolved.fragOutput)

      const assembled = assembleWGSL(
        allOutputs, standardUniforms,
        passUserUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
        [...imageSamplers], passInputSamplers,
      )
      const primaryIdx = passes.length
      if (groups.length > 0) {
        for (const b of groups[0]) samplerCompiledIndex.set(b.samplerName, primaryIdx)
      }
      passes.push({
        shaderCode: assembled.shaderCode, uniformLayout: assembled.uniformLayout,
        textureBindings: assembled.textureBindings, inputTextures,
        isTimeLive: standardUniforms.has('u_time'), textureFilter: primaryResolved?.textureFilter,
      })

      // --- Relay passes ---
      for (let g = 1; g < groups.length; g++) {
        const resolved = resolveGroup(groups[g])
        if (!resolved) continue
        const relayOutputs = [...bodyOutputs, resolved.fragOutput]
        const relayAssembled = assembleWGSL(
          relayOutputs, standardUniforms,
          passUserUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
          [...imageSamplers], passInputSamplers,
        )
        const relayIdx = passes.length
        for (const b of groups[g]) samplerCompiledIndex.set(b.samplerName, relayIdx)
        passes.push({
          shaderCode: relayAssembled.shaderCode, uniformLayout: relayAssembled.uniformLayout,
          textureBindings: relayAssembled.textureBindings, inputTextures,
          isTimeLive: standardUniforms.has('u_time'), textureFilter: resolved.textureFilter,
        })
      }
    } else {
      // Last pass: no relay needed
      const assembled = assembleWGSL(
        allOutputs, standardUniforms,
        passUserUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
        [...imageSamplers], passInputSamplers,
      )
      passes.push({
        shaderCode: assembled.shaderCode, uniformLayout: assembled.uniformLayout,
        textureBindings: assembled.textureBindings, inputTextures,
        isTimeLive: standardUniforms.has('u_time'),
      })
    }
  }

  return { passes }
}
