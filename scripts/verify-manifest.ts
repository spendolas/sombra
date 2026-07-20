/**
 * verify-manifest — buildManifest joins compiler uniforms with NodeDefinition
 * metadata, one knob per uniform, deduped keys. Run: npx tsx scripts/verify-manifest.ts
 */
import type { Node } from '@xyflow/react'
import { initializeNodeLibrary } from '../src/nodes'
import { nodeRegistry } from '../src/nodes/registry'
import type { NodeData, UniformSpec } from '../src/nodes/types'
import { buildManifest } from '../src/embed/manifest'

initializeNodeLibrary()

let passed = 0, failed = 0
function check(name: string, cond: boolean) {
  if (cond) passed++; else { failed++; console.error(`  [FAIL] ${name}`) }
}

// Find any registered node with a uniform-mode, non-hidden param to test against.
let testType = '', testParamId = '', testLabel = ''
for (const def of nodeRegistry.getAll()) {
  const p = def.params?.find((p) => p.updateMode === 'uniform' && !p.hidden)
  if (p) { testType = def.type; testParamId = p.id; testLabel = p.label; break }
}
check('found a uniform-mode param to test', testType !== '')

const nodes = [
  { id: 'n1', data: { type: testType, params: {} } },
  { id: 'n2', data: { type: testType, params: {} } },
] as Node<NodeData>[]

const uniforms: UniformSpec[] = [
  { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
  { name: `u_n2_${testParamId}`, glslType: 'float', value: 2, nodeId: 'n2', paramId: testParamId },
]

const manifest = buildManifest(uniforms, nodes)
check('one descriptor per uniform', manifest.length === 2)
check('first key is slugified label', manifest[0].key.length > 0 && manifest[0].key === manifest[0].key.toLowerCase())
check('duplicate label is deduped', manifest[0].key !== manifest[1].key)
check('descriptor carries label + uniform wire name', manifest[0].label === testLabel && manifest[0].uniform === `u_n1_${testParamId}`)
check('descriptor carries owning node display name', manifest[0].node.length > 0)
check('duplicate nodes get distinct display names', manifest[0].node !== manifest[1].node)
check('key is node-scoped (node prefix + param)', manifest[0].key.includes('-') && manifest[0].key.length > testLabel.length)
check('descriptor carries stable nodeId + type', manifest[0].nodeId === 'n1' && manifest[0].nodeType === testType)
check('param is the friendly slug matching the key suffix', manifest[0].param.length > 0 && manifest[0].key.endsWith(manifest[0].param))
check('nodeId addresses distinct instances', manifest[0].nodeId !== manifest[1].nodeId && manifest[1].nodeId === 'n2')
check('unknown node is skipped', buildManifest(
  [{ name: 'u_x_y', glslType: 'float', value: 0, nodeId: 'ghost', paramId: 'y' }],
  nodes,
).length === 0)
// Multi-pass graphs repeat a node's uniform once per pass — must collapse to one knob.
check('repeated uniform name is deduped to one knob', buildManifest(
  [
    { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
    { name: `u_n1_${testParamId}`, glslType: 'float', value: 1, nodeId: 'n1', paramId: testParamId },
  ],
  nodes,
).length === 1)

// Intra-node param-slug collision: two uniform params on ONE node whose labels
// slugify identically must still get distinct node-directed addresses.
const localSlug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
let collideType = '', cp1 = '', cp2 = ''
for (const def of nodeRegistry.getAll()) {
  const ups = (def.params ?? []).filter((p) => p.updateMode === 'uniform' && !p.hidden)
  const bySlug = new Map<string, string>()
  for (const p of ups) {
    const s = localSlug(p.label)
    if (bySlug.has(s)) { collideType = def.type; cp1 = bySlug.get(s)!; cp2 = p.id; break }
    bySlug.set(s, p.id)
  }
  if (collideType) break
}
if (collideType) {
  const cn = [{ id: 'c1', data: { type: collideType, params: {} } }] as Node<NodeData>[]
  const cu: UniformSpec[] = [
    { name: `u_c1_${cp1}`, glslType: 'float', value: 1, nodeId: 'c1', paramId: cp1 },
    { name: `u_c1_${cp2}`, glslType: 'float', value: 2, nodeId: 'c1', paramId: cp2 },
  ]
  const cm = buildManifest(cu, cn)
  check('same-label params on one node get distinct node-directed addresses',
    cm.length === 2 && cm[0].param !== cm[1].param && new Set(cm.map((k) => `${k.nodeId}|${k.param}`)).size === 2)
} else {
  console.log(`  (no intra-node label collision in registry to test — skipped)`)
}

console.log('='.repeat(60))
console.log(`  SUMMARY: ${passed} passed, ${failed} failed`)
console.log('='.repeat(60))
if (failed > 0) process.exit(1)
