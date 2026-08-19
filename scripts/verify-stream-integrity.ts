/**
 * Stream-integrity checker — does a graph's compiled math follow its DAG?
 *
 * Motivated by the "node math doesn't follow the stream" audit
 * (docs/research/2026-08-19-entanglement-audit.md). Compiles a graph and
 * asserts influence only flows along DAG edges, catching the shared-state
 * channels that let a node be driven from outside its inputs.
 *
 * Checks (per graph):
 *   C1 compile      — both codegen paths (GLSL here) produce a plan, no errors.
 *   C2 off-stream   — every `node_<X>_*` referenced in a pass is either DEFINED
 *                     in that pass (authored or re-emitted) or supplied via a
 *                     texture input. A reference to a node that is neither is an
 *                     off-stream read (entanglement).
 *   C3 uniform-back — every user-uniform spec is resolvable by the live-drag
 *                     fast path: its nodeId is an authored node, or baseNodeId()
 *                     maps it to one. A spec that only resolves via baseNodeId is
 *                     the F1 "sub-pass uniform freezes on drag" bug — flagged
 *                     until use-live-compiler resolves through baseNodeId.
 *   C4 pass-res     — no pass carries resolution != 1 while containing a node
 *                     whose def declares no multiPass.resolution (F2: a
 *                     downscaling sibling drags edge-unrelated pass-mates).
 *   C5 wired-range  — a wired connectable param with declared min/max has its
 *                     clamp bypassed; report so an out-of-design-range driver
 *                     (e.g. frost driven to 2.81 vs max 1) is visible.
 *
 * Run:  npx tsx scripts/verify-stream-integrity.ts [path/to/graph.sombra ...]
 *       (no args → runs the built-in graphs, incl. one that trips C3)
 */
import * as fs from 'fs'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../src/nodes/types'
import { initializeNodeLibrary } from '../src/nodes/index'
import { nodeRegistry } from '../src/nodes/registry'
import { compileGraph } from '../src/compiler/glsl-generator'
import { baseNodeId, expandMultiPassNodes } from '../src/compiler/expand-passes'
import { importFromFile } from '../src/utils/sombra-file'

initializeNodeLibrary()

type Finding = { check: string; severity: 'BUG' | 'WARN' | 'INFO'; detail: string }
const san = (id: string) => id.replace(/-/g, '_')

/** transitive DAG ancestors of every node (by edges) */
function ancestry(nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): Map<string, Set<string>> {
  const preds = new Map<string, string[]>()
  for (const n of nodes) preds.set(n.id, [])
  for (const e of edges) preds.get(e.target)?.push(e.source)
  const memo = new Map<string, Set<string>>()
  const walk = (id: string, seen = new Set<string>()): Set<string> => {
    if (memo.has(id)) return memo.get(id)!
    const out = new Set<string>()
    for (const p of preds.get(id) ?? []) {
      if (seen.has(p)) continue
      out.add(p)
      seen.add(p)
      for (const a of walk(p, seen)) out.add(a)
    }
    memo.set(id, out)
    return out
  }
  for (const n of nodes) walk(n.id)
  return memo
}

function checkGraph(name: string, nodes: Node<NodeData>[], edges: Edge<EdgeData>[]): Finding[] {
  const findings: Finding[] = []
  const authored = new Set(nodes.map((n) => n.id))

  // C1 — compile
  const plan = compileGraph(nodes, edges)
  if (!plan.success || plan.errors.length) {
    findings.push({ check: 'C1', severity: 'BUG', detail: `compile failed: ${plan.errors.map((e) => e.message).join('; ') || 'success=false'}` })
    return findings
  }

  // Expanded graph (sub-passes) for ancestry + membership reasoning
  const { nodes: exNodes, edges: exEdges } = expandMultiPassNodes(nodes, edges)
  const anc = ancestry(exNodes, exEdges)

  for (const pass of plan.passes) {
    const src = pass.fragmentShader
    // `node_<sanId>_<port>` — sanId itself contains underscores (type_timestamp),
    // so don't parse the token; test each KNOWN sanitized id against the shader.
    const defined = new Set<string>()
    const referenced = new Set<string>()
    for (const n of exNodes) {
      const s = san(n.id)
      if (new RegExp(`\\bnode_${s}_[a-z0-9]+`).test(src)) referenced.add(n.id)
      if (new RegExp(`\\bnode_${s}_[a-z0-9]+\\s*=(?!=)`).test(src)) defined.add(n.id)
    }
    const hasTex = Object.keys(pass.inputTextures ?? {}).length > 0

    // C2 — off-stream references
    for (const ref of referenced) {
      if (defined.has(ref)) continue
      // allowed if some defined node in this pass has ref as an ancestor (edge-legit)
      const legit = [...defined].some((d) => anc.get(d)?.has(ref))
      if (legit) continue
      if (hasTex) continue // conservatively allow when a texture boundary feeds the pass
      findings.push({ check: 'C2', severity: 'WARN', detail: `pass ${pass.index}: references node "${ref}" that is neither defined here nor an ancestor of any defined node (possible off-stream read)` })
    }

    // C3 — uniform backing (F1)
    for (const spec of pass.userUniforms) {
      const nid = spec.nodeId
      if (!nid) continue
      if (authored.has(nid)) continue
      const base = baseNodeId(nid)
      if (authored.has(base)) {
        findings.push({ check: 'C3', severity: 'BUG', detail: `pass ${pass.index}: uniform "${spec.name}" is keyed on sub-pass id "${nid}" (authored base "${base}"). The live-drag fast path (collectCurrentUniformValues) looks up spec.nodeId in the authored store and skips it → this sub-pass FREEZES on drag (F1).` })
      } else {
        findings.push({ check: 'C3', severity: 'BUG', detail: `pass ${pass.index}: uniform "${spec.name}" nodeId "${nid}" resolves to no authored node — value can never update.` })
      }
    }

    // C4 — pass resolution pin (F2)
    if (pass.resolution !== undefined && pass.resolution !== 1) {
      for (const d of defined) {
        const def = nodeRegistry.get(exNodes.find((n) => n.id === d)?.data.type ?? '')
        if (def && !def.multiPass?.resolution) {
          findings.push({ check: 'C4', severity: 'BUG', detail: `pass ${pass.index}: resolution=${pass.resolution} but contains node "${d}" (${def.label}) which declares no multiPass.resolution — it is dragged to a scale it never asked for (F2).` })
        }
      }
    }
  }

  // C5 — wired connectable param with a clamp that the wire bypasses
  const wired = new Set(edges.map((e) => `${e.target}:${e.targetHandle}`))
  for (const n of nodes) {
    const def = nodeRegistry.get(n.data.type)
    for (const p of def?.params ?? []) {
      if (!p.connectable) continue
      if (!wired.has(`${n.id}:${p.id}`)) continue
      if (p.min === undefined && p.max === undefined) continue
      findings.push({ check: 'C5', severity: 'INFO', detail: `${def!.label}.${p.id} on "${n.id}" is wired → its declared range [${p.min}, ${p.max}] is NOT enforced; a driver can push it out of design range.` })
    }
  }

  return findings
}

// --- built-in graphs -------------------------------------------------------
function node(id: string, type: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, type: 'shaderNode', position: { x: 0, y: 0 }, data: { type, params } } as Node<NodeData>
}
function edge(s: string, sh: string, t: string, th: string): Edge<EdgeData> {
  return { id: `${s}:${sh}->${t}:${th}`, source: s, sourceHandle: sh, target: t, targetHandle: th } as Edge<EdgeData>
}

const builtins: Array<{ name: string; nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }> = [
  {
    // multi-pass blur with an UNWIRED radius → sub-pass radius uniform (F1 trip for C3)
    name: 'multipass-blur-unwired-radius',
    nodes: [node('g-1', 'gradient'), node('b-1', 'blur'), node('o-1', 'fragment_output')],
    edges: [edge('g-1', 'color', 'b-1', 'source'), edge('b-1', 'color', 'o-1', 'color')],
  },
  {
    // simple graph — should be clean
    name: 'clean-gradient',
    nodes: [node('g-2', 'gradient'), node('o-2', 'fragment_output')],
    edges: [edge('g-2', 'color', 'o-2', 'color')],
  },
]

// --- run --------------------------------------------------------------------
const paths = process.argv.slice(2)
const graphs: Array<{ name: string; nodes: Node<NodeData>[]; edges: Edge<EdgeData>[] }> = []
if (paths.length) {
  for (const p of paths) {
    const g = importFromFile(JSON.parse(fs.readFileSync(p, 'utf8')))
    graphs.push({ name: p.split('/').pop() ?? p, nodes: g.nodes, edges: g.edges })
  }
} else {
  graphs.push(...builtins)
}

let bugs = 0
for (const g of graphs) {
  console.log(`\n=== ${g.name} (${g.nodes.length} nodes, ${g.edges.length} edges) ===`)
  const findings = checkGraph(g.name, g.nodes, g.edges)
  if (!findings.length) { console.log('  ✓ clean'); continue }
  for (const f of findings) {
    if (f.severity === 'BUG') bugs++
    console.log(`  [${f.severity}] ${f.check}: ${f.detail}`)
  }
}

console.log('\n' + '='.repeat(60))
console.log(bugs === 0 ? '  no BUG-severity stream violations' : `  ${bugs} BUG-severity stream violation(s)`)
console.log('='.repeat(60))
// Exit 0 by default (audit tool). Pass --strict to fail CI on any BUG.
process.exit(process.argv.includes('--strict') && bugs > 0 ? 1 : 0)
