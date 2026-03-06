/**
 * drift-collect.ts — Fetches Figma component data via REST API
 * and writes tokens/figma-components.json for drift-check.ts to consume.
 *
 * Requires FIGMA_TOKEN in .env (personal access token with file_content:read scope).
 * Reads figmaFileKey from tokens/sombra.ds.json.
 *
 * Usage:
 *   npx tsx scripts/drift-collect.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'

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

if (!FIGMA_TOKEN) {
  console.error('Missing FIGMA_TOKEN. Set it in .env or export FIGMA_TOKEN=...')
  console.error('Get a personal access token at https://www.figma.com/developers/api#access-tokens')
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Figma component snapshot (REST API)')
  console.log('====================================\n')

  console.log('Fetching file tree from Figma...')

  const fileData = await figmaGet(`/files/${FILE_KEY}`) as { document: FigmaNode }

  const allComponents: SnapshotComponent[] = []
  collectComponents(fileData.document, null, allComponents)

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
