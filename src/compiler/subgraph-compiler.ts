/**
 * Subgraph compiler — compiles a partial graph ending at any node,
 * wrapping its output into fragColor for preview rendering.
 *
 * Phase 6: Supports multi-pass previews via shared generateNodeGlsl().
 * [P8] Depth limit: >3 passes returns a placeholder flag.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import {
  assembleFragmentShader,
  generateNodeGlsl,
  partitionPasses,
  findTextureBoundaries,
  outputTypeToFragColor,
} from './glsl-generator'

/** Maximum passes for preview rendering. Beyond this, show placeholder. [P8] */
const MAX_PREVIEW_PASSES = 6

export interface PreviewPass {
  fragmentShader: string
  userUniforms: UniformSpec[]
  inputTextures: Record<string, number>
}

export interface PreviewCompilationResult {
  success: boolean
  fragmentShader: string
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLive: boolean
  userUniforms: UniformSpec[]
  outputType: string
  /** Multi-pass preview data. Empty for single-pass. */
  passes: PreviewPass[]
  /** True when depth exceeds MAX_PREVIEW_PASSES — show placeholder instead. */
  depthExceeded: boolean
}

/**
 * Compile a subgraph ending at targetNodeId, wrapping its first output
 * into fragColor for preview rendering. Supports multi-pass via textureInput.
 */
export function compileNodePreview(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  targetNodeId: string,
): PreviewCompilationResult {
  try {
    const targetNode = nodes.find(n => n.id === targetNodeId)
    if (!targetNode) return fail([{ message: `Target node "${targetNodeId}" not found` }])

    const targetDef = nodeRegistry.get(targetNode.data.type)
    if (!targetDef) return fail([{ message: `Unknown node type: ${targetNode.data.type}`, nodeId: targetNodeId }])

    if (targetDef.outputs.length === 0) {
      return fail([{ message: `Node "${targetDef.label}" has no outputs to preview`, nodeId: targetNodeId }])
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
      return compileSinglePassPreview(executionOrder, nodeMap, edgesByTarget, targetNodeId, targetDef)
    }

    // [P8] Depth limit
    if (passPartition.length > MAX_PREVIEW_PASSES) {
      return {
        success: true,
        fragmentShader: '',
        errors: [],
        isTimeLive: false,
        userUniforms: [],
        outputType: targetDef.outputs[0].type,
        passes: [],
        depthExceeded: true,
      }
    }

    // Multi-pass preview
    return compileMultiPassPreview(passPartition, nodeMap, edgesByTarget, targetNodeId, targetDef)
  } catch (error) {
    return fail([{
      message: `Preview compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    }])
  }
}

function compileSinglePassPreview(
  executionOrder: string[],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  targetNodeId: string,
  targetDef: import('../nodes/types').NodeDefinition,
): PreviewCompilationResult {
  const errors: Array<{ message: string; nodeId?: string }> = []
  const uniforms = new Set<string>()
  const functions: string[] = []
  const functionRegistry = new Map<string, string>()
  const userUniforms: UniformSpec[] = []
  const glslLines: string[] = []

  for (const nodeId of executionOrder) {
    const result = generateNodeGlsl(
      nodeId, nodeMap, edgesByTarget,
      uniforms, functions, functionRegistry, userUniforms,
    )
    glslLines.push(...result.glslLines)
    errors.push(...result.errors)
  }

  if (errors.length > 0) return fail(errors)

  // Append fragColor from target's first output
  const targetOutput = targetDef.outputs[0]
  const targetVar = `node_${targetNodeId.replace(/-/g, '_')}_${targetOutput.id}`
  glslLines.push(outputTypeToFragColor(targetVar, targetOutput.type))

  const fragmentShader = assembleFragmentShader(uniforms, functions, functionRegistry, glslLines, userUniforms)

  return {
    success: true,
    fragmentShader,
    errors: [],
    isTimeLive: uniforms.has('u_time'),
    userUniforms,
    outputType: targetOutput.type,
    passes: [],
    depthExceeded: false,
  }
}

function compileMultiPassPreview(
  passPartition: string[][],
  nodeMap: Map<string, Node<NodeData>>,
  edgesByTarget: Map<string, Edge<EdgeData>[]>,
  targetNodeId: string,
  targetDef: import('../nodes/types').NodeDefinition,
): PreviewCompilationResult {
  const boundaries = findTextureBoundaries(passPartition, nodeMap, edgesByTarget)
  const passes: PreviewPass[] = []
  const allUserUniforms: UniformSpec[] = []
  let globalTimeLive = false

  // nodeId → passIndex lookup (for cross-pass re-emission)
  const nodePassIndex = new Map<string, number>()
  for (let i = 0; i < passPartition.length; i++) {
    for (const id of passPartition[i]) nodePassIndex.set(id, i)
  }
  const textureBoundaryKeys = new Set(
    boundaries.map(b => `${b.consumerId}:${b.consumingPortId}`)
  )

  for (let passIdx = 0; passIdx < passPartition.length; passIdx++) {
    const passNodeIds = passPartition[passIdx]
    const isLastPass = passIdx === passPartition.length - 1

    const uniforms = new Set<string>()
    const functions: string[] = []
    const functionRegistry = new Map<string, string>()
    const passUserUniforms: UniformSpec[] = []
    const glslLines: string[] = []

    const passBoundaries = boundaries.filter(b => passNodeIds.includes(b.consumerId))
    const samplerNames = passBoundaries.map(b => b.samplerName)

    const inputTextures: Record<string, number> = {}
    for (const b of passBoundaries) {
      inputTextures[b.samplerName] = b.sourcePassIndex
    }

    // Re-emit nodes from earlier passes that are referenced via non-texture edges
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
    const reEmitNodes = passPartition.slice(0, passIdx).flat().filter(id => reEmitSet.has(id))
    const combinedNodeIds = [...reEmitNodes, ...passNodeIds]

    const allErrors: Array<{ message: string; nodeId?: string }> = []
    for (const nodeId of combinedNodeIds) {
      const result = generateNodeGlsl(
        nodeId, nodeMap, edgesByTarget,
        uniforms, functions, functionRegistry, passUserUniforms,
        passBoundaries,
      )
      glslLines.push(...result.glslLines)
      allErrors.push(...result.errors)
    }

    if (allErrors.length > 0) return fail(allErrors)

    // fragColor output
    if (isLastPass) {
      // Last pass: output target node's value
      const targetOutput = targetDef.outputs[0]
      const targetVar = `node_${targetNodeId.replace(/-/g, '_')}_${targetOutput.id}`
      glslLines.push(outputTypeToFragColor(targetVar, targetOutput.type))
    } else {
      // Intermediate pass: output the node feeding the next pass's textureInput
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

    if (uniforms.has('u_time')) globalTimeLive = true

    passes.push({ fragmentShader, userUniforms: passUserUniforms, inputTextures })
    allUserUniforms.push(...passUserUniforms)
  }

  const lastPass = passes[passes.length - 1]

  return {
    success: true,
    fragmentShader: lastPass.fragmentShader,
    errors: [],
    isTimeLive: globalTimeLive,
    userUniforms: allUserUniforms,
    outputType: targetDef.outputs[0].type,
    passes,
    depthExceeded: false,
  }
}

function fail(errors: Array<{ message: string; nodeId?: string }>): PreviewCompilationResult {
  return {
    success: false, fragmentShader: '', errors, isTimeLive: false,
    userUniforms: [], outputType: '', passes: [], depthExceeded: false,
  }
}
