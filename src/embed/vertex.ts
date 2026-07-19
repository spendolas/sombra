/**
 * The fullscreen-quad vertex stage, owned by the player so the embed bundle
 * never pulls in the compiler. MUST stay byte-identical to VERTEX_SHADER in
 * src/compiler/glsl-generator.ts — asserted by scripts/verify-artifact-roundtrip.ts.
 */
export const GLSL_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`
