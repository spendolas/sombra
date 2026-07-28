/**
 * Phase 14a — dump the ACTUAL emitted Reeded Glass fragment shaders at HEAD, so
 * the integration-point report is written against the exact text the driver sees
 * rather than against a reading of the emitter.
 *
 * Three configs:
 *   defaults       — ribWidth 80, ior 1.5, curvature 0.8, bow 1, frost 0, straight
 *   scene          — the user's `face dr.sombra` Reeded Glass settings (wave/sine,
 *                    curvature 2.15, bow 2.72 clamped by the slider to 1 at load,
 *                    so pass the raw value the file stores)
 *   wired-frost    — frost driven by a Noise node → non-uniform control flow
 *
 * Run: npx tsx scripts/blur-bakeoff/phase14-emit-inspect.ts
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Node, Edge } from '@xyflow/react'
import { initializeNodeLibrary } from '../../src/nodes'
import { compileGraph } from '../../src/compiler/glsl-generator'
import { compileGraphIR } from '../../src/compiler/ir-compiler'

const OUT_DIR = path.join('reports', 'blur-bakeoff', 'phase14')

type Cfg = { tag: string; params: Record<string, unknown>; frostWired: boolean }

const CONFIGS: Cfg[] = [
  { tag: 'defaults', params: {}, frostWired: false },
  {
    tag: 'scene',
    params: {
      ribWidth: 80, ior: 1.65, curvature: 2.15, bow: 2.72, frost: 0,
      direction: 'vertical', ribType: 'wave', waveShape: 'sine',
      amplitude: 20, wavelength: 577,
    },
    frostWired: false,
  },
  { tag: 'wired-frost', params: {}, frostWired: true },
]

function graph(c: Cfg): { nodes: Node[]; edges: Edge[] } {
  const nodes: unknown[] = [
    { id: 'img', type: 'shaderNode', position: { x: 0, y: 0 }, data: { type: 'image', params: { imageData: '', fitMode: 'cover' } } },
    { id: 'rg', type: 'shaderNode', position: { x: 200, y: 0 }, data: { type: 'reeded_glass', params: c.params } },
    { id: 'out', type: 'shaderNode', position: { x: 400, y: 0 }, data: { type: 'fragment_output', params: {} } },
  ]
  const edges: unknown[] = [
    { id: 'e1', source: 'img', sourceHandle: 'color', target: 'rg', targetHandle: 'source' },
    { id: 'e2', source: 'rg', sourceHandle: 'color', target: 'out', targetHandle: 'color' },
  ]
  if (c.frostWired) {
    nodes.push({ id: 'nz', type: 'shaderNode', position: { x: 0, y: 200 }, data: { type: 'noise', params: {} } })
    edges.push({ id: 'e3', source: 'nz', sourceHandle: 'value', target: 'rg', targetHandle: 'frost' })
  }
  return { nodes: nodes as Node[], edges: edges as Edge[] }
}

function rgRegion(src: string): string {
  const lines = src.split('\n')
  const out: string[] = []
  lines.forEach((l, i) => {
    if (/rg_/.test(l)) out.push(`${String(i + 1).padStart(4)}  ${l}`)
  })
  return out.join('\n')
}

function main(): void {
  initializeNodeLibrary()
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const c of CONFIGS) {
    const { nodes, edges } = graph(c)
    const glsl = compileGraph(nodes, edges)
    const ir = compileGraphIR(nodes, edges)
    console.log(`\n=== ${c.tag} === glsl passes ${glsl.passes.length} err ${JSON.stringify(glsl.errors ?? [])} | wgsl passes ${ir.passes.length} err ${JSON.stringify(ir.errors ?? [])}`)

    glsl.passes.forEach((p, i) => {
      const f = path.join(OUT_DIR, `${c.tag}.glsl.pass${i}.frag`)
      fs.writeFileSync(f, p.fragmentShader)
      const reg = rgRegion(p.fragmentShader)
      if (reg) fs.writeFileSync(path.join(OUT_DIR, `${c.tag}.glsl.pass${i}.rgonly.txt`), reg)
    })
    ir.passes.forEach((p, i) => {
      const code = (p as { shaderCode?: string }).shaderCode ?? ''
      const f = path.join(OUT_DIR, `${c.tag}.wgsl.pass${i}.wgsl`)
      fs.writeFileSync(f, code)
      const reg = rgRegion(code)
      if (reg) fs.writeFileSync(path.join(OUT_DIR, `${c.tag}.wgsl.pass${i}.rgonly.txt`), reg)
    })
  }
  console.log(`\nwrote ${OUT_DIR}`)
}

main()
