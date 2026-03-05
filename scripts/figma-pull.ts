/**
 * figma-pull.ts — Fetches Figma variables/text styles via REST API
 * and updates tokens/sombra.ds.json with any changes.
 *
 * Uses version-check optimization: skips full scan if Figma file hasn't changed.
 *
 * Requires FIGMA_TOKEN env var (personal access token from figma.com/developers).
 * Set it in .env or export it in your shell.
 *
 * Usage:
 *   npx tsx scripts/figma-pull.ts            # pull changes from Figma
 *   npx tsx scripts/figma-pull.ts --force     # skip version check, always scan
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
const FIGMA_TOKEN = process.env.FIGMA_TOKEN
const FORCE = process.argv.includes('--force')

if (!FIGMA_TOKEN) {
  console.error('Missing FIGMA_TOKEN. Set it in .env or export FIGMA_TOKEN=...')
  console.error('Get a personal access token at https://www.figma.com/developers/api#access-tokens')
  process.exit(1)
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DB {
  version: number
  lastSync: string
  lastFigmaVersion?: number
  figmaFileKey: string
  colors: Record<string, { figmaName: string; cssVar: string; value: string; tailwind: { namespace: string; key: string } }>
  portColors: Record<string, { figmaName: string; value: string }>
  spacing: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  radius: Record<string, { figmaName: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  sizes: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: Array<{ namespace: string; key: string }> }>
  textStyles: Record<string, { figmaName: string; utility: string; properties: Record<string, string | number> }>
  [key: string]: unknown
}

interface Change {
  type: 'update' | 'new' | 'delete'
  section: string
  name: string
  before?: string
  after?: string
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

// ─── Color conversion ────────────────────────────────────────────────────────

function figmaColorToHex(c: { r: number; g: number; b: number; a: number }): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  if (c.a < 1) {
    // Use oklch for alpha values (matching the edge/card pattern)
    return `oklch(1 0 0 / ${Math.round(c.a * 100)}%)`
  }
  return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  const fileKey = db.figmaFileKey

  console.log(`Figma file: ${fileKey}`)

  // Step 1: Version check
  if (!FORCE) {
    const fileData = await figmaGet(`/files/${fileKey}?depth=1`) as { version: string }
    const version = parseInt(fileData.version)

    if (db.lastFigmaVersion && version === db.lastFigmaVersion) {
      console.log(`Figma version ${version} — no changes since last sync`)
      process.exit(0)
    }

    console.log(`Figma version ${db.lastFigmaVersion ?? '(none)'} → ${version} (changed since last sync)`)
    db.lastFigmaVersion = version
  } else {
    console.log('Force mode — skipping version check')
  }

  // Step 2: Fetch variables
  console.log('Fetching variables...')
  const varsData = await figmaGet(`/files/${fileKey}/variables/local`) as {
    meta: {
      variables: Record<string, {
        id: string
        name: string
        variableCollectionId: string
        resolvedType: string
        valuesByMode: Record<string, unknown>
      }>
      variableCollections: Record<string, {
        id: string
        name: string
        modes: Array<{ modeId: string; name: string }>
      }>
    }
  }

  const variables = varsData.meta.variables
  const collections = varsData.meta.variableCollections

  // Build collection name lookup
  const collectionNames: Record<string, string> = {}
  for (const col of Object.values(collections)) {
    collectionNames[col.id] = col.name
  }

  const changes: Change[] = []

  // Process each variable
  for (const variable of Object.values(variables)) {
    const collectionName = collectionNames[variable.variableCollectionId]
    const varId = variable.id

    // Get the first mode value (dark mode = default)
    const modeId = Object.keys(variable.valuesByMode)[0]
    const rawValue = variable.valuesByMode[modeId] as { r?: number; g?: number; b?: number; a?: number } | number | string

    if (collectionName === 'UI Colors' && variable.resolvedType === 'COLOR') {
      const figmaValue = typeof rawValue === 'object' && 'r' in rawValue
        ? figmaColorToHex(rawValue as { r: number; g: number; b: number; a: number })
        : String(rawValue)

      // Look up in DB
      if (db.colors[varId]) {
        if (db.colors[varId].value !== figmaValue) {
          changes.push({
            type: 'update', section: 'colors', name: db.colors[varId].figmaName,
            before: db.colors[varId].value, after: figmaValue
          })
          db.colors[varId].value = figmaValue
        }
      } else {
        // Check if this is the `white` utility variable (no CSS var)
        // Skip it — it's not a Sombra token
        if (variable.name !== 'white') {
          changes.push({ type: 'new', section: 'colors', name: variable.name, after: figmaValue })
          console.log(`  + NEW: colors/${variable.name} (${varId}) — needs manual DB entry with cssVar/tailwind`)
        }
      }
    }

    if (collectionName === 'Port Types' && variable.resolvedType === 'COLOR') {
      const figmaValue = typeof rawValue === 'object' && 'r' in rawValue
        ? figmaColorToHex(rawValue as { r: number; g: number; b: number; a: number })
        : String(rawValue)

      if (db.portColors[varId]) {
        if (db.portColors[varId].value !== figmaValue) {
          changes.push({
            type: 'update', section: 'portColors', name: db.portColors[varId].figmaName,
            before: db.portColors[varId].value, after: figmaValue
          })
          db.portColors[varId].value = figmaValue
        }
      } else {
        changes.push({ type: 'new', section: 'portColors', name: variable.name, after: figmaValue })
        console.log(`  + NEW: portColors/${variable.name} (${varId}) — needs manual DB entry`)
      }
    }

    if (collectionName === 'Spacing' && variable.resolvedType === 'FLOAT') {
      const figmaValue = Number(rawValue)
      if (db.spacing[varId]) {
        if (db.spacing[varId].value !== figmaValue) {
          changes.push({
            type: 'update', section: 'spacing', name: db.spacing[varId].figmaName,
            before: `${db.spacing[varId].value}px`, after: `${figmaValue}px`
          })
          db.spacing[varId].value = figmaValue
        }
      } else {
        changes.push({ type: 'new', section: 'spacing', name: variable.name, after: `${figmaValue}px` })
        console.log(`  + NEW: spacing/${variable.name} (${varId}) — needs manual DB entry`)
      }
    }

    if (collectionName === 'Radius' && variable.resolvedType === 'FLOAT') {
      const figmaValue = Number(rawValue)
      if (db.radius[varId]) {
        if (db.radius[varId].value !== figmaValue) {
          changes.push({
            type: 'update', section: 'radius', name: db.radius[varId].figmaName,
            before: `${db.radius[varId].value}px`, after: `${figmaValue}px`
          })
          db.radius[varId].value = figmaValue
        }
      } else {
        changes.push({ type: 'new', section: 'radius', name: variable.name, after: `${figmaValue}px` })
        console.log(`  + NEW: radius/${variable.name} (${varId}) — needs manual DB entry`)
      }
    }

    if (collectionName === 'Sizes' && variable.resolvedType === 'FLOAT') {
      const figmaValue = Number(rawValue)
      if (db.sizes[varId]) {
        if (db.sizes[varId].value !== figmaValue) {
          changes.push({
            type: 'update', section: 'sizes', name: db.sizes[varId].figmaName,
            before: `${db.sizes[varId].value}px`, after: `${figmaValue}px`
          })
          db.sizes[varId].value = figmaValue
        }
      } else {
        changes.push({ type: 'new', section: 'sizes', name: variable.name, after: `${figmaValue}px` })
        console.log(`  + NEW: sizes/${variable.name} (${varId}) — needs manual DB entry`)
      }
    }
  }

  // Step 3: Fetch text styles
  console.log('Fetching text styles...')
  const fileData = await figmaGet(`/files/${fileKey}?depth=1`) as {
    styles: Record<string, { key: string; name: string; styleType: string; description: string }>
  }

  // Text styles require fetching individual style nodes for properties
  // The /files endpoint gives us style metadata but not the actual font properties
  // We'd need to fetch nodes that USE these styles to get the resolved properties
  // For now, we report text style changes by name only

  if (fileData.styles) {
    const textStyleKeys = new Set(Object.keys(db.textStyles))
    for (const [_, style] of Object.entries(fileData.styles)) {
      if (style.styleType === 'TEXT') {
        const dbKey = `S:${style.key},`
        if (!textStyleKeys.has(dbKey)) {
          changes.push({ type: 'new', section: 'textStyles', name: style.name })
          console.log(`  + NEW: textStyle/${style.name} — needs manual DB entry`)
        }
      }
    }
  }

  // Step 4: Report changes
  const updates = changes.filter(c => c.type === 'update')
  const newItems = changes.filter(c => c.type === 'new')

  if (changes.length === 0) {
    console.log('\nNo token changes detected.')
  } else {
    for (const change of updates) {
      console.log(`  ✎ ${change.section}: ${change.name} ${change.before} → ${change.after}`)
    }
    for (const change of newItems) {
      console.log(`  + ${change.section}: ${change.name} ${change.after ?? '(new)'}`)
    }
    console.log(`\n${updates.length} tokens updated, ${newItems.length} new tokens detected`)
  }

  // Step 5: Write DB
  db.lastSync = new Date().toISOString()
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', 'utf-8')
  console.log('Updated tokens/sombra.ds.json')
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
