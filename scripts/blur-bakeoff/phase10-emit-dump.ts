/**
 * Phase 10a — dump the ACTUAL emitted shaders for the Reeded Glass node.
 *
 * Nothing about derivative legality can be settled against a paraphrase of the
 * node; it has to be settled against the exact text the compiler hands the
 * driver. This builds the two graphs that matter —
 *
 *   A) Image -> Reeded Glass -> Fragment Output          (frost is a UNIFORM)
 *   B) Image -> Reeded Glass -> Fragment Output
 *      Noise -> Reeded Glass.frost                        (frost is NON-UNIFORM)
 *
 * — compiles both through the real GLSL and IR/WGSL paths, and writes every
 * pass verbatim to reports/blur-bakeoff/phase10/.
 *
 * Run: npx tsx scripts/blur-bakeoff/phase10-emit-dump.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase10')

function baseGraph(frostWired: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: unknown[] = [
    { id: 'img', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params: { imageData: '', fitMode: 'cover' } } },
    { id: 'rg', type: 'shaderNode', position: { x: 200, y: 0 }, data: { type: 'reeded_glass', params: {} } },
    { id: 'out', type: 'shaderNode', position: { x: 400, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ]
  const edges: unknown[] = [
    { id: 'e1', source: 'img', sourceHandle: 'color', target: 'rg', targetHandle: 'source' },
    { id: 'e2', source: 'rg', sourceHandle: 'color', target: 'out', targetHandle: 'color' },
  ]
  if (frostWired) {
    nodes.push({ id: 'nz', type: 'shaderNode', position: { x: 0, y: 200 }, data: { type: 'noise', params: {} } })
    edges.push({ id: 'e3', source: 'nz', sourceHandle: 'value', target: 'rg', targetHandle: 'frost' })
  }
  return { nodes: nodes as Node[], edges: edges as Edge[] }
}

function main(): void {
  initializeNodeLibrary()
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const [tag, wired] of [['uniform-frost', false], ['wired-frost', true]] as const) {
    const { nodes, edges } = baseGraph(wired)
    const glsl = compileGraph(nodes, edges)
    const ir = compileGraphIR(nodes, edges)

    console.log(`\n=== ${tag} ===`)
    console.log('GLSL passes:', glsl.passes.length, 'errors:', JSON.stringify(glsl.errors ?? []))
    console.log('WGSL passes:', ir.passes.length, 'errors:', JSON.stringify(ir.errors ?? []))

    glsl.passes.forEach((p, i) => {
      fs.writeFileSync(path.join(OUT_DIR, `${tag}.glsl.pass${i}.frag`), p.fragmentShader)
    })
    ir.passes.forEach((p, i) => {
      fs.writeFileSync(path.join(OUT_DIR, `${tag}.wgsl.pass${i}.wgsl`), p.shaderCode)
    })
    console.log('wrote', OUT_DIR)
  }
}

main()
