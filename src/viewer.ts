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
    const renderer = await createShaderRenderer(canvas)
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

    // Render once immediately before animation starts
    renderer.render()

    // Apply quality tier and animation state
    const isAnimated = result.isTimeLiveAtOutput
    renderer.setAnimated(isAnimated)
    renderer.setQualityTier((result.qualityTier ?? 'adaptive') as QualityTier)
    if (isAnimated) {
      renderer.startAnimation()
    } else {
      renderer.notifyChange()
    }
  } catch (err) {
    showError(`WebGL error:\n\n${err instanceof Error ? err.message : String(err)}`)
  }
}

main()
