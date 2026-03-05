/**
 * figma-audit.ts — Compares the designable subset of sombra.ds.json
 * against Figma REST API node data for component parts that have figmaNodeId.
 *
 * Checks: padding, gap, radius, layout, fill, stroke, text style, text color.
 * Does NOT check: cursor, transition, z-index, position, overflow, pointer-events
 * (code-only, no Figma equivalent).
 *
 * Requires FIGMA_TOKEN env var.
 *
 * Usage:
 *   npx tsx scripts/figma-audit.ts        # run audit
 *   npx tsx scripts/figma-audit.ts --fix   # auto-fix DB values from Figma (future)
 */

import { readFileSync, existsSync } from 'fs'
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

if (!FIGMA_TOKEN) {
  console.error('Missing FIGMA_TOKEN. Set it in .env or export FIGMA_TOKEN=...')
  process.exit(1)
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface StrokeDef {
  side?: string
  color?: string
  weight?: number
}

interface ComponentPart {
  figmaNodeId: string | null
  layout?: 'horizontal' | 'vertical'
  fill?: string
  stroke?: StrokeDef
  radius?: string | Record<string, string>
  padding?: string | Record<string, string>
  gap?: string | Record<string, string>
  align?: string
  justify?: string
  effects?: Array<{ type: string; class: string }>
  extra?: string
  textStyle?: string
  textColor?: string
  [key: string]: unknown
}

interface ComponentEntry {
  name: string
  type: string
  dsKey: string
  codeFile: string | null
  parts: Record<string, ComponentPart>
}

interface DB {
  version: number
  figmaFileKey: string
  colors: Record<string, { figmaName: string; cssVar: string; value: string; tailwind: { namespace: string; key: string } }>
  spacing: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  radius: Record<string, { figmaName: string; value: number; unit: string; tailwind: { namespace: string; key: string } }>
  textStyles: Record<string, { figmaName: string; utility: string; properties: Record<string, string | number> }>
  components: Record<string, ComponentEntry>
  [key: string]: unknown
}

// Figma API types (subset)
interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
  // Auto-layout
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE'
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  itemSpacing?: number
  counterAxisSpacing?: number
  // Corner radius
  topLeftRadius?: number
  topRightRadius?: number
  bottomLeftRadius?: number
  bottomRightRadius?: number
  cornerRadius?: number
  // Fill / Stroke
  fills?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; blendMode?: string; visible?: boolean }>
  strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; visible?: boolean }>
  strokeWeight?: number
  // Bound variables
  boundVariables?: Record<string, BoundVariable | BoundVariable[]>
  // Text
  style?: {
    fontFamily?: string
    fontPostScriptName?: string
    fontSize?: number
    fontWeight?: number
    lineHeightPx?: number
    letterSpacing?: number
    textCase?: string
  }
  styles?: Record<string, string>
}

interface BoundVariable {
  type: string
  id: string
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

// ─── Reverse maps ────────────────────────────────────────────────────────────

function buildReverseMaps(db: DB) {
  // VariableID → token key (e.g. "VariableID:106:3" → "surface")
  const colorVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.colors)) {
    colorVarToKey.set(varId, entry.tailwind.key)
  }

  // VariableID → spacing token key (e.g. "VariableID:106:30" → "md")
  const spacingVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.spacing)) {
    spacingVarToKey.set(varId, entry.tailwind.key)
  }

  // VariableID → radius token key
  const radiusVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.radius)) {
    radiusVarToKey.set(varId, entry.tailwind.key)
  }

  // spacing value → key (fallback when no bound variable)
  const spacingValueToKey = new Map<number, string>()
  for (const entry of Object.values(db.spacing)) {
    spacingValueToKey.set(entry.value, entry.tailwind.key)
  }

  // radius value → key (fallback)
  const radiusValueToKey = new Map<number, string>()
  for (const entry of Object.values(db.radius)) {
    radiusValueToKey.set(entry.value, entry.tailwind.key)
  }

  // color hex → key (fallback when no bound variable)
  const colorHexToKey = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    colorHexToKey.set(entry.value.toLowerCase(), entry.tailwind.key)
  }

  // figmaName → tailwind key (same mapping the generator uses)
  // e.g. "edge/default" → "edge", "surface/raised" → "surface-raised"
  const figmaNameToKey = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    figmaNameToKey.set(entry.figmaName, entry.tailwind.key)
  }

  return { colorVarToKey, spacingVarToKey, radiusVarToKey, spacingValueToKey, radiusValueToKey, colorHexToKey, figmaNameToKey }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function figmaColorToHex(c: { r: number; g: number; b: number; a: number }): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`
}

function resolveBoundVar(
  boundVars: Record<string, BoundVariable | BoundVariable[]> | undefined,
  field: string,
  varToKey: Map<string, string>,
): string | null {
  if (!boundVars) return null
  const binding = boundVars[field]
  if (!binding) return null
  const bv = Array.isArray(binding) ? binding[0] : binding
  if (!bv?.id) return null
  return varToKey.get(bv.id) ?? null
}

/** Resolve a fill/stroke array bound variable (fills are arrays in Figma) */
function resolvePaintBoundVar(
  boundVars: Record<string, BoundVariable | BoundVariable[]> | undefined,
  field: string,
  varToKey: Map<string, string>,
): string | null {
  if (!boundVars) return null
  const binding = boundVars[field]
  if (!binding) return null
  // fills/strokes bind as arrays
  const arr = Array.isArray(binding) ? binding : [binding]
  if (arr.length === 0) return null
  const bv = arr[0]
  if (!bv?.id) return null
  return varToKey.get(bv.id) ?? null
}

// ─── Comparison functions ────────────────────────────────────────────────────

interface Mismatch {
  component: string
  part: string
  property: string
  expected: string
  actual: string
}

function compareLayout(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  mismatches: Mismatch[],
) {
  if (!dbPart.layout) return
  const expected = dbPart.layout === 'horizontal' ? 'HORIZONTAL' : 'VERTICAL'
  const actual = figmaNode.layoutMode ?? 'NONE'
  if (actual !== expected) {
    mismatches.push({
      component: compKey, part: partKey, property: 'layout',
      expected: dbPart.layout, actual: actual.toLowerCase(),
    })
  }
}

function comparePadding(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.padding) return
  const bv = figmaNode.boundVariables ?? {}

  // Resolve padding from Figma
  const figmaPadding = {
    left: resolveBoundVar(bv, 'paddingLeft', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.paddingLeft ?? 0) ?? `${figmaNode.paddingLeft ?? 0}px`,
    right: resolveBoundVar(bv, 'paddingRight', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.paddingRight ?? 0) ?? `${figmaNode.paddingRight ?? 0}px`,
    top: resolveBoundVar(bv, 'paddingTop', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.paddingTop ?? 0) ?? `${figmaNode.paddingTop ?? 0}px`,
    bottom: resolveBoundVar(bv, 'paddingBottom', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.paddingBottom ?? 0) ?? `${figmaNode.paddingBottom ?? 0}px`,
  }

  // Normalize DB padding to individual sides
  let dbPadding: { left?: string; right?: string; top?: string; bottom?: string; x?: string; y?: string }
  if (typeof dbPart.padding === 'string') {
    // uniform: "lg" → all sides
    dbPadding = { left: dbPart.padding, right: dbPart.padding, top: dbPart.padding, bottom: dbPart.padding }
  } else {
    dbPadding = {}
    const p = dbPart.padding
    if (p.x) { dbPadding.left = p.x; dbPadding.right = p.x }
    if (p.y) { dbPadding.top = p.y; dbPadding.bottom = p.y }
    if (p.left) dbPadding.left = p.left
    if (p.right) dbPadding.right = p.right
    if (p.top) dbPadding.top = p.top
    if (p.bottom) dbPadding.bottom = p.bottom
  }

  // Compare each side
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    const dbVal = dbPadding[side]
    if (!dbVal) continue // DB doesn't specify this side
    const figVal = figmaPadding[side]
    if (figVal !== dbVal) {
      mismatches.push({
        component: compKey, part: partKey, property: `padding.${side}`,
        expected: dbVal, actual: String(figVal),
      })
    }
  }
}

function compareGap(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.gap) return
  const bv = figmaNode.boundVariables ?? {}

  // Figma: itemSpacing is the primary axis gap
  const figmaItemSpacing = resolveBoundVar(bv, 'itemSpacing', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.itemSpacing ?? 0) ?? `${figmaNode.itemSpacing ?? 0}px`
  const figmaCounterSpacing = resolveBoundVar(bv, 'counterAxisSpacing', maps.spacingVarToKey) ?? maps.spacingValueToKey.get(figmaNode.counterAxisSpacing ?? 0) ?? null

  if (typeof dbPart.gap === 'string') {
    // uniform gap
    if (figmaItemSpacing !== dbPart.gap) {
      mismatches.push({
        component: compKey, part: partKey, property: 'gap',
        expected: dbPart.gap, actual: String(figmaItemSpacing),
      })
    }
  } else {
    // directional gap: { x: "md", y: "sm" }
    const isHorizontal = figmaNode.layoutMode === 'HORIZONTAL'
    // Primary axis = itemSpacing, cross axis = counterAxisSpacing
    const primaryKey = isHorizontal ? 'x' : 'y'
    const crossKey = isHorizontal ? 'y' : 'x'

    if (dbPart.gap[primaryKey]) {
      if (figmaItemSpacing !== dbPart.gap[primaryKey]) {
        mismatches.push({
          component: compKey, part: partKey, property: `gap.${primaryKey} (item)`,
          expected: dbPart.gap[primaryKey]!, actual: String(figmaItemSpacing),
        })
      }
    }
    if (dbPart.gap[crossKey] && figmaCounterSpacing) {
      if (figmaCounterSpacing !== dbPart.gap[crossKey]) {
        mismatches.push({
          component: compKey, part: partKey, property: `gap.${crossKey} (counter)`,
          expected: dbPart.gap[crossKey]!, actual: String(figmaCounterSpacing),
        })
      }
    }
  }
}

function compareRadius(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.radius) return
  const bv = figmaNode.boundVariables ?? {}

  // Resolve Figma radius — check bound variable first, then raw value
  const figmaRadius =
    resolveBoundVar(bv, 'topLeftRadius', maps.radiusVarToKey) ??
    maps.radiusValueToKey.get(figmaNode.cornerRadius ?? figmaNode.topLeftRadius ?? 0) ??
    `${figmaNode.cornerRadius ?? figmaNode.topLeftRadius ?? 0}px`

  if (typeof dbPart.radius === 'string') {
    if (figmaRadius !== dbPart.radius) {
      mismatches.push({
        component: compKey, part: partKey, property: 'radius',
        expected: dbPart.radius, actual: String(figmaRadius),
      })
    }
  } else {
    // Per-corner radius (e.g. { t: "md" })
    // For now, compare topLeft only as representative
    const dbTopLeft = dbPart.radius.t ?? dbPart.radius.tl
    if (dbTopLeft && figmaRadius !== dbTopLeft) {
      mismatches.push({
        component: compKey, part: partKey, property: 'radius.topLeft',
        expected: dbTopLeft, actual: String(figmaRadius),
      })
    }
  }
}

function compareFill(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.fill) return
  const bv = figmaNode.boundVariables ?? {}

  // Check bound variable on fill
  let figmaFillKey = resolvePaintBoundVar(bv, 'fills', maps.colorVarToKey)

  // Fallback: resolve from raw color
  if (!figmaFillKey && figmaNode.fills?.length) {
    const fill = figmaNode.fills[0]
    if (fill.type === 'SOLID' && fill.color && fill.visible !== false) {
      const hex = figmaColorToHex(fill.color).toLowerCase()
      figmaFillKey = maps.colorHexToKey.get(hex) ?? hex
    }
  }

  if (!figmaFillKey) return // No fill to compare

  // Resolve DB fill to Tailwind key using same mapping as the generator:
  // 1. Check figmaNameToKey (e.g. "edge/default" → "edge")
  // 2. Handle CSS color names (e.g. "black" → compare against hex)
  // 3. Fallback: convert slash to dash
  const dbFillKey = maps.figmaNameToKey.get(dbPart.fill) ?? dbPart.fill.replace(/\//g, '-')

  // Handle CSS color names that aren't in the DS color map
  const CSS_COLORS: Record<string, string> = { black: '#000000', white: '#ffffff' }
  if (CSS_COLORS[dbFillKey] && figmaFillKey === CSS_COLORS[dbFillKey]) return // match

  if (figmaFillKey !== dbFillKey) {
    mismatches.push({
      component: compKey, part: partKey, property: 'fill',
      expected: dbFillKey, actual: figmaFillKey,
    })
  }
}

function compareStroke(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.stroke) return
  const bv = figmaNode.boundVariables ?? {}

  // Check bound variable on stroke
  let figmaStrokeKey = resolvePaintBoundVar(bv, 'strokes', maps.colorVarToKey)

  // Fallback: resolve from raw color
  if (!figmaStrokeKey && figmaNode.strokes?.length) {
    const stroke = figmaNode.strokes[0]
    if (stroke.type === 'SOLID' && stroke.color && stroke.visible !== false) {
      const hex = figmaColorToHex(stroke.color).toLowerCase()
      figmaStrokeKey = maps.colorHexToKey.get(hex) ?? hex
    }
  }

  // Resolve DB stroke color using figmaNameToKey (same as generator)
  const dbStrokeColor = dbPart.stroke.color
    ? (maps.figmaNameToKey.get(dbPart.stroke.color) ?? dbPart.stroke.color.replace(/\//g, '-'))
    : undefined
  if (dbStrokeColor && figmaStrokeKey && figmaStrokeKey !== dbStrokeColor) {
    mismatches.push({
      component: compKey, part: partKey, property: 'stroke.color',
      expected: dbStrokeColor, actual: figmaStrokeKey,
    })
  }
}

function compareTextStyle(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  db: DB,
  mismatches: Mismatch[],
) {
  if (!dbPart.textStyle) return

  // Find text children in the Figma node
  const textChildren = findTextChildren(figmaNode)
  if (textChildren.length === 0) return

  // Check if any text child has the expected text style applied
  const dbStyleEntry = Object.values(db.textStyles).find(ts => ts.utility === dbPart.textStyle)
  if (!dbStyleEntry) return

  // For text style comparison, we check font properties on the first text child
  const textNode = textChildren[0]
  if (!textNode.style) return

  const expectedProps = dbStyleEntry.properties
  const actualFontSize = textNode.style.fontSize
  const actualFontWeight = textNode.style.fontWeight

  if (expectedProps['font-size'] && actualFontSize) {
    const expectedSize = parseFloat(String(expectedProps['font-size']))
    if (Math.abs(actualFontSize - expectedSize) > 0.5) {
      mismatches.push({
        component: compKey, part: partKey, property: 'textStyle.fontSize',
        expected: `${expectedSize}px (${dbPart.textStyle})`,
        actual: `${actualFontSize}px`,
      })
    }
  }

  if (expectedProps['font-weight'] && actualFontWeight) {
    const expectedWeight = Number(expectedProps['font-weight'])
    if (actualFontWeight !== expectedWeight) {
      mismatches.push({
        component: compKey, part: partKey, property: 'textStyle.fontWeight',
        expected: `${expectedWeight} (${dbPart.textStyle})`,
        actual: `${actualFontWeight}`,
      })
    }
  }
}

function compareTextColor(
  dbPart: ComponentPart,
  figmaNode: FigmaNode,
  compKey: string,
  partKey: string,
  maps: ReturnType<typeof buildReverseMaps>,
  mismatches: Mismatch[],
) {
  if (!dbPart.textColor) return

  // Find text children
  const textChildren = findTextChildren(figmaNode)
  if (textChildren.length === 0) return

  const textNode = textChildren[0]
  const bv = textNode.boundVariables ?? {}

  // Check bound variable on text fill
  let figmaTextColor = resolvePaintBoundVar(bv, 'fills', maps.colorVarToKey)

  // Fallback: resolve from raw color
  if (!figmaTextColor && textNode.fills?.length) {
    const fill = textNode.fills[0]
    if (fill.type === 'SOLID' && fill.color && fill.visible !== false) {
      const hex = figmaColorToHex(fill.color).toLowerCase()
      figmaTextColor = maps.colorHexToKey.get(hex) ?? hex
    }
  }

  if (figmaTextColor && figmaTextColor !== dbPart.textColor) {
    mismatches.push({
      component: compKey, part: partKey, property: 'textColor',
      expected: dbPart.textColor, actual: figmaTextColor,
    })
  }
}

/** Recursively find TEXT nodes */
function findTextChildren(node: FigmaNode): FigmaNode[] {
  const results: FigmaNode[] = []
  if (node.type === 'TEXT') {
    results.push(node)
  }
  if (node.children) {
    for (const child of node.children) {
      results.push(...findTextChildren(child))
    }
  }
  return results
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Figma Design Audit')
  console.log('==================\n')

  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  const fileKey = db.figmaFileKey
  const maps = buildReverseMaps(db)

  // Collect all figmaNodeIds
  const nodeIdMap = new Map<string, { compKey: string; partKey: string; part: ComponentPart }>()

  for (const [compId, comp] of Object.entries(db.components)) {
    for (const [partKey, part] of Object.entries(comp.parts)) {
      if (part.figmaNodeId) {
        nodeIdMap.set(part.figmaNodeId, {
          compKey: `${comp.dsKey}.${partKey}`,
          partKey,
          part,
        })
      }
    }
  }

  const nodeIds = [...nodeIdMap.keys()]
  console.log(`Found ${nodeIds.length} component parts with Figma node IDs`)

  if (nodeIds.length === 0) {
    console.log('Nothing to audit.')
    return
  }

  // Batch-fetch nodes (Figma allows up to 50 ids per request)
  const BATCH_SIZE = 50
  const allNodes = new Map<string, FigmaNode>()

  for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
    const batch = nodeIds.slice(i, i + BATCH_SIZE)
    const idsParam = batch.join(',')
    console.log(`Fetching batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} nodes)...`)

    const data = await figmaGet(`/files/${fileKey}/nodes?ids=${idsParam}&geometry=paths`) as {
      nodes: Record<string, { document: FigmaNode }>
    }

    for (const [nodeId, nodeData] of Object.entries(data.nodes)) {
      if (nodeData?.document) {
        let node = nodeData.document

        // Handle COMPONENT_SET: drill into first child (default variant)
        if (node.type === 'COMPONENT_SET' && node.children?.length) {
          node = node.children[0]
        }

        allNodes.set(nodeId, node)
      }
    }
  }

  console.log(`Fetched ${allNodes.size} nodes\n`)

  // Run comparisons
  const mismatches: Mismatch[] = []
  let checked = 0

  for (const [nodeId, info] of nodeIdMap) {
    const figmaNode = allNodes.get(nodeId)
    if (!figmaNode) {
      console.log(`  ⚠ ${info.compKey}: node ${nodeId} not found in Figma`)
      continue
    }

    checked++
    compareLayout(info.part, figmaNode, info.compKey, info.partKey, mismatches)
    comparePadding(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
    compareGap(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
    compareRadius(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
    compareFill(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
    compareStroke(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
    compareTextStyle(info.part, figmaNode, info.compKey, info.partKey, db, mismatches)
    compareTextColor(info.part, figmaNode, info.compKey, info.partKey, maps, mismatches)
  }

  // Report
  console.log('─────────────────────────────────────')
  console.log(`Checked ${checked} component parts`)
  console.log(`Found ${mismatches.length} mismatches`)
  console.log('─────────────────────────────────────\n')

  if (mismatches.length === 0) {
    console.log('✅ All Figma-designable properties match the DB!')
  } else {
    console.log('❌ Mismatches found:\n')
    for (const m of mismatches) {
      console.log(`  ${m.component} → ${m.property}`)
      console.log(`    DB:    ${m.expected}`)
      console.log(`    Figma: ${m.actual}`)
      console.log()
    }
  }

  process.exit(mismatches.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
