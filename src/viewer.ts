/**
 * Sombra Viewer — lightweight entry point for shared shader previews.
 * Decodes a compressed graph from the URL hash, compiles it, and renders
 * the resulting fragment shader on a fullscreen canvas. No React, no editor UI.
 */

import { initializeNodeLibrary } from './nodes'
import { compileGraph } from './compiler/glsl-generator'
import { compileGraphIR } from './compiler/ir-compiler'
import { decodeGraphFromHash, decodeCompactHash } from './utils/sombra-file'
import { createShaderRenderer } from './renderer/create-renderer'
import { anchorToVec2 } from './nodes/output/fragment-output'
import type { QualityTier } from './renderer/types'

function showError(message: string) {
  const el = document.getElementById('error')!
  el.style.display = 'block'
  el.textContent = message
  document.getElementById('viewer')!.style.display = 'none'
}

async function main() {
  // Parse hash — accept #g=<compact> or #graph=<full> (legacy)
  const hash = window.location.hash.slice(1) // remove leading #

  let encoded: string
  let useCompact: boolean
  if (hash.startsWith('g=')) {
    encoded = hash.slice(2)
    useCompact = true
  } else if (hash.startsWith('graph=')) {
    encoded = hash.slice(6)
    useCompact = false
  } else {
    showError('No graph data in URL.\n\nShare a shader from the Sombra editor to get a viewer link.')
    return
  }

  if (!encoded) {
    showError('Empty graph data in URL.')
    return
  }

  // Initialize the node registry (needed for decode validation + compileGraph)
  initializeNodeLibrary()

  // Decode and validate
  let nodes, edges
  try {
    const result = useCompact
      ? decodeCompactHash(encoded)
      : decodeGraphFromHash(encoded)
    nodes = result.nodes
    edges = result.edges
  } catch (err) {
    showError(`Failed to decode graph:\n\n${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Re-seed random nodes so each viewer load is unique
  for (const node of nodes) {
    if (node.data.type === 'random') {
      node.data.params = { ...node.data.params, seed: Math.random() }
    }
  }

  // Friendly message instead of a raw compile error when there is nothing
  // to render (no Fragment Output, or one with nothing wired into it)
  const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
  const outputWired = outputNode && edges.some((e) => e.target === outputNode.id)
  if (!outputWired) {
    showError(
      'Nothing to render: the shared graph has no connected Fragment Output.\n\n' +
      'Wire a node into Fragment Output in the editor and share again.'
    )
    return
  }

  // Compile to GLSL
  const result = compileGraph(nodes, edges)
  if (!result.success) {
    const errorMessages = result.errors.map(e => e.message).join('\n')
    showError(`Shader compilation failed:\n\n${errorMessages}`)
    return
  }

  // If WebGPU is available, also compile to WGSL via IR path
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    const wgslResult = compileGraphIR(nodes, edges)
    if (wgslResult) {
      result.wgsl = { passes: wgslResult.passes }
    }
  }

  // Render
  const canvas = document.getElementById('viewer') as HTMLCanvasElement
  try {
    const renderer = await createShaderRenderer(canvas, result)
    const shaderResult = renderer.updateRenderPlan(result)
    if (!shaderResult.success) {
      showError(`WebGL shader error:\n\n${shaderResult.error}`)
      return
    }

    // Upload user uniforms (slider values baked into the shared graph)
    if (result.userUniforms.length) {
      renderer.updateUniforms(
        result.userUniforms.map((u) => ({ name: u.name, value: u.value }))
      )
    }

    // Randomise Random-node seeds on load (parity with the embed player): the
    // editor keeps a stable baked value; a shared/embedded scene randomises per load.
    const randomIds = new Set(nodes.filter((n) => n.data.type === 'random').map((n) => n.id))
    const seedUniforms = result.userUniforms.filter(
      (u) => u.paramId === 'seed' && randomIds.has(u.nodeId)
    )
    if (seedUniforms.length) {
      renderer.updateUniforms(seedUniforms.map((u) => ({ name: u.name, value: Math.random() })))
    }

    // Anchor from the Fragment Output node (editor parity — applyCompileResult)
    const outputNode = nodes.find((n) => n.data.type === 'fragment_output')
    renderer.setAnchor(anchorToVec2((outputNode?.data.params?.anchor as string) ?? 'center'))

    const isAnimated = result.isTimeLiveAtOutput

    // Image-node textures decode async — re-render as each one lands
    for (const node of nodes) {
      if (node.data.type !== 'image') continue
      const imageData = node.data.params?.imageData as string | undefined
      if (!imageData) continue
      const samplerName = `u_${node.id.replace(/-/g, '_')}_image`
      const img = new Image()
      img.onload = () => {
        renderer.uploadImageTexture(samplerName, img)
        renderer.notifyChange()
        if (!isAnimated) renderer.requestRender()
      }
      img.src = imageData
    }

    // Render once immediately before animation starts
    renderer.render()

    // Apply quality tier and animation state
    renderer.setAnimated(isAnimated)
    renderer.setQualityTier((result.qualityTier ?? 'adaptive') as QualityTier)
    if (isAnimated) {
      // Time-node speed (editor parity)
      const timeNode = nodes.find((n) => n.data.type === 'time')
      renderer.setAnimationSpeed((timeNode?.data.params?.speed as number) ?? 1.0)
      renderer.startAnimation()
    } else {
      renderer.notifyChange()
    }
  } catch (err) {
    showError(`WebGL error:\n\n${err instanceof Error ? err.message : String(err)}`)
  }
}

main()

// Hash-only navigation (share link → share link) doesn't reload the page,
// so the previous shader stayed on screen. The viewer is stateless — a full
// reload is the simplest correct teardown of renderer/GPU state.
window.addEventListener('hashchange', () => {
  window.location.reload()
})
