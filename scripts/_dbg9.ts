import { initializeNodeLibrary } from '../src/nodes'
import { compileGraph } from '../src/compiler/glsl-generator'
import type { Node, Edge } from '@xyflow/react'
initializeNodeLibrary()
const n = (id: string, type: string, params: Record<string, unknown> = {}) =>
  ({ id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } }) as unknown as Node
const e = (id: string, s: string, sh: string, t: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th }) as unknown as Edge
const nodes = [n('cb','checkerboard'), n('bl','blur',{radius:12}), n('out','fragment_output'), n('num','float_constant',{value:40})]
const edges = [e('e1','cb','color','bl','source'), e('e2','bl','color','out','color'), e('e3','num','value','bl','radius')]
const g = compileGraph(nodes as never, edges as never)
g.passes.forEach((p,i) => {
  const src = p.fragmentShader
  const declared = new Set([...src.matchAll(/\b(?:float|vec2|vec3|vec4|int)\s+(node_\w+)/g)].map(m=>m[1]))
  const used = new Set([...src.matchAll(/\b(node_\w+)\b/g)].map(m=>m[1]))
  const dangling = [...used].filter(u=>!declared.has(u))
  console.log('pass %d: dangling=%s uniforms=%s', i, dangling.join(',')||'none', (p.userUniforms||[]).map(u=>u.name).join(',')||'none')
})
