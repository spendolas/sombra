/**
 * IR subgraph compiler — compiles a partial graph ending at any node,
 * producing WGSL output for WebGPU preview rendering.
 *
 * Mirrors subgraph-compiler.ts but uses the IR path:
 * generateNodeIR() + assembleWGSL() instead of generateNodeGlsl() + assembleFragmentShader().
 *
 * Supports single-pass and multi-pass subgraphs (texture boundaries).
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, UniformSpec } from '../nodes/types'
import type { IRNodeOutput } from './ir/types'
import { raw } from './ir/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import {
  partitionPasses,
  findTextureBoundaries,
  outputTypeToFragColor,
  resolveSourceEdge,
  groupBoundariesBySourceOutput,
} from './glsl-generator'
import type { TextureBoundaryEdge } from './glsl-generator'
import { assembleWGSL } from './ir/wgsl-assembler'
import type { WGSLPassOutput } from './ir-compiler'
import { generateNodeIR } from './ir-compiler'

/** Maximum passes for preview rendering. Beyond this, show placeholder. */
const MAX_PREVIEW_PASSES = 6

export interface IRPreviewCompilationResult {
  success: boolean
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLive: boolean
  outputType: string
  /** True when depth exceeds MAX_PREVIEW_PASSES — show placeholder instead. */
  depthExceeded: boolean
  /** WGSL passes — same shape as RenderPlan.wgsl.passes */
  wgslPasses: WGSLPassOutput[]
  /** User uniform specs (name + value for the scheduler to upload) */
  userUniforms: UniformSpec[]
}

/**
 * Compile a subgraph ending at targetNodeId via the IR→WGSL path.
 * Returns WGSL shader code + uniform layout for WebGPU preview rendering.
 */
export function compileNodePreviewIR(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  targetNodeId: string,
): IRPreviewCompilationResult {
  try {
    const targetNode = nodes.find(n => n.id === targetNodeId)
    if (!targetNode) return fail([{ message: `Target node "${targetNodeId}" not found` }])

    const targetDef = nodeRegistry.get(targetNode.data.type)
    if (!targetDef) return fail([{ message: `Unknown node type: ${targetNode.data.type}`, nodeId: targetNodeId }])

    if (targetDef.outputs.length === 0) {
      return fail([{ message: `Node "${targetDef.label}" has no outputs to preview`, nodeId: targetNodeId }])
    }

    if (!targetDef.ir) {
      return fail([{ message: `Node "${targetDef.label}" has no ir() function`, nodeId: targetNodeId }])
    }

    if (hasCycles(nodes, edges)) return fail([{ message: 'Graph contains cycles' }])

    const executionOrder = topologicalSort(nodes, edges, targetNodeId)
    const nodeMap = new Map(nodes.map(n => [n.id, n]))

    // Build edge lookup
    const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
    edges.forEach(edge => {
      if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
      edgesByTarget.get(edge.target)!.push(edge)
    })

    // Check for multi-pass
    const passPartition = partitionPasses(executionOrder, nodeMap, edgesByTarget)

    if (!passPartition) {
      // Single-pass preview
      return compileSinglePass(executionOrder, nodeMap, edgesByTarget, targetNodeId, targetDef)
    }

    // Depth limit
    if (passPartition.length > MAX_PREVIEW_PASSES) {
      return {
        success: true,
        errors: [],
        isTimeLive: false,
        outputType: targetDef.outputs[0].type,
        depthExceeded: true,
        wgslPasses: [],
        userUniforms: [],
      }
    }

    // Multi-pass preview
    return compileMultiPass(passPartition, nodeMap, edgesByTarget, targetNodeId, targetDef)
  } catch (error) {
    return fail([{
      message: `IR preview compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    }])
  }
}

function compileSinglePass(
  executionOrder: string[],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  targetNodeId: string,
  targetDef: import('../nodes/types').NodeDefinition,
): IRPreviewCompilationResult {
  const standardUniforms = new Set<string>()
  const userUniforms: UniformSpec[] = []
  const allOutputs: IRNodeOutput[] = []
  const imageSamplers = new Set<string>()
  const errors: Array<{ message: string; nodeId?: string }> = []

  for (const nodeId of executionOrder) {
    const result = generateNodeIR(
      nodeId, nodeMap, edgesByTarget,
      standardUniforms, userUniforms, imageSamplers,
    )

    if (result.errors.length > 0) return fail(result.errors)
    if (!result.output) return fail([{ message: `IR generation returned null for ${nodeId}` }])

    if (result.preambleStatements.length > 0) {
      allOutputs.push({
        statements: result.preambleStatements,
        uniforms: [],
        standardUniforms: new Set(),
      })
    }

    allOutputs.push(result.output)
  }

  // Append fragColor from target's first output
  const targetOutput = targetDef.outputs[0]
  const targetVar = `node_${targetNodeId.replace(/-/g, '_')}_${targetOutput.id}`
  const glslOutput = outputTypeToFragColor(targetVar, targetOutput.type)
  allOutputs.push({
    statements: [raw(glslOutput)],
    uniforms: [],
    standardUniforms: new Set(),
  })

  const assembled = assembleWGSL(
    allOutputs,
    standardUniforms,
    userUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
    [...imageSamplers],
  )

  return {
    success: true,
    errors,
    isTimeLive: standardUniforms.has('u_time'),
    outputType: targetOutput.type,
    depthExceeded: false,
    wgslPasses: [{
      shaderCode: assembled.shaderCode,
      uniformLayout: assembled.uniformLayout,
      textureBindings: assembled.textureBindings,
      inputTextures: [],
      isTimeLive: standardUniforms.has('u_time'),
    }],
    userUniforms,
  }
}

function compileMultiPass(
  passPartition: string[][],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  targetNodeId: string,
  targetDef: import('../nodes/types').NodeDefinition,
): IRPreviewCompilationResult {
  const boundaries = findTextureBoundaries(passPartition, nodeMap, edgesByTarget)
  const passes: WGSLPassOutput[] = []
  const allUserUniforms: UniformSpec[] = []
  let globalTimeLive = false
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

    // Boundaries consumed by nodes in this pass OR by re-emitted nodes
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

      if (result.errors.length > 0) return fail(result.errors)
      if (!result.output) return fail([{ message: `IR generation returned null for ${nodeId}` }])

      if (result.preambleStatements.length > 0) {
        allOutputs.push({
          statements: result.preambleStatements,
          uniforms: [],
          standardUniforms: new Set(),
        })
      }

      allOutputs.push(result.output)
    }

    // Intermediate passes: write fragColor + handle multi-output conflicts via relay passes
    if (!isLastPass) {
      const outBounds = boundaries.filter(b => b.sourcePassIndex === passIdx)
      const groups = groupBoundariesBySourceOutput(outBounds, edgesByTarget)

      // Save body BEFORE appending any fragColor
      const bodyOutputs = [...allOutputs]

      // Helper: resolve fragColor IR output + textureFilter for a boundary group
      const resolveGroup = (group: TextureBoundaryEdge[]) => {
        const edge = resolveSourceEdge(group[0], edgesByTarget)
        if (!edge) return null
        const srcDef = nodeMap.get(edge.source)
          ? nodeRegistry.get(nodeMap.get(edge.source)!.data.type)
          : undefined
        const srcPort = srcDef?.outputs.find(p => p.id === edge.sourceHandle)
        if (!srcPort) return null
        const srcVar = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
        return {
          fragOutput: {
            statements: [raw(outputTypeToFragColor(srcVar, srcPort.type))],
            uniforms: [],
            standardUniforms: new Set(),
          } as IRNodeOutput,
          textureFilter: srcDef?.textureFilter as 'linear' | 'nearest' | undefined,
        }
      }

      // --- Primary pass (first group) ---
      const primaryResolved = groups.length > 0 ? resolveGroup(groups[0]) : null
      if (primaryResolved) allOutputs.push(primaryResolved.fragOutput)

      const assembled = assembleWGSL(
        allOutputs, standardUniforms,
        passUserUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
        [...imageSamplers], passInputSamplers,
      )

      if (standardUniforms.has('u_time')) globalTimeLive = true

      const primaryIdx = passes.length
      if (groups.length > 0) {
        for (const b of groups[0]) samplerCompiledIndex.set(b.samplerName, primaryIdx)
      }

      passes.push({
        shaderCode: assembled.shaderCode,
        uniformLayout: assembled.uniformLayout,
        textureBindings: assembled.textureBindings,
        inputTextures,
        isTimeLive: standardUniforms.has('u_time'),
        textureFilter: primaryResolved?.textureFilter,
      })

      // --- Relay passes (remaining groups) ---
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
          shaderCode: relayAssembled.shaderCode,
          uniformLayout: relayAssembled.uniformLayout,
          textureBindings: relayAssembled.textureBindings,
          inputTextures,
          isTimeLive: standardUniforms.has('u_time'),
          textureFilter: resolved.textureFilter,
        })
      }
    } else {
      // Last pass: output target node's value
      const targetOutput = targetDef.outputs[0]
      const targetVar = `node_${targetNodeId.replace(/-/g, '_')}_${targetOutput.id}`
      const glslOutput = outputTypeToFragColor(targetVar, targetOutput.type)
      allOutputs.push({
        statements: [raw(glslOutput)],
        uniforms: [],
        standardUniforms: new Set(),
      })

      const assembled = assembleWGSL(
        allOutputs, standardUniforms,
        passUserUniforms.map(u => ({ name: u.name, glslType: u.glslType })),
        [...imageSamplers], passInputSamplers,
      )

      if (standardUniforms.has('u_time')) globalTimeLive = true

      passes.push({
        shaderCode: assembled.shaderCode,
        uniformLayout: assembled.uniformLayout,
        textureBindings: assembled.textureBindings,
        inputTextures,
        isTimeLive: standardUniforms.has('u_time'),
      })
    }

    allUserUniforms.push(...passUserUniforms)
  }

  return {
    success: true,
    errors: [],
    isTimeLive: globalTimeLive,
    outputType: targetDef.outputs[0].type,
    depthExceeded: false,
    wgslPasses: passes,
    userUniforms: allUserUniforms,
  }
}

function fail(errors: Array<{ message: string; nodeId?: string }>): IRPreviewCompilationResult {
  return {
    success: false, errors, isTimeLive: false,
    outputType: '', depthExceeded: false,
    wgslPasses: [], userUniforms: [],
  }
}
