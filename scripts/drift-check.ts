/**
 * drift-check.ts — Detects token usage drift, component drift, and variant drift
 * between Figma, the DB (sombra.ds.json), and code.
 *
 * 1. Token drift (local only): stale var() refs, unused defined tokens
 * 2. Component drift (reads tokens/figma-components.json): Figma vs DB component tracking
 * 3. Variant drift (reads tokens/figma-components.json): Figma variant properties vs DB parts
 *
 * Run `npm run drift:collect` first to generate the Figma snapshot.
 *
 * Usage:
 *   npx tsx scripts/drift-check.ts
 *
 * Exit code 0 if no drift, 1 if any drift found.
 * Writes drift-report.md to project root.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { resolve, extname } from 'path'

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')
const SNAPSHOT_PATH = resolve(ROOT, 'tokens/figma-components.json')
const INDEX_CSS_PATH = resolve(ROOT, 'src/index.css')
const SRC_DIR = resolve(ROOT, 'src')
const REPORT_PATH = resolve(ROOT, 'drift-report.md')

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])
const STALENESS_MS = 24 * 60 * 60 * 1000 // 24 hours

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

interface FigmaSnapshotComponent {
  id: string
  name: string
  type: 'COMPONENT' | 'COMPONENT_SET'
  parentId: string | null
  parentName: string | null
  properties: Record<string, {
    type: string
    defaultValue: string | boolean
    options: string[] | null
  }>
  variants?: Array<{ id: string; name: string }>
}

interface FigmaSnapshot {
  generatedAt: string
  fileKey: string
  components: FigmaSnapshotComponent[]
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

// ─── Figma Snapshot Reader ──────────────────────────────────────────────────

function readFigmaSnapshot(): FigmaSnapshot | null {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.log('   Run `npm run drift:collect` first to generate Figma snapshot')
    return null
  }

  const snapshot: FigmaSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'))
  const age = Date.now() - new Date(snapshot.generatedAt).getTime()

  if (age > STALENESS_MS) {
    const hours = Math.round(age / 3600000)
    console.log(`   Warning: Snapshot is ${hours}h old — consider re-running drift:collect`)
  }

  return snapshot
}

// ─── File scanning ───────────────────────────────────────────────────────────

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name)
    if (!SCAN_EXTENSIONS.has(ext)) continue
    const fullPath = resolve(entry.parentPath ?? entry.path, entry.name)
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
    const propRegex = /(--[\w-]+)\s*:/g
    let propMatch: RegExpExecArray | null
    while ((propMatch = propRegex.exec(block)) !== null) {
      definedVars.add(propMatch[1])
    }
  }

  // Scan source files for var(--*) references
  const sourceFiles = collectSourceFiles(SRC_DIR)
  const referencedVars = new Map<string, Array<{ file: string; line: number }>>()

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue

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

  // Stale refs: referenced but not defined
  const staleRefs: StaleRef[] = []
  for (const [varName, locations] of referencedVars) {
    if (!definedVars.has(varName)) {
      if (varName.startsWith('--tw-')) continue
      const definedAnywhere = new RegExp(`${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(css)
      if (definedAnywhere) continue
      for (const loc of locations) {
        staleRefs.push({ variable: varName, file: loc.file, line: loc.line })
      }
    }
  }

  // Unused tokens: defined but never referenced
  const TAILWIND_THEME_PREFIXES = ['--color-', '--radius-', '--spacing-', '--size-', '--min-width-']
  const unusedTokens: UnusedToken[] = []
  for (const varName of definedVars) {
    if (TAILWIND_THEME_PREFIXES.some(prefix => varName.startsWith(prefix))) continue
    if (referencedVars.has(varName)) continue
    const refInCssRegex = new RegExp(`var\\(${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`)
    if (refInCssRegex.test(css)) continue
    unusedTokens.push({ variable: varName })
  }

  return { staleRefs, unusedTokens }
}

// ─── 2. Component Drift Detection ────────────────────────────────────────────

function detectComponentDrift(db: DB, snapshot: FigmaSnapshot): ComponentDriftItem[] {
  const drift: ComponentDriftItem[] = []

  // Build set of Figma component IDs from snapshot
  const figmaNodeIds = new Set(snapshot.components.map(c => c.id))

  // Build comprehensive set of all DB-tracked node IDs:
  // 1. Top-level component keys
  // 2. figmaNodeId values from all component parts
  // 3. nodeTemplate keys (node type Figma IDs tracked separately)
  // 4. Variant child IDs from tracked COMPONENT_SETs
  const trackedNodeIds = new Set(Object.keys(db.components))

  for (const comp of Object.values(db.components) as ComponentEntry[]) {
    for (const part of Object.values(comp.parts)) {
      if (part.figmaNodeId) trackedNodeIds.add(part.figmaNodeId)
    }
  }

  if (db.nodeTemplates) {
    for (const key of Object.keys(db.nodeTemplates as Record<string, unknown>)) {
      if (key !== '_shared') trackedNodeIds.add(key)
    }
  }

  // Add variant child IDs from tracked COMPONENT_SETs
  for (const fc of snapshot.components) {
    if (fc.type === 'COMPONENT_SET' && trackedNodeIds.has(fc.id) && fc.variants) {
      for (const v of fc.variants) {
        trackedNodeIds.add(v.id)
      }
    }
  }

  // In Figma but not tracked anywhere in DB
  for (const fc of snapshot.components) {
    if (!trackedNodeIds.has(fc.id)) {
      drift.push({
        name: fc.name,
        nodeId: fc.id,
        direction: 'figma-only',
      })
    }
  }

  // In DB (top-level) but not in Figma
  const dbComponentNodeIds = new Set(Object.keys(db.components))
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

function detectVariantDrift(db: DB, snapshot: FigmaSnapshot): VariantDriftItem[] {
  const drift: VariantDriftItem[] = []

  // Index snapshot COMPONENT_SET entries by ID
  const componentSets = new Map(
    snapshot.components
      .filter(c => c.type === 'COMPONENT_SET')
      .map(c => [c.id, c])
  )

  // For each DB component, check if it's a COMPONENT_SET in the snapshot
  for (const [nodeId, comp] of Object.entries(db.components)) {
    const figmaComp = componentSets.get(nodeId)
    if (!figmaComp) continue

    // Extract variant property names and their options
    const figmaVariants: string[] = []
    for (const [propName, propDef] of Object.entries(figmaComp.properties)) {
      if (propDef.type === 'VARIANT' && propDef.options) {
        for (const option of propDef.options) {
          figmaVariants.push(`${propName}=${option}`)
        }
      }
    }

    if (figmaVariants.length === 0) continue

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
    lines.push('Skipped (no Figma snapshot — run `npm run drift:collect`)')
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
    lines.push('Skipped (no Figma snapshot — run `npm run drift:collect`)')
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

function main() {
  console.log('Sombra DS Drift Check')
  console.log('=====================\n')

  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  let hasDrift = false

  // 1. Token drift (always runs, local only)
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

  // 2 & 3. Figma drift (reads from snapshot)
  let componentDrift: ComponentDriftItem[] | null = null
  let variantDrift: VariantDriftItem[] | null = null

  console.log('\n2. Checking component drift...')
  const snapshot = readFigmaSnapshot()

  if (!snapshot) {
    console.log('3. Skipping variant drift (no snapshot)')
  } else {
    console.log(`   Snapshot from ${snapshot.generatedAt} (${snapshot.components.length} components)`)

    componentDrift = detectComponentDrift(db, snapshot)
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
    variantDrift = detectVariantDrift(db, snapshot)

    if (variantDrift.length > 0) {
      hasDrift = true
      console.log(`   ${variantDrift.length} component(s) with variant properties to review`)
      for (const item of variantDrift) {
        console.log(`     ${item.component}: ${item.figmaVariants.length} Figma variant(s), ${item.dbParts.length} DB part(s)`)
      }
    } else {
      console.log('   No variant drift.')
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

main()
