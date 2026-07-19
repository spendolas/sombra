import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { compileGraph } from '../compiler/glsl-generator'
import { compileGraphIR } from '../compiler/ir-compiler'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { buildManifest } from './manifest'
import { stripPlan, encodeArtifact, type SceneArtifact, type ImageAsset, type KnobDescriptor } from './artifact'
import { PLAYER_UMD_URL } from './version'

export interface PublishResult {
  sceneB64: string
  manifest: KnobDescriptor[]
  sizeBytes: number
  snippets: { copyPaste: string; developer: string; iframe: string }
}

function collectImages(nodes: Node<NodeData>[]): ImageAsset[] {
  const out: ImageAsset[] = []
  for (const n of nodes) {
    if (n.data.type !== 'image') continue
    const dataUrl = n.data.params?.imageData as string | undefined
    if (!dataUrl) continue
    out.push({ sampler: `u_${n.id.replace(/-/g, '_')}_image`, dataUrl })
  }
  return out
}

/** Compile + serialize the current graph into a frozen scene artifact. */
export function publishScene(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  viewerHash?: string,
): PublishResult {
  const plan = compileGraph(nodes, edges)
  if (!plan.success) throw new Error('Shader compilation failed: ' + plan.errors.map((e) => e.message).join('; '))
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    const wgsl = compileGraphIR(nodes, edges)
    if (wgsl) plan.wgsl = { passes: wgsl.passes }
  }

  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const timeNode = nodes.find((n) => n.data.type === 'time')
  const artifact: SceneArtifact = {
    v: 1,
    kind: 'frozen',
    plan: stripPlan(plan),
    manifest: buildManifest(plan.userUniforms, nodes),
    images: collectImages(nodes),
    meta: {
      anchor: anchorToVec2((outputNode?.data.params?.anchor as string) ?? 'center'),
      timeSpeed: (timeNode?.data.params?.speed as number) ?? 1,
    },
  }

  const sceneB64 = encodeArtifact(artifact)
  return {
    sceneB64,
    manifest: artifact.manifest,
    sizeBytes: sceneB64.length,
    snippets: buildSnippets(sceneB64, viewerHash),
  }
}

/** Build the three copy-paste snippet strings. */
export function buildSnippets(sceneB64: string, viewerHash?: string) {
  const copyPaste =
`<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");` +
`i.src="${PLAYER_UMD_URL}";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>\n` +
`<div data-sombra-scene="${sceneB64}" style="width:100%;aspect-ratio:16/9"></div>`

  // mount() is async; use onLoad to get the ready handle (Rive/Spline pattern).
  const developer =
`<script src="${PLAYER_UMD_URL}"></script>\n` +
`<div id="my-shader" style="width:100%;aspect-ratio:16/9"></div>\n` +
`<script>\n  Sombra.mount(document.getElementById('my-shader'), {\n    scene: "${sceneB64}",\n    onLoad: function (shader) {\n      // shader.set('intensity', 0.65);\n    }\n  });\n</script>`

  const iframe = viewerHash
    ? `<iframe src="https://spendolas.github.io/sombra/viewer.html#g=${viewerHash}" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>`
    : '<!-- iframe fallback unavailable: no viewer hash provided -->'

  return { copyPaste, developer, iframe }
}
