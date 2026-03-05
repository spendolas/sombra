/**
 * Sombra Viewer — lightweight entry point for shared shader previews.
 * Decodes a compressed graph from the URL hash, compiles it, and renders
 * the resulting fragment shader on a fullscreen canvas. No React, no editor UI.
 */

import { initializeNodeLibrary } from './nodes'
import { compileGraph } from './compiler/glsl-generator'
import { decodeGraphFromHash } from './utils/sombra-file'
import { WebGLRenderer } from './webgl/renderer'

function showError(message: string) {
  const el = document.getElementById('error')!
  el.style.display = 'block'
  el.textContent = message
  document.getElementById('viewer')!.style.display = 'none'
}

function main() {
  // Parse hash — expect #graph=<compressed>
  const hash = window.location.hash.slice(1) // remove leading #
  const prefix = 'graph='
  if (!hash.startsWith(prefix)) {
    showError('No graph data in URL.\n\nShare a shader from the Sombra editor to get a viewer link.')
    return
  }

  const encoded = hash.slice(prefix.length)
  if (!encoded) {
    showError('Empty graph data in URL.')
    return
  }

  // Initialize the node registry (needed for importFromFile validation + compileGraph)
  initializeNodeLibrary()

  // Decode and validate
  let nodes, edges
  try {
    const result = decodeGraphFromHash(encoded)
    nodes = result.nodes
    edges = result.edges
  } catch (err) {
    showError(`Failed to decode graph:\n\n${err instanceof Error ? err.message : String(err)}`)
    return
  }

  // Compile to GLSL
  const result = compileGraph(nodes, edges)
  if (!result.success) {
    const errorMessages = result.errors.map(e => e.message).join('\n')
    showError(`Shader compilation failed:\n\n${errorMessages}`)
    return
  }

  // Render
  const canvas = document.getElementById('viewer') as HTMLCanvasElement
  try {
    const renderer = new WebGLRenderer(canvas)
    const shaderResult = renderer.updateShader(result.fragmentShader)
    if (!shaderResult.success) {
      showError(`WebGL shader error:\n\n${shaderResult.error}`)
      return
    }
    renderer.startAnimation()
  } catch (err) {
    showError(`WebGL error:\n\n${err instanceof Error ? err.message : String(err)}`)
  }
}

main()
