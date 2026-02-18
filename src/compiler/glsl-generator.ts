/**
 * GLSL code generator - compiles node graph to shader code
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, GLSLContext } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import { coerceType } from '../nodes/type-coercion'

/**
 * Compilation result
 */
export interface CompilationResult {
  success: boolean
  vertexShader: string
  fragmentShader: string
  errors: Array<{ message: string; nodeId?: string }>
}

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

/**
 * Compile node graph to GLSL shaders
 *
 * @param nodes All nodes in the graph
 * @param edges All edges connecting nodes
 * @returns Compilation result with shaders or errors
 */
export function compileGraph(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[]
): CompilationResult {
  const errors: Array<{ message: string; nodeId?: string }> = []

  try {
    // Check for cycles
    if (hasCycles(nodes, edges)) {
      return {
        success: false,
        vertexShader: '',
        fragmentShader: '',
        errors: [{ message: 'Graph contains cycles. Remove circular dependencies.' }],
      }
    }

    // Get execution order
    const executionOrder = topologicalSort(nodes, edges)

    // Build edge lookup maps
    const edgesByTarget = new Map<string, Edge<EdgeData>[]>()
    edges.forEach((edge) => {
      if (!edgesByTarget.has(edge.target)) {
        edgesByTarget.set(edge.target, [])
      }
      edgesByTarget.get(edge.target)!.push(edge)
    })

    // Track uniforms and functions needed
    const uniforms = new Set<string>()
    const functions: string[] = []
    const functionRegistry = new Map<string, string>()

    // Generate GLSL code for each node
    const glslLines: string[] = []
    const nodeMap = new Map(nodes.map((n) => [n.id, n]))

    for (const nodeId of executionOrder) {
      const node = nodeMap.get(nodeId)
      if (!node) continue

      const definition = nodeRegistry.get(node.data.type)
      if (!definition) {
        errors.push({
          message: `Unknown node type: ${node.data.type}`,
          nodeId: node.id,
        })
        continue
      }

      // Build input variable names (from connected edges or defaults)
      const inputs: Record<string, string> = {}
      const incomingEdges = edgesByTarget.get(nodeId) || []

      // Use dynamicInputs when available, otherwise static inputs
      const resolvedInputs = definition.dynamicInputs
        ? definition.dynamicInputs(node.data.params || {})
        : definition.inputs

      resolvedInputs.forEach((inputPort) => {
        const edge = incomingEdges.find((e) => e.targetHandle === inputPort.id)

        if (edge) {
          if (inputPort.type === 'fnref') {
            // fnref input: resolve to source node's functionKey
            const sourceNode = nodeMap.get(edge.source)
            if (sourceNode) {
              const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
              if (sourceDefinition?.functionKey) {
                const key = typeof sourceDefinition.functionKey === 'function'
                  ? sourceDefinition.functionKey(sourceNode.data.params || {})
                  : sourceDefinition.functionKey
                inputs[inputPort.id] = key
              } else {
                errors.push({
                  message: `Source node "${sourceNode.data.type}" has no functionKey for fnref port`,
                  nodeId: node.id,
                })
              }
            }
          } else {
            // Value input: use source node's output variable
            const sourceNode = nodeMap.get(edge.source)
            if (sourceNode) {
              const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
              if (sourceDefinition) {
                const sourcePort = sourceDefinition.outputs.find(
                  (p) => p.id === edge.sourceHandle
                )
                if (sourcePort) {
                  // Sanitize node ID for GLSL (replace hyphens with underscores)
                  const sourceVarName = `node_${edge.source.replace(/-/g, '_')}_${edge.sourceHandle}`

                  // Apply type coercion if needed
                  if (sourcePort.type !== inputPort.type) {
                    inputs[inputPort.id] = coerceType(
                      sourceVarName,
                      sourcePort.type,
                      inputPort.type
                    )
                  } else {
                    inputs[inputPort.id] = sourceVarName
                  }
                }
              }
            }
          }
        } else {
          // Input is not connected - use default value
          if (inputPort.type === 'fnref') {
            // fnref unconnected: default is a function name string
            inputs[inputPort.id] = String(inputPort.default ?? '')
          } else if (inputPort.default !== undefined) {
            const defaultValue = formatDefaultValue(inputPort.default, inputPort.type)
            inputs[inputPort.id] = defaultValue
          } else {
            errors.push({
              message: `Input "${inputPort.label}" on ${definition.label} has no connection and no default`,
              nodeId: node.id,
            })
          }
        }
      })

      // Resolve connectable params as additional inputs
      if (definition.params) {
        for (const param of definition.params) {
          if (!param.connectable) continue

          const edge = incomingEdges.find((e) => e.targetHandle === param.id)

          if (edge) {
            // Wired: resolve to source variable
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
            }
          } else {
            // Not wired: use param value from node data
            const paramValue = node.data.params?.[param.id] ?? param.default
            inputs[param.id] = formatDefaultValue(paramValue, param.type)
          }
        }
      }

      // Build output variable names (sanitize node ID for GLSL)
      const outputs: Record<string, string> = {}
      const sanitizedNodeId = nodeId.replace(/-/g, '_')
      definition.outputs.forEach((outputPort) => {
        outputs[outputPort.id] = `node_${sanitizedNodeId}_${outputPort.id}`
      })

      // Generate GLSL for this node
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
        glslLines.push(`  ${glsl}`)
      } catch (error) {
        errors.push({
          message: `GLSL generation failed: ${error instanceof Error ? error.message : String(error)}`,
          nodeId: node.id,
        })
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        vertexShader: '',
        fragmentShader: '',
        errors,
      }
    }

    // Assemble complete fragment shader
    const fragmentShader = assembleFragmentShader(uniforms, functions, functionRegistry, glslLines)

    // Debug: Log generated shader
    console.log('[Sombra] Generated Fragment Shader:')
    console.log(fragmentShader)

    return {
      success: true,
      vertexShader: VERTEX_SHADER,
      fragmentShader,
      errors: [],
    }
  } catch (error) {
    return {
      success: false,
      vertexShader: '',
      fragmentShader: '',
      errors: [
        {
          message: `Compilation failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }
}

/**
 * Format a default value as GLSL
 */
function formatDefaultValue(value: unknown, type: string): string {
  if (type === 'float') {
    const n = Number(value)
    return Number.isInteger(n) ? `${n}.0` : `${n}`
  }
  if (type === 'vec2' && Array.isArray(value)) {
    return `vec2(${value[0]}, ${value[1]})`
  }
  if (type === 'vec3' && Array.isArray(value)) {
    return `vec3(${value[0]}, ${value[1]}, ${value[2]})`
  }
  if (type === 'vec4' && Array.isArray(value)) {
    return `vec4(${value[0]}, ${value[1]}, ${value[2]}, ${value[3]})`
  }
  return '0.0'
}

/**
 * Assemble the complete fragment shader
 */
function assembleFragmentShader(
  uniforms: Set<string>,
  functions: string[],
  functionRegistry: Map<string, string>,
  glslLines: string[]
): string {
  const uniformDeclarations: string[] = []

  // Add standard uniforms
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
