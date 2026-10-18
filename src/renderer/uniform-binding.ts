/**
 * Does this WGSL module declare the group-0 uniform buffer?
 *
 * The WGSL assembler declares `uniforms` only when the module reads it
 * (wgsl-assembler.ts, step 8). Pipelines use `layout: 'auto'`, which keeps a
 * binding only if the entry point statically uses it — so for a module that
 * reads no uniform at all (an empty Stack's pass is `return vec4f(0.0)`),
 * group 0 has NO binding, a group-0 bind group with one entry fails
 * validation, and the draw invalidates the whole command buffer while the
 * plan reports success. Renderers create and bind group 0 only when this
 * says the module declares it: the declaration itself is the signal, so it
 * survives every path a shader takes (plans, previews, embed artifacts).
 *
 * Lives in src/renderer/ so the embed player may import it.
 */
export function declaresUniformBinding(shaderCode: string): boolean {
  return /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s+uniforms\b/.test(shaderCode)
}
