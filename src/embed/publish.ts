import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../nodes/types'
import { compileGraph } from '../compiler/glsl-generator'
import { compileGraphIR } from '../compiler/ir-compiler'
import { topologicalSort } from '../compiler/topological-sort'
import { anchorToVec2 } from '../nodes/output/fragment-output'
import { buildManifest } from './manifest'
import { stripPlan, encodeArtifact, encodeArtifactBytes, type SceneArtifact, type ImageAsset, type KnobDescriptor } from './artifact'
import { PLAYER_UMD_URL } from './version'

export interface PublishResult {
  sceneB64: string          // inline artifact (base64url) for data-sombra-scene
  sceneBytes: Uint8Array    // hosted .sombra file contents (deflated binary, no base64)
  manifest: KnobDescriptor[]
  sizeBytes: number         // inline base64 length (what a data-attribute costs)
  fileBytes: number         // hosted .sombra file size (~25-33% smaller — no base64)
  snippets: ReturnType<typeof buildSnippets>
}

/**
 * Bake image data URLs — but only for image nodes reachable from the output.
 * `reachable` is the same set the shader/manifest are built from, so we only ever
 * drop images no sampler references; a dead-ended/disconnected image node would
 * otherwise dump its (large) base64 blob into the artifact for nothing.
 */
function collectImages(nodes: Node<NodeData>[], reachable: Set<string>): ImageAsset[] {
  const out: ImageAsset[] = []
  for (const n of nodes) {
    if (n.data.type !== 'image') continue
    if (!reachable.has(n.id)) continue
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
  // NB: shader-source minification (strip comments/whitespace) was measured and
  // REJECTED here — it shrinks raw text ~6% but the artifact is deflated, and
  // stripping that highly-repetitive text removes redundancy deflate exploited,
  // making the final .sombra ~10% LARGER. Deflate already handles whitespace.

  // Same reachable set the shader + manifest use — prune baked images to it so
  // dead-ended / disconnected nodes leave no bytes in the artifact. Compilation
  // already succeeded above (which topo-sorts), so this won't throw.
  const reachable = new Set(topologicalSort(nodes, edges))

  // Random-node seed uniforms — re-seeded per load in the player/viewer so a
  // published Random node actually randomises (the baked value is editor-only).
  const randomIds = new Set(nodes.filter((n) => n.data.type === 'random').map((n) => n.id))
  const randomizeOnLoad = plan.userUniforms
    .filter((u) => u.paramId === 'seed' && randomIds.has(u.nodeId))
    .map((u) => u.name)

  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const timeNode = nodes.find((n) => n.data.type === 'time')
  const artifact: SceneArtifact = {
    v: 1,
    kind: 'frozen',
    plan: stripPlan(plan),
    manifest: buildManifest(plan.userUniforms, nodes),
    images: collectImages(nodes, reachable),
    meta: {
      anchor: anchorToVec2((outputNode?.data.params?.anchor as string) ?? 'center'),
      timeSpeed: (timeNode?.data.params?.speed as number) ?? 1,
    },
    ...(randomizeOnLoad.length ? { randomizeOnLoad } : {}),
  }

  const sceneB64 = encodeArtifact(artifact)
  const sceneBytes = encodeArtifactBytes(artifact)
  return {
    sceneB64,
    sceneBytes,
    manifest: artifact.manifest,
    sizeBytes: sceneB64.length,
    fileBytes: sceneBytes.length,
    snippets: buildSnippets(sceneB64, viewerHash),
  }
}

/** Build the snippet strings. One self-bootstrapping `embed` (auto-mounts AND is
 * controllable via the handle), an optional `control` add-on, and the isolated
 * `iframe` fallback. */
export const HOSTED_URL_PLACEHOLDER = 'REPLACE_WITH_YOUR_FILE_URL.sombra'

export function buildSnippets(sceneB64: string, viewerHash?: string) {
  // Player loader: loads the UMD once (cached across sites) then auto-mounts.
  const loader =
`<script>!function(){var s=window.Sombra;if(s&&s.init){s.init()}else{var i=document.createElement("script");` +
`i.src="${PLAYER_UMD_URL}";i.onload=function(){Sombra.init()};(document.head||document.body).appendChild(i)}}();</script>`

  // Hosted: reference a .sombra file you host anywhere; tiny snippet, and the
  // container is addressable (id) for optional live control. The primary path.
  const hosted =
`${loader}\n<div id="sombra-shader" data-sombra-src="${HOSTED_URL_PLACEHOLDER}" style="width:100%;aspect-ratio:16/9"></div>`

  // Inline: the whole (base64) scene lives in the attribute — self-contained, no
  // hosting, but a big string. Good for small scenes / paste-and-forget.
  const embed =
`${loader}\n<div id="sombra-shader" data-sombra-scene="${sceneB64}" style="width:100%;aspect-ratio:16/9"></div>`

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

  return { hosted, embed, control, iframe }
}
