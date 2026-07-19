import { initializeNodeLibrary } from './nodes'
import { compileGraph } from './compiler/glsl-generator'
import { compileGraphIR } from './compiler/ir-compiler'
import { buildManifest } from './embed/manifest'
import { stripPlan, encodeArtifact, type SceneArtifact } from './embed/artifact'
import { mount } from './embed/player'
import { createDefaultGraph } from './utils/test-graph'

initializeNodeLibrary()
const { nodes, edges } = createDefaultGraph()
const plan = compileGraph(nodes, edges)
if (typeof navigator !== 'undefined' && navigator.gpu) {
  const wgsl = compileGraphIR(nodes, edges)
  if (wgsl) plan.wgsl = { passes: wgsl.passes }
}
const artifact: SceneArtifact = {
  v: 1, kind: 'frozen', plan: stripPlan(plan),
  manifest: buildManifest(plan.userUniforms, nodes),
  images: [], meta: { anchor: [0.5, 0.5], timeSpeed: 1 },
}
const scene = encodeArtifact(artifact)
;(window as unknown as { __embedScene: string }).__embedScene = scene
mount(document.getElementById('box')!, { scene }).then((h) => {
  ;(window as unknown as { __embedHandle: unknown }).__embedHandle = h
  console.log('[embed-dev] mounted; knobs:', h.variables().map((k) => k.key))
})
