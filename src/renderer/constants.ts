/**
 * Shared renderer constants.
 *
 * REFERENCE_SIZE is the fixed pixel reference the shader coordinate system is
 * built on: built-in `u_ref_size` is always this value (NOT captured per-canvas).
 * Pinned px-space content is sized/positioned relative to it via `auto_uv`
 * (`(v_uv - 0.5) * u_resolution / (u_dpr * u_ref_size) + 0.5`), which is what
 * makes resizing reveal/hide edges instead of stretching. Both the WebGPU and
 * WebGL2 renderers upload this as `u_ref_size`, and the preview gizmo overlay
 * uses it to place px-space handles at the same origin the shader uses.
 */
export const REFERENCE_SIZE = 512
