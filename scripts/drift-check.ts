/**
 * drift-check.ts — Detects token usage drift, component drift, and variant drift
 * between Figma, the DB (sombra.ds.json), and code.
 *
 * 1. Token drift (local only): stale var() refs, unused defined tokens
 * 2. Component drift (requires FIGMA_TOKEN): Figma vs DB component tracking
 * 3. Variant drift (requires FIGMA_TOKEN): Figma variant properties vs DB parts
 *
 * Usage:
 *   npx tsx scripts/drift-check.ts
 *
 * Exit code 0 if no drift, 1 if any drift found.
 * Writes drift-report.md to project root.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { resolve, extname } from 'path'

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
const INDEX_CSS_PATH = resolve(ROOT, 'src/index.css')
const SRC_DIR = resolve(ROOT, 'src')
const REPORT_PATH = resolve(ROOT, 'drift-report.md')
const FIGMA_TOKEN = process.env.FIGMA_TOKEN

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

// ─── Types ───────────────────────────────────────────────────────────────────

interface ComponentEntry {
  name: string
  type: string
  dsKey: string
  codeFile: string | null
  parts: Record<string, { figmaNodeId: string | null; [key: string]: unknown }>
}

interface DB {
  version: number
  figmaFileKey: string
  colors: Record<string, { figmaName: string; cssVar: string; value: string; tailwind: { namespace: string; key: string } }>
  spacing: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  radius: Record<string, { figmaName: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  sizes: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: Array<{ namespace: string; key: string }> }>
  components: Record<string, ComponentEntry>
  [key: string]: unknown
}

interface FigmaComponentMeta {
  key: string
  name: string
  description: string
  node_id: string
  containing_frame: { name: string; nodeId: string; pageId: string; pageName: string }
}

interface StaleRef {
  variable: string
  file: string
  line: number
}

interface UnusedToken {
  variable: string
}

interface ComponentDriftItem {
  name: string
  nodeId: string
  direction: 'figma-only' | 'db-only'
  dsKey?: string
}

interface VariantDriftItem {
  component: string
  dsKey: string
  figmaNodeId: string
  figmaVariants: string[]
  dbParts: string[]
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

// ─── File scanning ───────────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (!SCAN_EXTENSIONS.has(ext)) continue
    // entry.parentPath is the directory containing the entry (Node 20+)
    const fullPath = resolve(entry.parentPath ?? entry.path, entry.name)
    // Skip generated marker regions (handled separately), node_modules, dist
    if (fullPath.includes('node_modules') || fullPath.includes('/dist/')) continue
    files.push(fullPath)
  }
  return files
}

// ─── 1. Token Drift Detection ────────────────────────────────────────────────

function detectTokenDrift(): { staleRefs: StaleRef[]; unusedTokens: UnusedToken[] } {
  const css = readFileSync(INDEX_CSS_PATH, 'utf-8')

  // Extract CSS custom property definitions from ALL GENERATED marker regions
  const definedVars = new Set<string>()
  const markerRegex = /\/\* === GENERATED:START [\w-]+ === \*\/([\s\S]*?)\/\* === GENERATED:END [\w-]+ === \*\//g
  let markerMatch: RegExpExecArray | null
  while ((markerMatch = markerRegex.exec(css)) !== null) {
    const block = markerMatch[1]
    // Match CSS custom property definitions: --foo-bar: ...;
    const propRegex = /(--[\w-]+)\s*:/g
    let propMatch: RegExpExecArray | null
    while ((propMatch = propRegex.exec(block)) !== null) {
      definedVars.add(propMatch[1])
    }
  }

  // Also extract Tailwind token keys that map to CSS vars.
  // The @theme inline block defines --color-*, --spacing-*, --radius-* etc.
  // We need the base CSS var names for matching, already captured above.

  // Build a map from Tailwind utility token to CSS var for cross-referencing.
  // e.g., bg-surface uses --color-surface which references var(--surface).
  // For token drift, we track the raw CSS vars (--surface, --sp-md, etc.)

  // Scan source files for var(--*) references
  const sourceFiles = collectSourceFiles(SRC_DIR)
  const referencedVars = new Map<string, Array<{ file: string; line: number }>>()

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Skip comment-only lines
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

      // Find var(--*) references
      const varRefRegex = /var\((--[\w-]+)\)/g
      let refMatch: RegExpExecArray | null
      while ((refMatch = varRefRegex.exec(line)) !== null) {
        const varName = refMatch[1]
        if (!referencedVars.has(varName)) {
          referencedVars.set(varName, [])
        }
        referencedVars.get(varName)!.push({
          file: filePath.replace(ROOT + '/', ''),
          line: i + 1,
        })
      }
    }
  }

  // Stale refs: referenced but not defined in generated regions
  const staleRefs: StaleRef[] = []
  for (const [varName, locations] of referencedVars) {
    if (!definedVars.has(varName)) {
      // Only flag if not a standard CSS property or Tailwind internal
      // Skip Tailwind v4 internals (--tw-*), standard browser vars, and
      // vars defined in non-generated parts of index.css
      if (varName.startsWith('--tw-')) continue
      // Check if it's defined anywhere in the full CSS (non-generated regions too)
      const definedAnywhere = new RegExp(`${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(css)
      if (definedAnywhere) continue
      for (const loc of locations) {
        staleRefs.push({ variable: varName, file: loc.file, line: loc.line })
      }
    }
  }

  // Unused tokens: defined in generated regions but never referenced anywhere in src
  // A token is "used" if either:
  //   a) var(--token) appears in source, OR
  //   b) A Tailwind utility references it (e.g., bg-surface → --color-surface → var(--surface))
  // For (b), the Tailwind @theme inline block creates --color-surface: var(--surface),
  // which counts as a reference within index.css itself. So we check if the var
  // appears anywhere in the full CSS or source files.
  //
  // Tailwind @theme inline variables (--color-*, --radius-*, --spacing-*, --size-*,
  // --min-width-*) are consumed by Tailwind's class generation engine, not via
  // explicit var() calls. Exclude them from unused detection.
  const TAILWIND_THEME_PREFIXES = ['--color-', '--radius-', '--spacing-', '--size-', '--min-width-']

  const unusedTokens: UnusedToken[] = []
  for (const varName of definedVars) {
    // Skip Tailwind @theme inline intermediates — consumed by class engine
    if (TAILWIND_THEME_PREFIXES.some(prefix => varName.startsWith(prefix))) continue

    // Check if referenced via var() in any source file
    if (referencedVars.has(varName)) continue

    // Check if referenced in index.css itself outside generated regions
    // (e.g., @theme inline block referencing var(--surface))
    const refInCssRegex = new RegExp(`var\\(${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`)
    if (refInCssRegex.test(css)) continue

    unusedTokens.push({ variable: varName })
  }

  return { staleRefs, unusedTokens }
}

// ─── 2. Component Drift Detection ────────────────────────────────────────────

async function detectComponentDrift(db: DB): Promise<ComponentDriftItem[]> {
  const fileKey = db.figmaFileKey
  const drift: ComponentDriftItem[] = []

  // Fetch all components from Figma
  const data = await figmaGet(`/files/${fileKey}/components`) as {
    meta: { components: FigmaComponentMeta[] }
  }

  const figmaComponents = data.meta.components
  const figmaNodeIds = new Set(figmaComponents.map(c => c.node_id))

  // Build set of DB-tracked Figma node IDs (from component entries, not parts)
  // The component key in DB IS the Figma node ID of the top-level component
  const dbComponentNodeIds = new Set<string>()
  const dbComponentsByNodeId = new Map<string, ComponentEntry>()
  for (const [nodeId, comp] of Object.entries(db.components)) {
    dbComponentNodeIds.add(nodeId)
    dbComponentsByNodeId.set(nodeId, comp)
  }

  // In Figma but not in DB
  for (const fc of figmaComponents) {
    if (!dbComponentNodeIds.has(fc.node_id)) {
      drift.push({
        name: fc.name,
        nodeId: fc.node_id,
        direction: 'figma-only',
      })
    }
  }

  // In DB but not in Figma
  for (const [nodeId, comp] of Object.entries(db.components)) {
    if (!figmaNodeIds.has(nodeId)) {
      drift.push({
        name: comp.name,
        nodeId,
        direction: 'db-only',
        dsKey: comp.dsKey,
      })
    }
  }

  return drift
}

// ─── 3. Variant Drift Detection ──────────────────────────────────────────────

async function detectVariantDrift(db: DB): Promise<VariantDriftItem[]> {
  const fileKey = db.figmaFileKey
  const drift: VariantDriftItem[] = []

  // Collect all unique Figma node IDs from component entries (top-level)
  const nodeIds: string[] = Object.keys(db.components)
  if (nodeIds.length === 0) return drift

  // Batch fetch node data (max 50 per request)
  const BATCH_SIZE = 50
  const allNodes = new Map<string, { document: Record<string, unknown> }>()

  for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + BATCH_SIZE)
    const idsParam = batch.join(',')

    const data = await figmaGet(`/files/${fileKey}/nodes?ids=${idsParam}`) as {
      nodes: Record<string, { document: Record<string, unknown> }>
    }

    for (const [nodeId, nodeData] of Object.entries(data.nodes)) {
      if (nodeData?.document) {
        allNodes.set(nodeId, nodeData)
      }
    }
  }

  // For each component, check if it has componentPropertyDefinitions (variant props)
  for (const [nodeId, comp] of Object.entries(db.components)) {
    const nodeData = allNodes.get(nodeId)
    if (!nodeData) continue

    const doc = nodeData.document
    const propDefs = doc.componentPropertyDefinitions as Record<string, {
      type: string
      defaultValue: string | boolean
      variantOptions?: string[]
    }> | undefined

    if (!propDefs) continue

    // Extract variant property names and their options
    const figmaVariants: string[] = []
    for (const [propName, propDef] of Object.entries(propDefs)) {
      if (propDef.type === 'VARIANT' && propDef.variantOptions) {
        for (const option of propDef.variantOptions) {
          figmaVariants.push(`${propName}=${option}`)
        }
      }
    }

    if (figmaVariants.length === 0) continue

    // Compare against DB parts
    const dbParts = Object.keys(comp.parts)

    drift.push({
      component: comp.name,
      dsKey: comp.dsKey,
      figmaNodeId: nodeId,
      figmaVariants,
      dbParts,
    })
  }

  return drift
}

// ─── Report Generation ───────────────────────────────────────────────────────

function generateReport(
  tokenDrift: { staleRefs: StaleRef[]; unusedTokens: UnusedToken[] },
  componentDrift: ComponentDriftItem[] | null,
  variantDrift: VariantDriftItem[] | null,
): string {
  const lines: string[] = []
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')

  lines.push('# Sombra DS Drift Report')
  lines.push(`Generated: ${now}`)
  lines.push('')

  // ── Token Drift ──
  lines.push('## Token Drift')
  lines.push('')

  if (tokenDrift.staleRefs.length > 0) {
    lines.push('### Referenced but not defined (stale)')
    lines.push('')
    for (const ref of tokenDrift.staleRefs) {
      lines.push(`- \`${ref.variable}\` referenced in \`${ref.file}:${ref.line}\``)
    }
    lines.push('')
  }

  if (tokenDrift.unusedTokens.length > 0) {
    lines.push('### Defined but never referenced (unused)')
    lines.push('')
    for (const tok of tokenDrift.unusedTokens) {
      lines.push(`- \`${tok.variable}\` defined in \`src/index.css\``)
    }
    lines.push('')
  }

  if (tokenDrift.staleRefs.length === 0 && tokenDrift.unusedTokens.length === 0) {
    lines.push('No token drift detected.')
    lines.push('')
  }

  // ── Component Drift ──
  lines.push('## Component Drift')
  lines.push('')

  if (componentDrift === null) {
    lines.push('Skipped (FIGMA_TOKEN not set)')
    lines.push('')
  } else if (componentDrift.length === 0) {
    lines.push('No component drift detected.')
    lines.push('')
  } else {
    const figmaOnly = componentDrift.filter(d => d.direction === 'figma-only')
    const dbOnly = componentDrift.filter(d => d.direction === 'db-only')

    if (figmaOnly.length > 0) {
      lines.push('### In Figma, not in DB')
      lines.push('')
      for (const item of figmaOnly) {
        lines.push(`- "${item.name}" (node \`${item.nodeId}\`)`)
      }
      lines.push('')
    }

    if (dbOnly.length > 0) {
      lines.push('### In DB, not found in Figma')
      lines.push('')
      for (const item of dbOnly) {
        lines.push(`- "${item.name}" (dsKey: \`${item.dsKey}\`, node \`${item.nodeId}\`)`)
      }
      lines.push('')
    }
  }

  // ── Variant Drift ──
  lines.push('## Variant Drift')
  lines.push('')

  if (variantDrift === null) {
    lines.push('Skipped (FIGMA_TOKEN not set)')
    lines.push('')
  } else if (variantDrift.length === 0) {
    lines.push('No variant drift detected.')
    lines.push('')
  } else {
    for (const item of variantDrift) {
      lines.push(`### ${item.component} (\`${item.dsKey}\`, node \`${item.figmaNodeId}\`)`)
      lines.push('')
      lines.push('**Figma variant properties:**')
      for (const v of item.figmaVariants) {
        lines.push(`- \`${v}\``)
      }
      lines.push('')
      lines.push('**DB parts:**')
      for (const p of item.dbParts) {
        lines.push(`- \`${p}\``)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Sombra DS Drift Check')
  console.log('=====================\n')

  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  let hasDrift = false

  // 1. Token drift (always runs, no API needed)
  console.log('1. Checking token drift...')
  const tokenDrift = detectTokenDrift()

  if (tokenDrift.staleRefs.length > 0) {
    hasDrift = true
    console.log(`   ${tokenDrift.staleRefs.length} stale var() reference(s)`)
    for (const ref of tokenDrift.staleRefs) {
      console.log(`     ${ref.variable} in ${ref.file}:${ref.line}`)
    }
  }
  if (tokenDrift.unusedTokens.length > 0) {
    hasDrift = true
    console.log(`   ${tokenDrift.unusedTokens.length} unused token(s)`)
    for (const tok of tokenDrift.unusedTokens) {
      console.log(`     ${tok.variable}`)
    }
  }
  if (tokenDrift.staleRefs.length === 0 && tokenDrift.unusedTokens.length === 0) {
    console.log('   No token drift.')
  }

  // 2 & 3. Figma drift (requires FIGMA_TOKEN)
  let componentDrift: ComponentDriftItem[] | null = null
  let variantDrift: VariantDriftItem[] | null = null

  if (!FIGMA_TOKEN) {
    console.log('\n2. Skipping component drift (FIGMA_TOKEN not set)')
    console.log('3. Skipping variant drift (FIGMA_TOKEN not set)')
  } else {
    try {
      // 2. Component drift
      console.log('\n2. Checking component drift...')
      componentDrift = await detectComponentDrift(db)

      const figmaOnly = componentDrift.filter(d => d.direction === 'figma-only')
      const dbOnly = componentDrift.filter(d => d.direction === 'db-only')

      if (componentDrift.length > 0) {
        hasDrift = true
        if (figmaOnly.length > 0) {
          console.log(`   ${figmaOnly.length} component(s) in Figma but not tracked in DB`)
          for (const item of figmaOnly) {
            console.log(`     "${item.name}" (${item.nodeId})`)
          }
        }
        if (dbOnly.length > 0) {
          console.log(`   ${dbOnly.length} component(s) in DB but not found in Figma`)
          for (const item of dbOnly) {
            console.log(`     "${item.name}" (${item.dsKey}, ${item.nodeId})`)
          }
        }
      } else {
        console.log('   No component drift.')
      }

      // 3. Variant drift
      console.log('\n3. Checking variant drift...')
      variantDrift = await detectVariantDrift(db)

      if (variantDrift.length > 0) {
        hasDrift = true
        console.log(`   ${variantDrift.length} component(s) with variant properties to review`)
        for (const item of variantDrift) {
          console.log(`     ${item.component}: ${item.figmaVariants.length} Figma variant(s), ${item.dbParts.length} DB part(s)`)
        }
      } else {
        console.log('   No variant drift.')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`\n   Figma API error: ${msg}`)
      console.log('   Skipping component and variant drift checks.')
    }
  }

  // Generate and write report
  const report = generateReport(tokenDrift, componentDrift, variantDrift)
  writeFileSync(REPORT_PATH, report, 'utf-8')
  console.log(`\nReport written to drift-report.md`)

  // Summary
  console.log('\n─────────────────────────────────────')
  if (hasDrift) {
    console.log('Drift detected. See drift-report.md for details.')
    process.exit(1)
  } else {
    console.log('No drift detected.')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
