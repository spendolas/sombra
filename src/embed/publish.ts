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
  snippets: ReturnType<typeof buildSnippets>
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

/** Build the snippet strings. One self-bootstrapping `embed` (auto-mounts AND is
 * controllable via the handle), an optional `control` add-on, and the isolated
 * `iframe` fallback. */
export function buildSnippets(sceneB64: string, viewerHash?: string) {
  // The one snippet: loads the player once (cached across sites), auto-mounts,
  // and — because it carries an id — is addressable for optional live control.
  const embed =
`<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");` +
`i.src="${PLAYER_UMD_URL}";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>\n` +
`<div id="sombra-shader" data-sombra-scene="${sceneB64}" style="width:100%;aspect-ratio:16/9"></div>`

  // Optional: grab the handle to drive the shader. Works with the same embed —
  // no second mount. Fires once the scene is live.
  const control =
`<script>\n` +
`  document.getElementById('sombra-shader').addEventListener('sombra:load', function (e) {\n` +
`    var shader = e.detail.handle;              // or: Sombra.get('sombra-shader')\n` +
`    // shader.set('noise-scale', 3);           // flat key\n` +
`    // shader.set(shader.nodes()[0].id, 'scale', 3);  // stable, node-directed\n` +
`  });\n` +
`</script>`

  const iframe = viewerHash
    ? `<iframe src="https://spendolas.github.io/sombra/viewer.html#g=${viewerHash}" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>`
    : '<!-- iframe fallback unavailable: no viewer hash provided -->'

  return { embed, control, iframe }
}
