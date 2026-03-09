/**
 * Subgraph compiler — compiles a partial graph ending at any node,
 * wrapping its output into fragColor for preview rendering.
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, GLSLContext, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import { coerceType } from '../nodes/type-coercion'
import {
  assembleFragmentShader,
  formatDefaultValue,
  uniformName,
  paramGlslType,
} from './glsl-generator'

export interface PreviewCompilationResult {
  success: boolean
  fragmentShader: string
  errors: Array<{ message: string; nodeId?: string }>
  isTimeLive: boolean
  userUniforms: UniformSpec[]
  /** The output port type of the target node (for debugging) */
  outputType: string
}

/**
 * Compile a subgraph ending at targetNodeId, wrapping its first output
 * into fragColor for preview rendering.
 */
export function compileNodePreview(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  targetNodeId: string,
): PreviewCompilationResult {
  const errors: Array<{ message: string; nodeId?: string }> = []

  try {
    const targetNode = nodes.find(n => n.id === targetNodeId)
    if (!targetNode) {
      return fail([{ message: `Target node "${targetNodeId}" not found` }])
    }

    const targetDef = nodeRegistry.get(targetNode.data.type)
    if (!targetDef) {
      return fail([{ message: `Unknown node type: ${targetNode.data.type}`, nodeId: targetNodeId }])
    }

    if (targetDef.outputs.length === 0) {
      return fail([{ message: `Node "${targetDef.label}" has no outputs to preview`, nodeId: targetNodeId }])
    }

    if (hasCycles(nodes, edges)) {
      return fail([{ message: 'Graph contains cycles' }])
    }

    // Topological sort from the target node backward
    const executionOrder = topologicalSort(nodes, edges, targetNodeId)

    // Build edge lookup
    const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
    edges.forEach(edge => {
      if (!edgesByTarget.has(edge.target)) edgesByTarget.set(edge.target, [])
      edgesByTarget.get(edge.target)!.push(edge)
    })

    const uniforms = new Set<string>()
    const functions: string[] = []
    const functionRegistry = new Map<string, string>()
    const userUniforms: UniformSpec[] = []
    const glslLines: string[] = []
    const nodeMap = new Map(nodes.map(n => [n.id, n]))

    // Generate GLSL for each node in the subgraph
    // (same codegen as compileGraph)
    for (const nodeId of executionOrder) {
      const node = nodeMap.get(nodeId)
      if (!node) continue

      const definition = nodeRegistry.get(node.data.type)
      if (!definition) {
        errors.push({ message: `Unknown node type: ${node.data.type}`, nodeId: node.id })
        continue
      }

      const inputs: Record<string, string> = {}
      const incomingEdges = edgesByTarget.get(nodeId) || []
      const sanitizedNodeId = nodeId.replace(/-/g, '_')
      const preambleLines: string[] = []

      const resolvedInputs = definition.dynamicInputs
        ? definition.dynamicInputs(node.data.params || {})
        : definition.inputs

      resolvedInputs.forEach(inputPort => {
        const edge = incomingEdges.find(e => e.targetHandle === inputPort.id)

        if (edge) {
          const sourceNode = nodeMap.get(edge.source)
          if (sourceNode) {
            const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
            if (sourceDefinition) {
              const sourcePort = sourceDefinition.outputs.find(p => p.id === edge.sourceHandle)
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
            // Source deleted — fall back to default
            resolveDefault(inputPort, sanitizedNodeId, preambleLines, inputs, uniforms)
          }
        } else {
          resolveDefault(inputPort, sanitizedNodeId, preambleLines, inputs, uniforms)
        }
      })

      // Resolve connectable params
      if (definition.params) {
        for (const param of definition.params) {
          if (!param.connectable) continue
          const edge = incomingEdges.find(e => e.targetHandle === param.id)
          if (edge) {
            const sourceNode = nodeMap.get(edge.source)
            if (sourceNode) {
              const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
              if (sourceDefinition) {
                const sourcePort = sourceDefinition.outputs.find(p => p.id === edge.sourceHandle)
                if (sourcePort) {
                  const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`
                  if (sourcePort.type !== param.type) {
                    inputs[param.id] = coerceType(sourceVarName, sourcePort.type, param.type as import('../nodes/types').PortType)
                  } else {
                    inputs[param.id] = sourceVarName
                  }
                }
              }
            } else {
              resolveParamValue(param, node, sanitizedNodeId, inputs, userUniforms)
            }
          } else {
            resolveParamValue(param, node, sanitizedNodeId, inputs, userUniforms)
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
      definition.outputs.forEach(outputPort => {
        outputs[outputPort.id] = `node_${sanitizedNodeId}_${outputPort.id}`
      })

      const context: GLSLContext = {
        nodeId: node.id,
        inputs,
        outputs,
        params: node.data.params || {},
        uniforms,
        functions,
        functionRegistry,
      }

      try {
        const glsl = definition.glsl(context)
        glslLines.push(`  // ${definition.label} (${node.id})`)
        for (const line of preambleLines) glslLines.push(`  ${line}`)
        glslLines.push(`  ${glsl}`)
      } catch (error) {
        errors.push({
          message: `GLSL generation failed: ${error instanceof Error ? error.message : String(error)}`,
          nodeId: node.id,
        })
      }
    }

    if (errors.length > 0) return fail(errors)

    // Append synthetic fragColor assignment wrapping the target's first output
    const targetOutput = targetDef.outputs[0]
    const targetSanitized = targetNodeId.replace(/-/g, '_')
    const targetVar = `node_${targetSanitized}_${targetOutput.id}`
    const outputType = targetOutput.type

    let fragColorLine: string
    switch (outputType) {
      case 'float':
        fragColorLine = `  fragColor = vec4(vec3(${targetVar}), 1.0);`
        break
      case 'vec2':
        fragColorLine = `  fragColor = vec4(${targetVar}, 0.0, 1.0);`
        break
      case 'vec3':
      case 'color':
        fragColorLine = `  fragColor = vec4(${targetVar}, 1.0);`
        break
      case 'vec4':
        fragColorLine = `  fragColor = ${targetVar};`
        break
      default:
        fragColorLine = `  fragColor = vec4(vec3(${targetVar}), 1.0);`
    }
    glslLines.push(fragColorLine)

    const fragmentShader = assembleFragmentShader(uniforms, functions, functionRegistry, glslLines, userUniforms)

    return {
      success: true,
      fragmentShader,
      errors: [],
      isTimeLive: uniforms.has('u_time'),
      userUniforms,
      outputType,
    }
  } catch (error) {
    return fail([{
      message: `Preview compilation failed: ${error instanceof Error ? error.message : String(error)}`,
    }])
  }
}

function fail(errors: Array<{ message: string; nodeId?: string }>): PreviewCompilationResult {
  return { success: false, fragmentShader: '', errors, isTimeLive: false, userUniforms: [], outputType: '' }
}

function resolveDefault(
  inputPort: { id: string; type: string; default?: unknown },
  sanitizedNodeId: string,
  preambleLines: string[],
  inputs: Record<string, string>,
  uniforms: Set<string>,
) {
  if (inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
    const v = `node_${sanitizedNodeId}_auto_uv`
    preambleLines.push(`vec2 ${v} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;`)
    uniforms.add('u_resolution')
    uniforms.add('u_ref_size')
    inputs[inputPort.id] = v
  } else if (inputPort.default === 'auto_fragcoord' && inputPort.type === 'vec2') {
    const v = `node_${sanitizedNodeId}_auto_fc`
    preambleLines.push(`vec2 ${v} = gl_FragCoord.xy;`)
    inputs[inputPort.id] = v
  } else if (inputPort.default !== undefined) {
    inputs[inputPort.id] = formatDefaultValue(inputPort.default, inputPort.type)
  }
}

function resolveParamValue(
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
