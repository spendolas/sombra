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

    // Track uniforms needed
    const uniforms = new Set<string>()

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

      definition.inputs.forEach((inputPort) => {
        const edge = incomingEdges.find((e) => e.targetHandle === inputPort.id)

        if (edge) {
          // Input is connected - use source node's output variable
          const sourceNode = nodeMap.get(edge.source)
          if (sourceNode) {
            const sourceDefinition = nodeRegistry.get(sourceNode.data.type)
            if (sourceDefinition) {
              const sourcePort = sourceDefinition.outputs.find(
                (p) => p.id === edge.sourceHandle
              )
              if (sourcePort) {
                const sourceVarName = `node_${edge.source}_${edge.sourceHandle}`

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
        } else {
          // Input is not connected - use default value
          if (inputPort.default !== undefined) {
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

      // Build output variable names
      const outputs: Record<string, string> = {}
      definition.outputs.forEach((outputPort) => {
        outputs[outputPort.id] = `node_${nodeId}_${outputPort.id}`
      })

      // Generate GLSL for this node
      const context: GLSLContext = {
        nodeId: node.id,
        inputs,
        outputs,
        params: node.data.params || {},
        uniforms,
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
    const fragmentShader = assembleFragmentShader(uniforms, glslLines)

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
    return `${Number(value)}`
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

  return `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

${uniformDeclarations.join('\n')}

void main() {
${glslLines.join('\n')}
}
`
}
