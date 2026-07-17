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
  | 'color'      // RGBA (vec4-backed), UI shows color picker
  | 'sampler2D'  // Texture sampler (future)

/**
 * Definition of an input or output port on a node
 */
export interface PortDefinition {
  id: string           // Unique identifier within the node (e.g., "input", "color1")
  label: string        // Display name for the port
  type: PortType       // Data type
  default?: unknown    // Default value when port is unconnected
  textureInput?: boolean  // When true + wired, triggers a pass boundary (multi-pass rendering)
}

/**
 * Parameters that can be tweaked in the node UI
 */
export interface NodeParameter {
  id: string                    // Unique identifier (e.g., "scale", "strength")
  label: string                 // Display name
  type: 'float' | 'vec2' | 'vec3' | 'color' | 'enum' | 'bool'
  // `color` params are RGBA (vec4-backed) — default may be a legacy 3-tuple
  // (padded to opaque a=1.0 at uniform-upload time, see padColorUniformValue)
  // or a full 4-tuple RGBA value.
  // `bool` params store a JS boolean, always `updateMode: 'recompile'` — read via
  // ctx.params.<id> in glsl()/ir() to branch codegen, like `enum`. Never a uniform.
  default: number | string | boolean | [number, number] | [number, number, number] | [number, number, number, number]
  min?: number                  // For numeric types
  max?: number                  // For numeric types
  step?: number                 // Step increment for sliders
  options?: Array<{ value: string; label: string }>  // For enum type
  /**
   * Alternate UI control for an enum param. 'anchor-grid' renders a 3×3
   * pin-position toggle grid instead of a dropdown — requires exactly 9
   * options in row-major order (tl..br).
   */
  control?: 'anchor-grid'
  showWhen?: Record<string, string | string[]>        // Only show when other params match (array = any of)
  connectable?: boolean                              // If true, renders as wirable handle + inline slider
  hidden?: boolean                                   // If true, param is not rendered in UI (internal state)
  warnAbove?: number                                  // Show performance hint when unwired value exceeds this
  /**
   * Controls how a parameter change is handled by the compiler and renderer.
   *
   * - 'recompile': value is baked into GLSL source at codegen time.
   *   Any change requires full shader recompilation.
   *   Use for: enum modes, structural counts, branch-shaping params.
   *
   * - 'uniform': value is emitted as a GLSL uniform and uploaded at runtime.
   *   Changes require only a uniform upload — no recompile.
   *   Use for: scale, strength, offset, frequency, amplitude, numeric multipliers.
   *
   * - 'renderer': value controls renderer settings (FPS, DPR) only.
   *   Changes require no recompile or uniform upload — just renderer state.
   *   Use for: quality tiers, render mode switches.
   */
  updateMode: 'recompile' | 'uniform' | 'renderer'
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
  functionRegistry: Map<string, string>    // Deduplicated shared functions (key -> GLSL code)
  textureSamplers?: Record<string, string> // portId → sampler2D uniform name (multi-pass)
  imageSamplers?: Set<string>              // Image node sampler2D uniform names
}

/**
 * Spatial transform configuration for framework-managed SRT
 */
export interface SpatialConfig {
  transforms: Array<'scale' | 'scaleXY' | 'rotate' | 'translate'>
  order?: 'SRT' | 'TRS' | 'RST'  // default: 'SRT'
}

/**
 * Generate framework SRT param definitions from a SpatialConfig.
 * Include these in the node's `params` array via spread: `...getSpatialParams(spatial)`.
 */
export function getSpatialParams(spatial: SpatialConfig): NodeParameter[] {
  const params: NodeParameter[] = []
  for (const transform of spatial.transforms) {
    switch (transform) {
      case 'scale':
        params.push({
          id: 'srt_scale', label: 'Scale', type: 'float', default: 1.0,
          min: 0, max: 10.0, step: 0.01,
          connectable: true, updateMode: 'uniform',
        })
        break
      case 'scaleXY':
        params.push(
          {
            id: 'srt_scaleX', label: 'Scale X', type: 'float', default: 1.0,
            min: 0, max: 10.0, step: 0.01,
            connectable: true, updateMode: 'uniform',
          },
          {
            id: 'srt_scaleY', label: 'Scale Y', type: 'float', default: 1.0,
            min: 0, max: 10.0, step: 0.01,
            connectable: true, updateMode: 'uniform',
          },
        )
        break
      case 'rotate':
        params.push({
          id: 'srt_rotate', label: 'Rotate', type: 'float', default: 0,
          min: -180, max: 180, step: 1,
          connectable: true, updateMode: 'uniform',
        })
        break
      case 'translate':
        params.push(
          {
            id: 'srt_translateX', label: 'Offset X', type: 'float', default: 0,
            min: -500, max: 500, step: 1,
            connectable: true, updateMode: 'uniform',
          },
          {
            id: 'srt_translateY', label: 'Offset Y', type: 'float', default: 0,
            min: -500, max: 500, step: 1,
            connectable: true, updateMode: 'uniform',
          },
        )
        break
    }
  }
  return params
}

/**
 * A single draggable control point exposed by a node's preview gizmo overlay.
 * `xParam`/`yParam` reference NodeParameter ids whose values (CSS px relative
 * to the gizmo's anchor) are read/written as the handle is dragged.
 */
export interface GizmoPoint {
  id: string                                   // Unique identifier within the gizmo
  xParam: string                                // NodeParameter id holding the point's x (px)
  yParam: string                                // NodeParameter id holding the point's y (px)
  role?: 'point' | 'center'                     // Visual/behavioral role of the handle
  shape?: 'circle' | 'diamond' | 'square'       // Marker shape (default: circle)
  showWhen?: Record<string, string | string[]>  // Only show when other params match (array = any of)
}

/**
 * A derived handle that lets the user drag a scalar aspect ratio param
 * perpendicular to the line from `centerPoint` to `endPoint`. Its screen
 * position is computed from the two referenced GizmoPoints, not from its own
 * x/y params — see PreviewGizmoOverlay for the derivation.
 */
export interface GizmoAspectHandle {
  id: string
  shape?: 'circle' | 'diamond' | 'square'
  aspectParam: string                           // NodeParameter id holding the scalar aspect value
  centerPoint: string                           // GizmoPoint id
  endPoint: string                              // GizmoPoint id
  showWhen?: Record<string, string | string[]>
}

/**
 * A non-interactive shape outline drawn from `centerPoint`/`endPoint` and a
 * perpendicular `aspectParam`, e.g. to preview an ellipse/diamond gradient's
 * footprint on the canvas.
 */
export interface GizmoOutline {
  shape: 'ellipse' | 'diamond'
  centerPoint: string                           // GizmoPoint id
  endPoint: string                               // GizmoPoint id
  aspectParam: string                            // NodeParameter id holding the scalar aspect value
  showWhen?: Record<string, string | string[]>
}

/**
 * Declares a node's preview gizmo: draggable overlay handles bound to its
 * point params. Rendered by the (future) gizmo overlay above the preview canvas.
 */
export interface GizmoConfig {
  points: GizmoPoint[]
  connectors?: Array<{ from: string; to: string }>  // Lines drawn between point ids, by GizmoPoint.id
  aspectHandles?: GizmoAspectHandle[]                 // Perpendicular aspect-ratio drag handles
  outline?: GizmoOutline[]                            // Drawn shape outline(s) (e.g. ellipse/diamond footprint)
  showWhen?: Record<string, string | string[]>       // Only show the whole gizmo when other params match
}

/**
 * Generic `showWhen` matcher shared by param visibility (ShaderNode.tsx's
 * `isParamVisible`) and gizmo/gizmo-point visibility (PreviewGizmoOverlay).
 * All key/value pairs must match `currentValues`, falling back to each
 * param's declared default (via `allParams`) when a key is unset. An array
 * value matches if the current value is any of its entries.
 */
export function matchesShowWhen(
  showWhen: Record<string, string | string[]> | undefined,
  currentValues: Record<string, unknown>,
  allParams: NodeParameter[],
): boolean {
  if (!showWhen) return true
  return Object.entries(showWhen).every(([key, val]) => {
    const current = currentValues[key] ?? allParams.find((p) => p.id === key)?.default
    return Array.isArray(val) ? val.includes(current as string) : current === val
  })
}

/**
 * Register a shared GLSL function. Skips if key already registered.
 * Use this instead of pushing to functions[] directly.
 */
export function addFunction(ctx: GLSLContext, key: string, code: string): void {
  if (!ctx.functionRegistry.has(key)) {
    ctx.functionRegistry.set(key, code)
  }
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
   * Optional function returning per-instance inputs based on current params.
   * Used by nodes with variable port count (e.g., Arithmetic with 2-8 inputs).
   * When present, compiler and UI use this instead of static `inputs`.
   */
  dynamicInputs?: (params: Record<string, unknown>) => PortDefinition[]

  /**
   * Generate GLSL code for this node
   * @param ctx Context with node ID, port mappings, parameter values
   * @returns GLSL code snippet (variable declarations + calculations)
   */
  glsl: (ctx: GLSLContext) => string

  /**
   * Generate IR (Intermediate Representation) for this node.
   * When present, the IR path can be used alongside glsl() for dual-target codegen.
   * The IR is lowered to GLSL or WGSL by the respective backends.
   * Added in Phase 1a of the WebGPU migration.
   */
  ir?: (ctx: import('../compiler/ir/types').IRContext) => import('../compiler/ir/types').IRNodeOutput

  /**
   * Optional custom React component for node body
   * If not provided, default UI with parameter controls is used
   */
  component?: React.ComponentType<{ nodeId: string; data: Record<string, unknown> }>

  /**
   * Framework-managed spatial transforms (SRT).
   * When present, the compiler auto-injects scale/rotate/translate uniforms and GLSL.
   */
  spatial?: SpatialConfig

  /**
   * Optional description for tooltips/help
   */
  description?: string

  /**
   * Hide the auto-generated mini-preview thumbnail on this node.
   * Use for nodes that have their own preview (e.g., Image) or where preview is meaningless (e.g., Time).
   */
  hidePreview?: boolean

  /**
   * Show preview only when at least one input is connected.
   * Use for scalar math nodes (Arithmetic, Trig, etc.) whose preview
   * is only meaningful when a visual pattern is wired in.
   */
  conditionalPreview?: boolean

  /**
   * Texture filtering for this node's FBO output in multi-pass chains.
   * 'nearest' preserves hard edges (e.g., pixel blocks from Pixelate).
   * Defaults to 'linear' if not set.
   */
  textureFilter?: 'linear' | 'nearest'

  /**
   * Declares draggable control points for this node, rendered by the preview
   * gizmo overlay (handles + inline sliders' on-canvas counterpart). Point
   * params are read/written in the same CSS-px-relative-to-anchor space as
   * the SRT translate params — see `src/utils/gizmo-coords.ts`.
   */
  gizmo?: GizmoConfig
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
 * Describes a user-defined GLSL uniform extracted during codegen.
 * One per unwired 'uniform'-mode param per active node.
 */
export interface UniformSpec {
  /** GLSL uniform name, e.g. "u_abc123_scale" */
  name: string
  /** GLSL type — determines which gl.uniform* call to use */
  glslType: 'float' | 'vec2' | 'vec3' | 'vec4'
  /** Current value at compile time — used for initial upload after updateShader() */
  value: number | number[]
  /** React Flow node ID (unsanitized) */
  nodeId: string
  /** NodeParameter.id */
  paramId: string
}

/**
 * Runtime node instance data (stored in React Flow)
 */
export interface NodeData extends Record<string, unknown> {
  type: string                      // References NodeDefinition.type
  params: Record<string, unknown>   // Current parameter values
  label?: string                    // Optional custom label
}

/**
 * Edge connection data
 */
export interface EdgeData extends Record<string, unknown> {
  sourcePort: string       // Source output port ID
  targetPort: string       // Target input port ID
  sourcePortType?: string  // Port type for edge coloring
}
