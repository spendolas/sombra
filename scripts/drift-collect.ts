/**
 * drift-collect.ts — Snapshots Figma component data into
 * tokens/figma-components.json for drift-check.ts to consume.
 *
 * Sources (tried in order):
 *   1. Grip bridge (local Figma plugin — no token; needs the Grip plugin
 *      open in the Sombra file in the Figma desktop app)
 *   2. REST API (FIGMA_TOKEN in .env, file_content:read scope)
 *
 * Reads figmaFileKey from tokens/sombra.ds.json.
 *
 * Usage:
 *   npx tsx scripts/drift-collect.ts          # Grip if available, else REST
 *   npx tsx scripts/drift-collect.ts --rest   # force REST path
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { GripClient, withGrip } from './lib/grip-client'

// ─── Load .env if present ────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const ENV_PATH = resolve(ROOT, '.env')

if (existsSync(ENV_PATH)) {
  const envContent = readFileSync(ENV_PATH, 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')
const OUTPUT_PATH = resolve(ROOT, 'tokens/figma-components.json')

const FIGMA_TOKEN = process.env.FIGMA_TOKEN
const FORCE_REST = process.argv.includes('--rest')

const useGrip = !FORCE_REST && GripClient.available()

if (!useGrip && !FIGMA_TOKEN) {
  console.error('No data source: Grip bridge socket not found AND FIGMA_TOKEN missing.')
  console.error('Either open the Grip plugin in the Sombra Figma file (desktop app),')
  console.error('or set FIGMA_TOKEN in .env (personal access token from figma.com/developers).')
  process.exit(1)
}

const db = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
const FILE_KEY: string = db.figmaFileKey

if (!FILE_KEY) {
  console.error('Missing figmaFileKey in tokens/sombra.ds.json')
  process.exit(1)
}

// ─── Figma API ───────────────────────────────────────────────────────────────

async function figmaGet(path: string): Promise<unknown> {
  const url = `https://api.figma.com/v1${path}`
  const res = await fetch(url, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN! },
  })
  if (!res.ok) {
    throw new Error(`Figma API ${res.status}: ${res.statusText} — ${url}`)
  }
  return res.json()
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
  componentPropertyDefinitions?: Record<string, {
    type: string
    defaultValue: string | boolean
    variantOptions?: string[]
  }>
}

interface SnapshotComponent {
  id: string
  name: string
  type: 'COMPONENT' | 'COMPONENT_SET'
  parentId: string | null
  parentName: string | null
  isVariantChild: boolean
  properties: Record<string, {
    type: string
    defaultValue: string | boolean
    options: string[] | null
  }>
  variants?: Array<{ id: string; name: string }>
}

// ─── Tree walk ───────────────────────────────────────────────────────────────

function collectComponents(node: FigmaNode, parent: FigmaNode | null, results: SnapshotComponent[]): void {
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    const isVariantChild = node.type === 'COMPONENT' && parent?.type === 'COMPONENT_SET'

    const entry: SnapshotComponent = {
      id: node.id,
      name: node.name,
      type: node.type as 'COMPONENT' | 'COMPONENT_SET',
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      isVariantChild,
      properties: {},
    }

    // Only read property definitions from non-variant-child nodes
    if (!isVariantChild && node.componentPropertyDefinitions) {
      for (const [key, def] of Object.entries(node.componentPropertyDefinitions)) {
        entry.properties[key] = {
          type: def.type,
          defaultValue: def.defaultValue,
          options: def.variantOptions ?? null,
        }
      }
    }

    // For COMPONENT_SETs, collect variant children
    if (node.type === 'COMPONENT_SET' && node.children) {
      entry.variants = node.children
        .filter(c => c.type === 'COMPONENT')
        .map(c => ({ id: c.id, name: c.name }))
    }

    results.push(entry)
  }

  if (node.children) {
    for (const child of node.children) {
      collectComponents(child, node, results)
    }
  }
}

// ─── Grip collection (Plugin API via local bridge — no token) ────────────────

async function collectViaGrip(): Promise<SnapshotComponent[]> {
  return withGrip(FILE_KEY, async (grip) => {
    // One plugin-side script builds the exact snapshot shape — same fields
    // the REST tree-walk produces.
    const result = await grip.callTool('run_script', {
      code: `
const nodes = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] })
const out = []
for (const node of nodes) {
  const parent = node.parent
  const isVariantChild = node.type === 'COMPONENT' && parent && parent.type === 'COMPONENT_SET'
  const entry = {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: parent ? parent.id : null,
    parentName: parent ? parent.name : null,
    isVariantChild: !!isVariantChild,
    properties: {},
  }
  if (!isVariantChild) {
    let defs = null
    try { defs = node.componentPropertyDefinitions } catch (e) { defs = null }
    if (defs) {
      for (const key of Object.keys(defs)) {
        const def = defs[key]
        entry.properties[key] = {
          type: def.type,
          defaultValue: def.defaultValue,
          options: def.variantOptions ?? null,
        }
      }
    }
  }
  if (node.type === 'COMPONENT_SET') {
    entry.variants = node.children
      .filter((c) => c.type === 'COMPONENT')
      .map((c) => ({ id: c.id, name: c.name }))
  }
  out.push(entry)
}
return out
`,
    }) as { result?: SnapshotComponent[] } | SnapshotComponent[]
    return Array.isArray(result) ? result : (result.result ?? [])
  })
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Figma component snapshot (${useGrip ? 'Grip bridge / Plugin API' : 'REST API'})`)
  console.log('====================================\n')

  let allComponents: SnapshotComponent[]
  if (useGrip) {
    console.log('Collecting components via Grip...')
    allComponents = await collectViaGrip()
  } else {
    console.log('Fetching file tree from Figma...')
    const fileData = await figmaGet(`/files/${FILE_KEY}`) as { document: FigmaNode }
    allComponents = []
    collectComponents(fileData.document, null, allComponents)
  }

  // Exclude variant children from top-level list — they're already referenced
  // inside their parent COMPONENT_SET's `variants` array
  const components = allComponents.filter(c => !c.isVariantChild)

  const snapshot = {
    generatedAt: new Date().toISOString(),
    fileKey: FILE_KEY,
    components,
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2), 'utf-8')
  console.log(`\nSnapshot written to tokens/figma-components.json — ${components.length} components`)
}

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
