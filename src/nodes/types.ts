/**
 * Core type definitions for the Sombra node system
 */

/**
 * Port data types supported by the shader system
 */
export type PortType =
  | 'float'      // Single floating point value
  | 'vec2'       // 2D vector
  | 'vec3'       // 3D vector (RGB color)
  | 'vec4'       // 4D vector (RGBA color)
  | 'color'      // Alias for vec3, UI shows color picker
  | 'sampler2D'  // Texture sampler (future)

/**
 * Definition of an input or output port on a node
 */
export interface PortDefinition {
  id: string           // Unique identifier within the node (e.g., "input", "color1")
  label: string        // Display name for the port
  type: PortType       // Data type
  default?: unknown    // Default value when port is unconnected
}

/**
 * Parameters that can be tweaked in the node UI
 */
export interface NodeParameter {
  id: string                    // Unique identifier (e.g., "scale", "strength")
  label: string                 // Display name
  type: 'float' | 'vec2' | 'vec3' | 'color'
  default: number | [number, number] | [number, number, number]
  min?: number                  // For numeric types
  max?: number                  // For numeric types
  step?: number                 // Step increment for sliders
}

/**
 * Context passed to GLSL generator functions
 */
export interface GLSLContext {
  nodeId: string                           // Unique node instance ID
  inputs: Record<string, string>           // Input port IDs -> variable names
  outputs: Record<string, string>          // Output port IDs -> variable names
  params: Record<string, unknown>          // Parameter values
  uniforms: Set<string>                    // Global uniforms to declare
  functions: string[]                      // Global function declarations (outside main)
}

/**
 * Complete definition of a node type
 */
export interface NodeDefinition {
  type: string                             // Node type identifier (e.g., "simplex_noise")
  label: string                            // Display name (e.g., "Simplex Noise")
  category: string                         // Category for organization (e.g., "Noise", "Math")

  inputs: PortDefinition[]                 // Input ports
  outputs: PortDefinition[]                // Output ports
  params?: NodeParameter[]                 // Tweakable parameters

  /**
   * Generate GLSL code for this node
   * @param ctx Context with node ID, port mappings, parameter values
   * @returns GLSL code snippet (variable declarations + calculations)
   */
  glsl: (ctx: GLSLContext) => string

  /**
   * Optional custom React component for node body
   * If not provided, default UI with parameter controls is used
   */
  component?: React.ComponentType<{ nodeId: string; data: Record<string, unknown> }>

  /**
   * Optional description for tooltips/help
   */
  description?: string
}

/**
 * Type coercion rules for connecting mismatched port types
 */
export type CoercionRule = {
  from: PortType
  to: PortType
  glsl: (varName: string) => string  // GLSL conversion expression
}

/**
 * Runtime node instance data (stored in React Flow)
 */
export interface NodeData {
  type: string                      // References NodeDefinition.type
  params: Record<string, unknown>   // Current parameter values
  label?: string                    // Optional custom label
}

/**
 * Edge connection data
 */
export interface EdgeData {
  sourcePort: string  // Source output port ID
  targetPort: string  // Target input port ID
}
