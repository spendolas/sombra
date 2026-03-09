/**
 * GLSL code generator - compiles node graph to shader code
 */

import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData, GLSLContext, UniformSpec } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { topologicalSort, hasCycles } from './topological-sort'
import { coerceType } from '../nodes/type-coercion'

function uniformName(sanitizedNodeId: string, paramId: string): string {
  return `u_${sanitizedNodeId}_${paramId}`
}

function paramGlslType(paramType: string): 'float' | 'vec2' | 'vec3' | 'vec4' {
  if (paramType === 'vec2') return 'vec2'
  if (paramType === 'vec3' || paramType === 'color') return 'vec3'
  if (paramType === 'vec4') return 'vec4'
  return 'float'
}

/**
 * Compilation result
 */
export interface CompilationResult {
  success: boolean
  vertexShader: string
  fragmentShader: string
  errors: Array<{ message: string; nodeId?: string }>
  /** True when u_time has a live dependency path to fragment output.
   *  Topological sort prunes unreachable nodes, so uniforms.has('u_time')
   *  after codegen is the correct signal. Used by renderer (Phase 3)
   *  to choose continuous RAF loop vs render-on-demand. */
  isTimeLiveAtOutput: boolean
  /** User-defined uniforms from uniform-mode params (unwired only) */
  userUniforms: UniformSpec[]
  /** Quality tier from fragment_output node ('adaptive' | 'low' | 'medium' | 'high') */
  qualityTier: string
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
        isTimeLiveAtOutput: false,
        userUniforms: [],
        qualityTier: 'adaptive',
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
    const userUniforms: UniformSpec[] = []

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
      const sanitizedNodeId = nodeId.replace(/-/g, '_')
      const preambleLines: string[] = []

      // Use dynamicInputs when available, otherwise static inputs
      const resolvedInputs = definition.dynamicInputs
        ? definition.dynamicInputs(node.data.params || {})
        : definition.inputs

      resolvedInputs.forEach((inputPort) => {
        const edge = incomingEdges.find((e) => e.targetHandle === inputPort.id)

        if (edge) {
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
          } else {
            // Source node was deleted but edge lingers — fall back to default
            if (inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
              const autoUvVar = `node_${sanitizedNodeId}_auto_uv`
              preambleLines.push(`vec2 ${autoUvVar} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;`)
              uniforms.add('u_resolution')
              uniforms.add('u_ref_size')
              inputs[inputPort.id] = autoUvVar
            } else if (inputPort.default === 'auto_fragcoord' && inputPort.type === 'vec2') {
              const autoFcVar = `node_${sanitizedNodeId}_auto_fc`
              preambleLines.push(`vec2 ${autoFcVar} = gl_FragCoord.xy;`)
              inputs[inputPort.id] = autoFcVar
            } else if (inputPort.default !== undefined) {
              inputs[inputPort.id] = formatDefaultValue(inputPort.default, inputPort.type)
            }
          }
        } else {
          // Input is not connected - use default value
          if (inputPort.default === 'auto_uv' && inputPort.type === 'vec2') {
            // auto_uv sentinel: generate frozen-ref UV inline
            const autoUvVar = `node_${sanitizedNodeId}_auto_uv`
            preambleLines.push(`vec2 ${autoUvVar} = (v_uv - 0.5) * u_resolution / u_ref_size + 0.5;`)
            uniforms.add('u_resolution')
            uniforms.add('u_ref_size')
            inputs[inputPort.id] = autoUvVar
          } else if (inputPort.default === 'auto_fragcoord' && inputPort.type === 'vec2') {
            // auto_fragcoord sentinel: use raw screen-space pixel coordinates
            const autoFcVar = `node_${sanitizedNodeId}_auto_fc`
            preambleLines.push(`vec2 ${autoFcVar} = gl_FragCoord.xy;`)
            inputs[inputPort.id] = autoFcVar
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
            } else {
              // Source node was deleted but edge lingers — fall back to param value
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
          } else {
            // Not wired: use param value from node data
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
        }
      }

      // Non-connectable uniform params → inject into inputs for node glsl()
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
    }

    if (errors.length > 0) {
      return {
        success: false,
        vertexShader: '',
        fragmentShader: '',
        errors,
        isTimeLiveAtOutput: false,
        userUniforms: [],
        qualityTier: 'adaptive',
      }
    }

    // Assemble complete fragment shader
    const fragmentShader = assembleFragmentShader(uniforms, functions, functionRegistry, glslLines, userUniforms)

    // Debug: Log generated shader
    console.log('[Sombra] Generated Fragment Shader:')
    console.log(fragmentShader)

    // Read quality tier from fragment_output node
    const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
    const qualityTier = (outputNode?.data.params?.quality as string) ?? 'adaptive'

    return {
      success: true,
      vertexShader: VERTEX_SHADER,
      fragmentShader,
      errors: [],
      isTimeLiveAtOutput: uniforms.has('u_time'),
      userUniforms,
      qualityTier,
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
      isTimeLiveAtOutput: false,
      userUniforms: [],
      qualityTier: 'adaptive',
    }
  }
}

/** Coerce unknown value to a safe GLSL float literal (NaN/Infinity → 0.0) */
function safeFloat(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0.0'
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

/**
 * Format a default value as GLSL
 */
function formatDefaultValue(value: unknown, type: string): string {
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
function assembleFragmentShader(
  uniforms: Set<string>,
  functions: string[],
  functionRegistry: Map<string, string>,
  glslLines: string[],
  userUniforms: UniformSpec[]
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
  if (uniforms.has('u_dpr')) {
    uniformDeclarations.push('uniform float u_dpr;')
  }

  // Add user-defined uniforms from uniform-mode params
  for (const spec of userUniforms) {
    uniformDeclarations.push(`uniform ${spec.glslType} ${spec.name};`)
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
