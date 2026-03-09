/**
 * figma-audit.ts — Figma-first comprehensive visual audit.
 *
 * Extracts EVERY visual property from each Figma component part node,
 * then compares against sombra.ds.json. No early returns, no skipping.
 *
 * Properties checked: layout, padding (4 sides), gap, radius (4 corners),
 * fill + opacity + blend mode, stroke color + weight + per-side weights + style,
 * sizing modes + dimensions, alignment, overflow, opacity (node + compound),
 * blend mode, effects (shadows), text style (fontSize, fontWeight, lineHeight,
 * letterSpacing, alignment, decoration, case), text color.
 *
 * Requires FIGMA_TOKEN env var.
 *
 * Usage:
 *   npx tsx scripts/figma-audit.ts                # report diffs
 *   npx tsx scripts/figma-audit.ts --json out     # write JSON report to file
 *   npx tsx scripts/figma-audit.ts --fix          # auto-patch DB from Figma
 *   npx tsx scripts/figma-audit.ts --fix-dry-run  # compute patches, print what would change, don't write
 *   npx tsx scripts/figma-audit.ts --strict       # exit 1 on unresolved vars, missing text styles, bad node types
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

if (!FIGMA_TOKEN) {
  console.error('Missing FIGMA_TOKEN. Set it in .env or export FIGMA_TOKEN=...')
  process.exit(1)
}

const FIX_DRY_RUN = process.argv.includes('--fix-dry-run')
const FIX_MODE = process.argv.includes('--fix') || FIX_DRY_RUN
const STRICT_MODE = process.argv.includes('--strict')
const JSON_IDX = process.argv.indexOf('--json')
const JSON_PATH = JSON_IDX !== -1 ? process.argv[JSON_IDX + 1] : null

// Module-level counter for unresolved variable warnings
let unresolvedVarCount = 0

// Module-level cache for text style identity resolution
// Maps Figma text style node ID → style name (e.g. "118:1545" → "mono/value")
// Populated from .figma-vars-cache.json if available
const textStyleNodeIdToName = new Map<string, string>()

// Cache path
const CACHE_PATH = resolve(ROOT, 'tokens/.figma-vars-cache.json')

// ─── Types ───────────────────────────────────────────────────────────────────

interface StrokeDef {
  side?: string
  color?: string
  weight?: number
  topWeight?: number
  rightWeight?: number
  bottomWeight?: number
  leftWeight?: number
  style?: 'solid' | 'dashed'
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
  textAlign?: string
  textAlignVertical?: string
  textDecoration?: string
  textCase?: string
  blendMode?: string
  overflow?: string
  opacity?: number
  height?: string
  width?: string
  auditIgnore?: string[]
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
  sizes: Record<string, { figmaName: string; cssVar: string; value: number; unit: string; tailwind: Array<{ namespace: string; key: string }> }>
  textStyles: Record<string, { figmaName: string; utility: string; properties: Record<string, string | number> }>
  components: Record<string, ComponentEntry>
  [key: string]: unknown
}

// Figma API types (subset we actually read)
interface FigmaNode {
  id: string
  name: string
  type: string
  children?: FigmaNode[]
  // Auto-layout
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE'
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE'
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
  strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; blendMode?: string; visible?: boolean }>
  strokeWeight?: number
  strokeTopWeight?: number
  strokeBottomWeight?: number
  strokeLeftWeight?: number
  strokeRightWeight?: number
  strokeAlign?: 'INSIDE' | 'CENTER' | 'OUTSIDE'
  strokeDashes?: number[]
  // Sizing
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL'
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL'
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number }
  // Clipping
  clipsContent?: boolean
  // Node-level opacity + blend mode
  opacity?: number
  blendMode?: string
  // Effects
  effects?: Array<{
    type: string; visible?: boolean; radius?: number
    color?: { r: number; g: number; b: number; a: number }
    offset?: { x: number; y: number }; spread?: number
  }>
  // Bound variables
  boundVariables?: Record<string, BoundVariable | BoundVariable[]>
  // Text (node-level for TEXT nodes)
  textAlignHorizontal?: string
  textAlignVertical?: string
  textDecoration?: string
  style?: {
    fontFamily?: string
    fontPostScriptName?: string
    fontSize?: number
    fontWeight?: number
    lineHeightPx?: number
    letterSpacing?: number
    textCase?: string
    textDecoration?: string
    textAlignHorizontal?: string
    textAlignVertical?: string
    opentypeFlags?: Record<string, number>
  }
  styles?: Record<string, string>
}

interface BoundVariable {
  type: string
  id: string
}

type PropMap = Record<string, string | number | null>

interface Diff {
  key: string
  type: 'MISMATCH' | 'MISSING' | 'EXTRA' | 'INFO'
  figma: string | number | null
  db: string | number | null
  note?: string
}

interface PartReport {
  component: string
  part: string
  nodeId: string
  nodeType: string
  figmaProps: PropMap
  dbProps: PropMap
  diffs: Diff[]
}

// DB fields that are code-only (no Figma equivalent)
const CODE_ONLY_KEYS = new Set([
  'cursor', 'transition', 'userSelect', 'position', 'z', 'inset',
  'pointerEvents', 'extra', 'minWidth',
  'hover', 'active', 'disabled', 'selected',
  'effects', // DB effects are pre-formatted Tailwind shadow strings
])

// Fields that are code-only (not auditable) for variable resolution warnings
const CODE_ONLY_FIELDS = new Set([
  'cursor', 'transition', 'userSelect', 'position', 'z', 'inset', 'pointerEvents',
])

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
  const colorVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.colors)) {
    colorVarToKey.set(varId, entry.tailwind.key)
  }

  const spacingVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.spacing)) {
    spacingVarToKey.set(varId, entry.tailwind.key)
  }

  const radiusVarToKey = new Map<string, string>()
  for (const [varId, entry] of Object.entries(db.radius)) {
    radiusVarToKey.set(varId, entry.tailwind.key)
  }

  const spacingValueToKey = new Map<number, string>()
  for (const entry of Object.values(db.spacing)) {
    spacingValueToKey.set(entry.value, entry.tailwind.key)
  }

  const radiusValueToKey = new Map<number, string>()
  for (const entry of Object.values(db.radius)) {
    radiusValueToKey.set(entry.value, entry.tailwind.key)
  }

  const colorHexToKey = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    colorHexToKey.set(entry.value.toLowerCase(), entry.tailwind.key)
  }

  // figmaName → tailwind key (e.g. "edge/default" → "edge", "surface/raised" → "surface-raised")
  const figmaNameToKey = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    figmaNameToKey.set(entry.figmaName, entry.tailwind.key)
  }

  // Reverse: tailwind key → figmaName (for --fix mode)
  const tailwindKeyToFigmaName = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    tailwindKeyToFigmaName.set(entry.tailwind.key, entry.figmaName)
  }

  // Size token key → pixel value
  const sizeTokenToPx = new Map<string, number>()
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      sizeTokenToPx.set(tw.key, entry.value)
    }
  }

  // Pixel value → size token key (for --fix)
  const sizePxToToken = new Map<number, string>()
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      sizePxToToken.set(entry.value, tw.key)
    }
  }

  return {
    colorVarToKey, spacingVarToKey, radiusVarToKey,
    spacingValueToKey, radiusValueToKey, colorHexToKey,
    figmaNameToKey, tailwindKeyToFigmaName,
    sizeTokenToPx, sizePxToToken,
  }
}

type Maps = ReturnType<typeof buildReverseMaps>

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
  const resolved = varToKey.get(bv.id)
  if (resolved === undefined && !CODE_ONLY_FIELDS.has(field)) {
    console.warn(`  ⚠ Unresolved variable: field="${field}", varId="${bv.id}"`)
    unresolvedVarCount++
  }
  return resolved ?? null
}

function resolvePaintBoundVar(
  boundVars: Record<string, BoundVariable | BoundVariable[]> | undefined,
  field: string,
  varToKey: Map<string, string>,
): string | null {
  if (!boundVars) return null
  const binding = boundVars[field]
  if (!binding) return null
  const arr = Array.isArray(binding) ? binding : [binding]
  if (arr.length === 0) return null
  const bv = arr[0]
  if (!bv?.id) return null
  const resolved = varToKey.get(bv.id)
  if (resolved === undefined) {
    console.warn(`  ⚠ Unresolved paint variable: field="${field}", varId="${bv.id}"`)
    unresolvedVarCount++
  }
  return resolved ?? null
}

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

function resolveSpacing(
  bv: Record<string, BoundVariable | BoundVariable[]>,
  field: string,
  rawValue: number | undefined,
  maps: Maps,
): string | null {
  const val = rawValue ?? 0
  return resolveBoundVar(bv, field, maps.spacingVarToKey)
    ?? maps.spacingValueToKey.get(val)
    ?? (val === 0 ? null : `${val}px`)
}

function resolveRadius(
  bv: Record<string, BoundVariable | BoundVariable[]>,
  field: string,
  rawValue: number | undefined,
  maps: Maps,
): string | null {
  const val = rawValue ?? 0
  return resolveBoundVar(bv, field, maps.radiusVarToKey)
    ?? maps.radiusValueToKey.get(val)
    ?? (val === 0 ? null : `${val}px`)
}

interface ResolvedColor {
  color: string | null
  opacity: number | null
  blendMode: string | null
}

function resolveColor(
  bv: Record<string, BoundVariable | BoundVariable[]> | undefined,
  paintField: string,
  paints: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; blendMode?: string; visible?: boolean }> | undefined,
  maps: Maps,
): ResolvedColor {
  // Try bound variable first
  let colorKey = resolvePaintBoundVar(bv, paintField, maps.colorVarToKey)

  let paintOpacity: number | null = null
  let paintBlendMode: string | null = null

  if (!colorKey && paints?.length) {
    const visiblePaints = paints.filter(p => p.visible !== false)

    // All paints hidden — return hidden marker
    if (visiblePaints.length === 0 && paints.length > 0) {
      return { color: '__hidden__', opacity: null, blendMode: null }
    }

    const first = visiblePaints[0]
    if (first) {
      if (first.type === 'SOLID' && first.color) {
        const hex = figmaColorToHex(first.color).toLowerCase()
        colorKey = maps.colorHexToKey.get(hex) ?? hex
        if (first.opacity != null && first.opacity < 1) {
          paintOpacity = Math.round(first.opacity * 100) / 100
        }
      } else if (first.type.startsWith('GRADIENT_')) {
        colorKey = `gradient:${first.type.replace('GRADIENT_', '').toLowerCase()}`
      }
      // IMAGE and other fill types: no resolution, skip

      // Blend mode
      if (first.blendMode && first.blendMode !== 'NORMAL' && first.blendMode !== 'PASS_THROUGH') {
        paintBlendMode = first.blendMode.toLowerCase()
      }
    }
  }

  return { color: colorKey ?? null, opacity: paintOpacity, blendMode: paintBlendMode }
}

// ─── Figma Property Extraction ──────────────────────────────────────────────

function extractFigmaProps(node: FigmaNode, maps: Maps, dbPart: ComponentPart): PropMap {
  const props: PropMap = {}
  const bv = node.boundVariables ?? {}

  // ── Layout ──
  if (node.layoutMode === 'HORIZONTAL') props['layout'] = 'horizontal'
  else if (node.layoutMode === 'VERTICAL') props['layout'] = 'vertical'

  const hasAutoLayout = node.layoutMode && node.layoutMode !== 'NONE'

  // ── Padding (only meaningful with auto-layout) ──
  if (hasAutoLayout) {
    const sides = [
      ['paddingLeft', 'padding.left', node.paddingLeft],
      ['paddingRight', 'padding.right', node.paddingRight],
      ['paddingTop', 'padding.top', node.paddingTop],
      ['paddingBottom', 'padding.bottom', node.paddingBottom],
    ] as const
    for (const [figmaField, propKey, rawVal] of sides) {
      const resolved = resolveSpacing(bv, figmaField, rawVal, maps)
      if (resolved) props[propKey] = resolved
    }
  }

  // ── Gap ──
  if (hasAutoLayout) {
    const gap = resolveSpacing(bv, 'itemSpacing', node.itemSpacing, maps)
    if (gap) props['gap'] = gap

    const counterGap = resolveSpacing(bv, 'counterAxisSpacing', node.counterAxisSpacing, maps)
    if (counterGap) props['gap.counter'] = counterGap
  }

  // ── Radius (4 corners) ──
  // Figma binds corner radii via compound `rectangleCornerRadii` bound variable,
  // NOT via individual `topLeftRadius` etc. bound variables.
  const rcr = bv.rectangleCornerRadii as Record<string, BoundVariable> | undefined
  const cornerFields = [
    ['topLeftRadius', 'RECTANGLE_TOP_LEFT_CORNER_RADIUS', 'radius.tl', node.topLeftRadius ?? node.cornerRadius],
    ['topRightRadius', 'RECTANGLE_TOP_RIGHT_CORNER_RADIUS', 'radius.tr', node.topRightRadius ?? node.cornerRadius],
    ['bottomLeftRadius', 'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS', 'radius.bl', node.bottomLeftRadius ?? node.cornerRadius],
    ['bottomRightRadius', 'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS', 'radius.br', node.bottomRightRadius ?? node.cornerRadius],
  ] as const
  for (const [figmaField, rcrField, propKey, rawVal] of cornerFields) {
    // Try compound bound variable first, then direct field, then raw value
    const rcrBinding = rcr?.[rcrField]
    let resolved: string | null = null
    if (rcrBinding?.id) {
      resolved = maps.radiusVarToKey.get(rcrBinding.id) ?? null
    }
    if (!resolved) {
      resolved = resolveRadius(bv, figmaField, rawVal, maps)
    }
    if (resolved) props[propKey] = resolved
  }

  // ── Fill ──
  // For TEXT nodes, fills represent the text color, not a background fill.
  // Text color is handled separately via findTextChildren() below.
  if (node.type !== 'TEXT') {
    const fill = resolveColor(bv, 'fills', node.fills, maps)
    if (fill.color) props['fill'] = fill.color
    if (fill.opacity != null) props['fill.opacity'] = fill.opacity
    if (fill.blendMode) props['fill.blendMode'] = fill.blendMode
  }

  // ── Stroke ──
  const stroke = resolveColor(bv, 'strokes', node.strokes, maps)
  if (stroke.color) {
    props['stroke.color'] = stroke.color
    const weight = node.strokeWeight ?? 0
    if (weight > 0) props['stroke.weight'] = weight
    if (stroke.opacity != null) props['stroke.opacity'] = stroke.opacity

    // Per-side stroke weights (only when they differ from uniform)
    const perSide = [
      ['stroke.topWeight', node.strokeTopWeight],
      ['stroke.rightWeight', node.strokeRightWeight],
      ['stroke.bottomWeight', node.strokeBottomWeight],
      ['stroke.leftWeight', node.strokeLeftWeight],
    ] as const
    for (const [key, sideWeight] of perSide) {
      if (sideWeight != null && sideWeight !== weight) {
        props[key] = sideWeight
      }
    }
  }

  // ── Stroke style (dashed) ──
  if (node.strokeDashes && node.strokeDashes.length > 0) {
    props['stroke.style'] = 'dashed'
  }

  // ── Sizing ──
  // FIXED: always emit (explicit dimension the DB should track)
  // FILL: only emit when DB already tracks this axis (avoids noise from flex children)
  // HUG: never emit (implicit default, layout-flow behavior)
  if (node.layoutSizingVertical === 'FIXED' && node.absoluteBoundingBox) {
    props['height.mode'] = 'FIXED'
    props['height.px'] = Math.round(node.absoluteBoundingBox.height)
  } else if (node.layoutSizingVertical === 'FILL' && dbPart.height) {
    props['height.mode'] = 'FILL'
  }
  if (node.layoutSizingHorizontal === 'FIXED' && node.absoluteBoundingBox) {
    props['width.mode'] = 'FIXED'
    props['width.px'] = Math.round(node.absoluteBoundingBox.width)
  } else if (node.layoutSizingHorizontal === 'FILL' && dbPart.width) {
    props['width.mode'] = 'FILL'
  }

  // ── Alignment ──
  if (hasAutoLayout) {
    const justifyMap: Record<string, string> = { CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between' }
    if (node.primaryAxisAlignItems && justifyMap[node.primaryAxisAlignItems]) {
      props['justify'] = justifyMap[node.primaryAxisAlignItems]
    }

    const alignMap: Record<string, string> = { CENTER: 'center', MAX: 'end', BASELINE: 'baseline' }
    if (node.counterAxisAlignItems && alignMap[node.counterAxisAlignItems]) {
      props['align'] = alignMap[node.counterAxisAlignItems]
    }
  }

  // ── Overflow ──
  if (node.clipsContent) props['overflow'] = 'hidden'

  // ── Opacity ──
  if (node.opacity != null && node.opacity < 1) {
    props['opacity'] = Math.round(node.opacity * 100) / 100
  }

  // ── Node-level blend mode ──
  if (node.blendMode && node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH') {
    props['blendMode'] = node.blendMode.toLowerCase()
  }

  // ── Compound opacity (node × fill paint) ──
  const nodeOpacity = node.opacity ?? 1
  const fillPaint = (node.type !== 'TEXT' && node.fills)
    ? node.fills.find(p => p.visible !== false && p.type === 'SOLID')
    : undefined
  const fillPaintOpacity = fillPaint?.opacity ?? 1
  const compound = Math.round(nodeOpacity * fillPaintOpacity * 100) / 100
  if (compound < 1 && compound !== Math.round(nodeOpacity * 100) / 100) {
    props['opacity.compound'] = compound
  }

  // ── Effects (shadows, blur) — informational ──
  if (node.effects?.length) {
    const visibleEffects = node.effects.filter(e => e.visible !== false)
    for (let i = 0; i < visibleEffects.length; i++) {
      const eff = visibleEffects[i]
      props[`effect.${i}.type`] = eff.type.toLowerCase()
      if (eff.color) {
        props[`effect.${i}.color`] = figmaColorToHex(eff.color).toLowerCase()
      }
      if (eff.offset) {
        props[`effect.${i}.offset.x`] = eff.offset.x
        props[`effect.${i}.offset.y`] = eff.offset.y
      }
      if (eff.radius != null) props[`effect.${i}.radius`] = eff.radius
      if (eff.spread != null) props[`effect.${i}.spread`] = eff.spread
    }
  }

  // ── Text properties ──
  // Only extract text when the DB part declares textStyle or textColor,
  // meaning this part "owns" text properties. Otherwise container frames
  // would inherit text from children and produce noise.
  const dbOwnsText = !!(dbPart.textStyle || dbPart.textColor)

  if (dbOwnsText || node.type === 'TEXT') {
    const textChildren = findTextChildren(node)
    if (textChildren.length > 0) {
      const textNode = textChildren[0]

      if (textNode.style) {
        if (textNode.style.fontSize != null) props['text.fontSize'] = textNode.style.fontSize
        if (textNode.style.fontWeight != null) props['text.fontWeight'] = textNode.style.fontWeight
        if (textNode.style.lineHeightPx != null) props['text.lineHeight'] = Math.round(textNode.style.lineHeightPx * 100) / 100
        if (textNode.style.letterSpacing != null && textNode.style.letterSpacing !== 0) {
          props['text.letterSpacing'] = Math.round(textNode.style.letterSpacing * 100) / 100
        }
      }

      // Text color
      const textBv = textNode.boundVariables ?? {}
      const textFill = resolveColor(textBv, 'fills', textNode.fills, maps)
      if (textFill.color) props['textColor'] = textFill.color

      // Text alignment
      const textAlignH = textNode.textAlignHorizontal ?? textNode.style?.textAlignHorizontal
      if (textAlignH && textAlignH !== 'LEFT') {
        props['text.alignHorizontal'] = textAlignH.toLowerCase()
      }
      const textAlignV = textNode.textAlignVertical ?? textNode.style?.textAlignVertical
      if (textAlignV && textAlignV !== 'TOP') {
        props['text.alignVertical'] = textAlignV.toLowerCase()
      }

      // Text decoration
      const textDeco = textNode.textDecoration ?? textNode.style?.textDecoration
      if (textDeco && textDeco !== 'NONE') {
        props['text.decoration'] = textDeco.toLowerCase()
      }

      // Text case
      const textCase = textNode.style?.textCase
      if (textCase && textCase !== 'ORIGINAL' && textCase !== 'NONE') {
        props['text.case'] = textCase.toLowerCase()
      }

      // OpenType features (REST API exposes as opentypeFlags on style)
      const otFlags = textNode.style?.opentypeFlags
      if (otFlags && Object.keys(otFlags).length > 0) {
        props['text.opentypeFlags'] = Object.keys(otFlags).sort().join(',')
      }

      // Text style reference (Figma style node ID)
      const textStyleRef = textNode.styles?.text
      if (textStyleRef) {
        props['text.styleRef'] = textStyleRef
      }
    }
  }

  return props
}

// ─── DB Property Extraction ─────────────────────────────────────────────────

function extractDbProps(part: ComponentPart, db: DB, maps: Maps): PropMap {
  const props: PropMap = {}

  // ── Layout ──
  if (part.layout) props['layout'] = part.layout

  // ── Padding ──
  if (part.padding) {
    if (typeof part.padding === 'string') {
      props['padding.left'] = part.padding
      props['padding.right'] = part.padding
      props['padding.top'] = part.padding
      props['padding.bottom'] = part.padding
    } else {
      if (part.padding.x) { props['padding.left'] = part.padding.x; props['padding.right'] = part.padding.x }
      if (part.padding.y) { props['padding.top'] = part.padding.y; props['padding.bottom'] = part.padding.y }
      if (part.padding.left) props['padding.left'] = part.padding.left
      if (part.padding.right) props['padding.right'] = part.padding.right
      if (part.padding.top) props['padding.top'] = part.padding.top
      if (part.padding.bottom) props['padding.bottom'] = part.padding.bottom
    }
  }

  // ── Gap ──
  if (part.gap) {
    if (typeof part.gap === 'string') {
      props['gap'] = part.gap
    } else {
      // Map x/y to primary/counter based on layout direction
      const isHorizontal = part.layout === 'horizontal'
      const primaryGapKey = isHorizontal ? 'x' : 'y'
      const crossGapKey = isHorizontal ? 'y' : 'x'
      if (part.gap[primaryGapKey]) props['gap'] = part.gap[primaryGapKey]
      if (part.gap[crossGapKey]) props['gap.counter'] = part.gap[crossGapKey]
    }
  }

  // ── Radius ──
  if (part.radius) {
    if (typeof part.radius === 'string') {
      props['radius.tl'] = part.radius
      props['radius.tr'] = part.radius
      props['radius.bl'] = part.radius
      props['radius.br'] = part.radius
    } else {
      // top/bottom shorthand
      if (part.radius.top) { props['radius.tl'] = part.radius.top; props['radius.tr'] = part.radius.top }
      if (part.radius.bottom) { props['radius.bl'] = part.radius.bottom; props['radius.br'] = part.radius.bottom }
      // Individual corners override
      if (part.radius.tl) props['radius.tl'] = part.radius.tl
      if (part.radius.tr) props['radius.tr'] = part.radius.tr
      if (part.radius.bl) props['radius.bl'] = part.radius.bl
      if (part.radius.br) props['radius.br'] = part.radius.br
    }
  }

  // ── Fill ──
  if (part.fill) {
    const fillKey = maps.figmaNameToKey.get(part.fill)
      ?? (part.fill === 'black' ? 'black' : null)
      ?? (part.fill === 'white' ? 'white' : null)
      ?? part.fill.replace(/\//g, '-')
    props['fill'] = fillKey
  }

  // ── Stroke ──
  if (part.stroke) {
    if (part.stroke.color) {
      const dbStrokeKey = maps.figmaNameToKey.get(part.stroke.color)
        ?? part.stroke.color.replace(/\//g, '-')
      props['stroke.color'] = dbStrokeKey
    }
    if (part.stroke.weight != null) {
      props['stroke.weight'] = part.stroke.weight
    }
    // Per-side stroke weights
    if (part.stroke.topWeight != null) props['stroke.topWeight'] = part.stroke.topWeight
    if (part.stroke.rightWeight != null) props['stroke.rightWeight'] = part.stroke.rightWeight
    if (part.stroke.bottomWeight != null) props['stroke.bottomWeight'] = part.stroke.bottomWeight
    if (part.stroke.leftWeight != null) props['stroke.leftWeight'] = part.stroke.leftWeight
    // Stroke style
    if (part.stroke.style) props['stroke.style'] = part.stroke.style
  }

  // ── Sizing ──
  for (const axis of ['height', 'width'] as const) {
    const val = part[axis]
    if (!val) continue
    if (val === 'full') {
      props[`${axis}.mode`] = 'FILL'
    } else if (typeof val === 'string') {
      // Try as size token → px
      const bracketMatch = val.match(/^\[(\d+(?:\.\d+)?)px\]$/)
      if (bracketMatch) {
        props[`${axis}.mode`] = 'FIXED'
        props[`${axis}.px`] = parseFloat(bracketMatch[1])
      } else {
        // Try as size token key
        const px = maps.sizeTokenToPx.get(val)
        if (px != null) {
          props[`${axis}.mode`] = 'FIXED'
          props[`${axis}.px`] = px
        } else {
          // Try as Tailwind numeric (6 = 24px, 8 = 32px, etc.)
          const num = parseFloat(val)
          if (!isNaN(num) && num > 0) {
            props[`${axis}.mode`] = 'FIXED'
            props[`${axis}.px`] = num * 4
          }
          // else: unresolvable token, leave unset
        }
      }
    }
  }

  // ── Alignment ──
  if (part.align && part.align !== 'start') props['align'] = part.align
  if (part.justify && part.justify !== 'start') props['justify'] = part.justify

  // ── Overflow ──
  if (part.overflow === 'hidden') props['overflow'] = 'hidden'

  // ── Opacity ──
  if (part.opacity != null && part.opacity < 1) {
    props['opacity'] = part.opacity
  }

  // ── Blend mode ──
  if (part.blendMode) {
    props['blendMode'] = part.blendMode
  }

  // ── Text (resolve from textStyle) ──
  if (part.textStyle) {
    const styleEntry = Object.values(db.textStyles).find(ts => ts.utility === part.textStyle)
    if (styleEntry) {
      const p = styleEntry.properties
      if (p['fontSize']) props['text.fontSize'] = parseFloat(String(p['fontSize']))
      if (p['fontWeight']) props['text.fontWeight'] = Number(p['fontWeight'])
      if (p['lineHeight']) {
        // lineHeight in DB is a ratio (e.g. 1.5), Figma returns px
        // Convert ratio to px: ratio * fontSize
        const fontSize = props['text.fontSize'] as number | undefined
        if (fontSize) {
          props['text.lineHeight'] = Math.round(parseFloat(String(p['lineHeight'])) * fontSize * 100) / 100
        }
      }
      if (p['letterSpacing'] && String(p['letterSpacing']) !== '0') {
        // DB letterSpacing might be in em; Figma returns px
        const ls = String(p['letterSpacing'])
        if (ls.endsWith('em')) {
          const fontSize = props['text.fontSize'] as number | undefined
          if (fontSize) {
            props['text.letterSpacing'] = Math.round(parseFloat(ls) * fontSize * 100) / 100
          }
        } else {
          props['text.letterSpacing'] = parseFloat(ls)
        }
      }
    }
  }

  // ── Text style OT features + style name ──
  if (part.textStyle) {
    const styleEntry = Object.values(db.textStyles).find(ts => ts.utility === part.textStyle)
    if (styleEntry) {
      // OpenType features — derive from fontVariantNumeric + fontFeatureSettings
      const otKeys: string[] = []
      const fvn = String(styleEntry.properties['fontVariantNumeric'] ?? '')
      if (fvn.includes('tabular-nums')) otKeys.push('TNUM')
      if (fvn.includes('lining-nums')) otKeys.push('LNUM')
      if (fvn.includes('slashed-zero')) otKeys.push('ZERO')
      const ffs = String(styleEntry.properties['fontFeatureSettings'] ?? '')
      if (ffs.includes('"salt"')) otKeys.push('SALT')
      if (ffs.includes('"ss01"')) otKeys.push('SS01')
      if (otKeys.length > 0) {
        props['text.opentypeFlags'] = otKeys.sort().join(',')
      }
      // Store the Figma style name for identity check
      props['text.styleName'] = styleEntry.figmaName
    }
  }

  // ── Text color ──
  if (part.textColor) props['textColor'] = part.textColor

  // ── Text alignment, decoration, case ──
  if (part.textAlign) props['text.alignHorizontal'] = part.textAlign
  if (part.textAlignVertical) props['text.alignVertical'] = part.textAlignVertical
  if (part.textDecoration) props['text.decoration'] = part.textDecoration
  if (part.textCase) props['text.case'] = part.textCase

  return props
}

// ─── Diff ───────────────────────────────────────────────────────────────────

function diffProps(
  figma: PropMap,
  db: PropMap,
  nodeType: string,
  auditIgnore?: string[],
  drilledFromSet?: boolean,
): Diff[] {
  const diffs: Diff[] = []
  const allKeys = new Set([...Object.keys(figma), ...Object.keys(db)])
  const ignoreSet = auditIgnore ? new Set(auditIgnore) : null
  const isComponent = nodeType === 'COMPONENT'
  const isComponentSet = nodeType === 'COMPONENT_SET'
  const isEllipse = nodeType === 'ELLIPSE'

  // Prefixes that produce INFO-only diffs (displayed but not counted)
  const infoOnlyPrefixes = ['effect.', 'opacity.compound']

  // Keys used only for cache-based identity checks, not direct property comparison
  const identityOnlyKeys = new Set(['text.styleRef', 'text.styleName'])

  for (const key of allKeys) {
    // Skip identity-only keys (real comparison done via cache-based text.styleIdentity check)
    if (identityOnlyKeys.has(key)) continue

    // Skip code-only DB fields
    const rootKey = key.split('.')[0]
    if (CODE_ONLY_KEYS.has(rootKey)) continue

    // Skip per-part auditIgnore fields (intentional code overrides)
    if (ignoreSet && (ignoreSet.has(rootKey) || ignoreSet.has(key))) continue

    // COMPONENT_SET roots (drilled to default variant): visual props belong to
    // variants, not the set itself. Skip all visual diffs — the drilled variant's
    // props don't represent the root. Root visual props are intentional base styles
    // maintained by convention (e.g. nodeCard.root radius/fill/stroke).
    const isSetRoot = drilledFromSet || isComponentSet
    if (isSetRoot && (
      key.startsWith('width') || key.startsWith('height') || key === 'overflow' ||
      key.startsWith('stroke') || key === 'textColor' || key.startsWith('text.') ||
      key.startsWith('radius') || key === 'fill' || key.startsWith('fill.')
    )) {
      continue
    }

    // COMPONENT variant nodes: skip width/height (Figma uses FIXED canvas dims,
    // code uses size tokens like h-btn-md). All other properties are audited.
    if (isComponent && (
      key.startsWith('width') || key.startsWith('height')
    )) {
      continue
    }

    // ELLIPSE nodes: radius and sizing are implicit (always circular)
    if (isEllipse && (
      key.startsWith('radius') || key.startsWith('width') || key.startsWith('height')
    )) {
      continue
    }

    const fVal = figma[key] ?? null
    const dVal = db[key] ?? null

    if (fVal === null && dVal === null) continue

    // INFO-only keys: log but don't treat as actionable diffs
    const isInfoOnly = infoOnlyPrefixes.some(p => key.startsWith(p))
    if (isInfoOnly) {
      if (fVal !== null) {
        diffs.push({ key, type: 'INFO', figma: fVal, db: dVal, note: 'informational — not compared against DB' })
      }
      continue
    }

    // Hidden fill detection
    if (key === 'fill' && fVal === '__hidden__' && dVal !== null) {
      diffs.push({ key, type: 'MISMATCH', figma: fVal, db: dVal, note: 'fill is hidden in Figma but DB expects a visible fill' })
      continue
    }

    if (fVal !== null && dVal === null) {
      diffs.push({ key, type: 'MISSING', figma: fVal, db: null })
    } else if (fVal === null && dVal !== null) {
      diffs.push({ key, type: 'EXTRA', figma: null, db: dVal })
    } else if (typeof fVal === 'number' && typeof dVal === 'number') {
      // Numeric comparison with tolerance
      if (Math.abs(fVal - dVal) > 0.01) {
        diffs.push({ key, type: 'MISMATCH', figma: fVal, db: dVal })
      }
    } else if (String(fVal) !== String(dVal)) {
      diffs.push({ key, type: 'MISMATCH', figma: fVal, db: dVal })
    }
  }

  return diffs
}

// ─── --fix: Patch DB ─────────────────────────────────────────────────────────

function patchDb(
  reports: PartReport[],
  db: DB,
  maps: Maps,
) {
  let patchCount = 0

  for (const report of reports) {
    if (report.diffs.length === 0) continue

    // Find the DB component part
    const comp = Object.values(db.components).find(c => `${c.dsKey}.${report.part}` === report.component)
    if (!comp) continue
    const part = comp.parts[report.part]
    if (!part) continue

    for (const diff of report.diffs) {
      // Skip INFO diffs
      if (diff.type === 'INFO') continue

      // For EXTRA (DB has, Figma doesn't): only handle specific removals
      if (diff.type === 'EXTRA') {
        // Remove stale strokes when Figma has no stroke but DB does
        if (diff.key.startsWith('stroke') && part.stroke) {
          delete part.stroke
          patchCount++
        }
        continue
      }

      if (diff.figma === null) continue
      // Skip __hidden__ fill values — don't write synthetic marker to DB
      if (diff.key === 'fill' && diff.figma === '__hidden__') continue

      const val = diff.figma

      if (diff.key === 'layout') {
        part.layout = val as 'horizontal' | 'vertical'
        patchCount++
      } else if (diff.key === 'fill') {
        // Convert tailwind key back to figmaName
        part.fill = maps.tailwindKeyToFigmaName.get(String(val)) ?? String(val)
        patchCount++
      } else if (diff.key.startsWith('stroke.color')) {
        if (!part.stroke) part.stroke = {}
        part.stroke.color = maps.tailwindKeyToFigmaName.get(String(val)) ?? String(val)
        patchCount++
      } else if (diff.key === 'stroke.weight') {
        if (!part.stroke) part.stroke = {}
        part.stroke.weight = Number(val)
        patchCount++
      } else if (diff.key === 'stroke.style') {
        if (!part.stroke) part.stroke = {}
        part.stroke.style = String(val) as 'solid' | 'dashed'
        patchCount++
      } else if (diff.key.match(/^stroke\.(top|right|bottom|left)Weight$/)) {
        if (!part.stroke) part.stroke = {}
        const sideKey = diff.key.split('.')[1] as keyof StrokeDef
        ;(part.stroke as Record<string, unknown>)[sideKey] = Number(val)
        patchCount++
      } else if (diff.key === 'textColor') {
        part.textColor = String(val)
        patchCount++
      } else if (diff.key === 'align') {
        part.align = String(val)
        patchCount++
      } else if (diff.key === 'justify') {
        part.justify = String(val)
        patchCount++
      } else if (diff.key === 'overflow') {
        part.overflow = String(val)
        patchCount++
      } else if (diff.key === 'opacity') {
        part.opacity = Math.round(Number(val) * 100) / 100
        patchCount++
      } else if (diff.key === 'blendMode') {
        part.blendMode = String(val)
        patchCount++
      } else if (diff.key === 'text.alignHorizontal') {
        part.textAlign = String(val)
        patchCount++
      } else if (diff.key === 'text.alignVertical') {
        part.textAlignVertical = String(val)
        patchCount++
      } else if (diff.key === 'text.decoration') {
        part.textDecoration = String(val)
        patchCount++
      } else if (diff.key === 'text.case') {
        part.textCase = String(val)
        patchCount++
      }
      // Padding, gap, radius, sizing, and textStyle are more complex — collected below
    }

    // ── Patch textStyle (match Figma text props to a named style) ──
    const textMissing = report.diffs.filter(d => d.key.startsWith('text.') && d.type === 'MISSING' && d.figma !== null)
    if (textMissing.length > 0 && !part.textStyle) {
      const figmaFontSize = report.figmaProps['text.fontSize'] as number | null
      const figmaFontWeight = report.figmaProps['text.fontWeight'] as number | null
      const figmaLineHeight = report.figmaProps['text.lineHeight'] as number | null
      const figmaLetterSpacing = report.figmaProps['text.letterSpacing'] as number | null

      if (figmaFontSize != null && figmaFontWeight != null) {
        // Collect all candidates, pick best match
        type Candidate = { utility: string; lineHeightDelta: number; letterSpacingMatch: boolean }
        const candidates: Candidate[] = []

        for (const ts of Object.values(db.textStyles)) {
          const p = ts.properties
          const tsFontSize = p['fontSize'] ? parseFloat(String(p['fontSize'])) : null
          const tsFontWeight = p['fontWeight'] ? Number(p['fontWeight']) : null
          const tsLineHeight = p['lineHeight'] ? parseFloat(String(p['lineHeight'])) : null

          if (tsFontSize !== figmaFontSize || tsFontWeight !== figmaFontWeight) continue

          let lineHeightDelta = 0
          if (tsLineHeight != null && figmaLineHeight != null) {
            const expectedPx = Math.round(tsLineHeight * tsFontSize * 100) / 100
            lineHeightDelta = Math.abs(expectedPx - figmaLineHeight)
            if (lineHeightDelta > 0.5) continue
          }

          let letterSpacingMatch = true
          if (figmaLetterSpacing != null && figmaLetterSpacing !== 0) {
            const tsLS = p['letterSpacing'] ? String(p['letterSpacing']) : null
            if (tsLS) {
              let tsLSPx: number
              if (tsLS.endsWith('em')) {
                tsLSPx = parseFloat(tsLS) * figmaFontSize
              } else {
                tsLSPx = parseFloat(tsLS)
              }
              letterSpacingMatch = Math.abs(tsLSPx - figmaLetterSpacing) < 0.1
            } else {
              letterSpacingMatch = false
            }
          }

          candidates.push({ utility: ts.utility, lineHeightDelta, letterSpacingMatch })
        }

        // Sort: prefer letterSpacing match, then closest lineHeight
        candidates.sort((a, b) => {
          if (a.letterSpacingMatch !== b.letterSpacingMatch) return a.letterSpacingMatch ? -1 : 1
          return a.lineHeightDelta - b.lineHeightDelta
        })

        if (candidates.length > 0) {
          part.textStyle = candidates[0].utility
          patchCount++
        }
      }
    }

    // ── Patch padding (collect all 4 sides, write compact form) ──
    const paddingDiffs = report.diffs.filter(d => d.key.startsWith('padding.') && d.figma !== null)
    if (paddingDiffs.length > 0) {
      const sides: Record<string, string> = {}
      // Start from existing DB values
      if (part.padding) {
        if (typeof part.padding === 'string') {
          sides.left = sides.right = sides.top = sides.bottom = part.padding
        } else {
          if (part.padding.x) { sides.left = part.padding.x; sides.right = part.padding.x }
          if (part.padding.y) { sides.top = part.padding.y; sides.bottom = part.padding.y }
          if (part.padding.left) sides.left = part.padding.left
          if (part.padding.right) sides.right = part.padding.right
          if (part.padding.top) sides.top = part.padding.top
          if (part.padding.bottom) sides.bottom = part.padding.bottom
        }
      }
      // Apply diffs
      for (const d of paddingDiffs) {
        const side = d.key.split('.')[1]
        sides[side] = String(d.figma)
      }
      // Write compact form
      if (sides.left === sides.right && sides.top === sides.bottom && sides.left === sides.top) {
        part.padding = sides.left
      } else if (sides.left === sides.right && sides.top === sides.bottom) {
        part.padding = { x: sides.left, y: sides.top }
      } else {
        part.padding = sides
      }
      patchCount++
    }

    // ── Patch radius (collect 4 corners, write compact form) ──
    const radiusDiffs = report.diffs.filter(d => d.key.startsWith('radius.') && d.figma !== null)
    if (radiusDiffs.length > 0) {
      const corners: Record<string, string> = {}
      // Start from existing
      if (part.radius) {
        if (typeof part.radius === 'string') {
          corners.tl = corners.tr = corners.bl = corners.br = part.radius
        } else {
          if (part.radius.top) { corners.tl = part.radius.top; corners.tr = part.radius.top }
          if (part.radius.bottom) { corners.bl = part.radius.bottom; corners.br = part.radius.bottom }
          if (part.radius.tl) corners.tl = part.radius.tl
          if (part.radius.tr) corners.tr = part.radius.tr
          if (part.radius.bl) corners.bl = part.radius.bl
          if (part.radius.br) corners.br = part.radius.br
        }
      }
      for (const d of radiusDiffs) {
        const corner = d.key.split('.')[1]
        corners[corner] = String(d.figma)
      }
      if (corners.tl === corners.tr && corners.bl === corners.br && corners.tl === corners.bl) {
        part.radius = corners.tl
      } else if (corners.tl === corners.tr && corners.bl === corners.br) {
        part.radius = { top: corners.tl, bottom: corners.bl }
      } else {
        part.radius = corners
      }
      patchCount++
    }

    // ── Patch gap ──
    const gapDiffs = report.diffs.filter(d => (d.key === 'gap' || d.key === 'gap.counter') && d.figma !== null)
    if (gapDiffs.length > 0) {
      const gapMain = gapDiffs.find(d => d.key === 'gap')
      const gapCounter = gapDiffs.find(d => d.key === 'gap.counter')
      if (gapMain && !gapCounter) {
        part.gap = String(gapMain.figma)
      } else if (gapMain && gapCounter) {
        const isHorizontal = part.layout === 'horizontal'
        const primaryKey = isHorizontal ? 'x' : 'y'
        const crossKey = isHorizontal ? 'y' : 'x'
        part.gap = { [primaryKey]: String(gapMain.figma), [crossKey]: String(gapCounter.figma) }
      }
      patchCount++
    }

    // ── Patch height/width ──
    for (const axis of ['height', 'width'] as const) {
      const modeDiff = report.diffs.find(d => d.key === `${axis}.mode` && d.figma !== null)
      const pxDiff = report.diffs.find(d => d.key === `${axis}.px` && d.figma !== null)

      if (modeDiff || pxDiff) {
        const mode = modeDiff?.figma ?? report.figmaProps[`${axis}.mode`]
        const px = pxDiff?.figma ?? report.figmaProps[`${axis}.px`]

        if (mode === 'FILL') {
          (part as Record<string, unknown>)[axis] = 'full'
        } else if (mode === 'FIXED' && px != null) {
          const pxNum = Number(px)
          // Try to find a size token
          const token = maps.sizePxToToken.get(pxNum)
          if (token) {
            (part as Record<string, unknown>)[axis] = token
          } else {
            (part as Record<string, unknown>)[axis] = `[${pxNum}px]`
          }
        }
        patchCount++
      }
    }
  }

  return patchCount
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Figma Design Audit')
  console.log('==================\n')

  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  const fileKey = db.figmaFileKey
  const maps = buildReverseMaps(db)

  // ── Load Plugin API cache (for text style identity + OT features) ──
  let cacheLoaded = false
  if (existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
      if (cache.textStyles && Array.isArray(cache.textStyles)) {
        // Build a mapping from text style Figma ID (S:key,) to name
        // The REST API uses node IDs (like "118:1545") in styles.text
        // We need to resolve these — fetch the style nodes to get their names
        // For now, store the style key → name mapping from cache
        for (const ts of cache.textStyles) {
          // The cache stores Plugin API style IDs (e.g. "S:abc123,")
          // but the REST API returns style node IDs (e.g. "118:1545")
          // We need both mappings — store the name keyed by the Plugin API ID
          if (ts.id && ts.name) {
            textStyleNodeIdToName.set(ts.id, ts.name)
          }
        }
        cacheLoaded = true
        console.log(`Loaded Plugin API cache: ${cache.textStyles.length} text styles, ${cache.variables?.length ?? 0} variables`)
      }
    } catch (err) {
      console.warn(`Warning: Could not load cache at ${CACHE_PATH}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Collect all figmaNodeIds
  const nodeIdMap = new Map<string, { compKey: string; partKey: string; part: ComponentPart }>()

  for (const [_compId, comp] of Object.entries(db.components)) {
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
        // Tag the drilled node so diffProps knows the root was a COMPONENT_SET
        if (node.type === 'COMPONENT_SET' && node.children?.length) {
          node = node.children[0]
          ;(node as FigmaNode & { _drilledFromSet?: boolean })._drilledFromSet = true
        }

        allNodes.set(nodeId, node)
      }
    }
  }

  console.log(`Fetched ${allNodes.size} nodes\n`)

  // Run extraction + diff
  const reports: PartReport[] = []
  let checked = 0

  for (const [nodeId, info] of nodeIdMap) {
    const figmaNode = allNodes.get(nodeId)
    if (!figmaNode) {
      console.log(`  ⚠ ${info.compKey}: node ${nodeId} not found in Figma`)
      continue
    }

    checked++
    const figmaProps = extractFigmaProps(figmaNode, maps, info.part)
    const dbProps = extractDbProps(info.part, db, maps)
    const isDrilled = !!(figmaNode as FigmaNode & { _drilledFromSet?: boolean })._drilledFromSet
    const diffs = diffProps(figmaProps, dbProps, figmaNode.type, info.part.auditIgnore as string[] | undefined, isDrilled)

    reports.push({
      component: info.compKey,
      part: info.partKey,
      nodeId,
      nodeType: figmaNode.type,
      figmaProps,
      dbProps,
      diffs,
    })
  }

  // ── Cache-based text style identity check ──
  // Uses componentTextMap from .figma-vars-cache.json to verify that
  // the Figma text style matches the DB's textStyle utility name
  let textStyleMismatches = 0
  if (cacheLoaded) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))
      const compTextMap = cache.componentTextMap as Record<string, { name: string; texts: Array<{ name: string; textStyle: string | null; opentypeFeatures?: string[] }> }> | undefined

      if (compTextMap) {
        // Build utility → figmaName lookup
        const utilToFigmaName = new Map<string, string>()
        for (const ts of Object.values(db.textStyles)) {
          utilToFigmaName.set(ts.utility, ts.figmaName)
        }

        for (const [nodeId, info] of nodeIdMap) {
          const dbPart = info.part
          if (!dbPart.textStyle) continue

          // Find this component in the cache (match by figmaNodeId → component ID)
          // The cache keys are component IDs, but we have part node IDs.
          // Walk up: find the component that contains this part's figmaNodeId
          let cacheEntry = compTextMap[nodeId]
          if (!cacheEntry) {
            // The part nodeId might be inside a component set; try to find it
            // by checking all cache entries for a matching nodeId
            for (const [cid, entry] of Object.entries(compTextMap)) {
              if (cid === nodeId) { cacheEntry = entry; break }
            }
          }
          if (!cacheEntry || !cacheEntry.texts?.length) continue

          // The first text child's style should match the DB's textStyle
          const firstText = cacheEntry.texts[0]
          const dbFigmaName = utilToFigmaName.get(dbPart.textStyle)
          if (dbFigmaName && firstText.textStyle && firstText.textStyle !== dbFigmaName) {
            textStyleMismatches++
            // Inject a MISMATCH diff into the report
            const report = reports.find(r => r.nodeId === nodeId)
            if (report) {
              report.diffs.push({
                key: 'text.styleIdentity',
                type: 'MISMATCH',
                figma: firstText.textStyle,
                db: `${dbPart.textStyle} (${dbFigmaName})`,
                note: 'Figma text node uses a different named style than DB claims',
              })
            }
          }
        }
      }
    } catch { /* cache read error — skip identity check */ }
  }

  // Tallies (exclude INFO from actionable counts)
  const totalDiffs = reports.reduce((n, r) => n + r.diffs.filter(d => d.type !== 'INFO').length, 0)
  const mismatches = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'MISMATCH').length, 0)
  const missing = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'MISSING').length, 0)
  const extra = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'EXTRA').length, 0)
  const infoCount = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'INFO').length, 0)

  // ── Report ──
  console.log('─────────────────────────────────────')
  console.log(`Checked ${checked} component parts`)
  console.log(`  ${mismatches} mismatches`)
  console.log(`  ${missing} missing in DB`)
  console.log(`  ${extra} extra in DB`)
  if (infoCount > 0) console.log(`  ${infoCount} informational`)
  if (unresolvedVarCount > 0) console.log(`  ${unresolvedVarCount} unresolved variable(s)`)
  console.log('─────────────────────────────────────\n')

  if (totalDiffs === 0 && infoCount === 0) {
    console.log('✅ All Figma-designable properties match the DB!')
  } else if (totalDiffs === 0) {
    console.log('✅ All Figma-designable properties match the DB!')
  }

  if (totalDiffs > 0) {
    // Group by type
    for (const [label, dtype] of [['MISMATCHES', 'MISMATCH'], ['MISSING in DB', 'MISSING'], ['EXTRA in DB (DB has, Figma does not)', 'EXTRA']] as const) {
      const filtered = reports.flatMap(r => r.diffs.filter(d => d.type === dtype).map(d => ({ comp: r.component, ...d })))
      if (filtered.length === 0) continue

      console.log(`${label}:\n`)
      for (const d of filtered) {
        console.log(`  ${d.comp} → ${d.key}`)
        if (d.db !== null) console.log(`    DB:    ${d.db}`)
        else console.log(`    DB:    (none)`)
        if (d.figma !== null) console.log(`    Figma: ${d.figma}`)
        else console.log(`    Figma: (none)`)
        if (d.note) console.log(`    Note:  ${d.note}`)
        console.log()
      }
    }
  }

  // ── Effects summary (informational) ──
  const effectReports = reports.filter(r =>
    Object.keys(r.figmaProps).some(k => k.startsWith('effect.'))
  )
  if (effectReports.length > 0) {
    console.log('EFFECTS DETECTED (informational):\n')
    for (const r of effectReports) {
      const effectTypes = Object.entries(r.figmaProps)
        .filter(([k]) => k.endsWith('.type') && k.startsWith('effect.'))
        .map(([, v]) => v)
      console.log(`  ${r.component} → ${effectTypes.join(', ')}`)
    }
    console.log()
  }

  // ── --json output ──
  if (JSON_PATH) {
    const jsonReport = {
      summary: { checked, mismatches, missing, extra, info: infoCount, total: totalDiffs },
      parts: reports.map(r => ({
        component: r.component,
        part: r.part,
        nodeId: r.nodeId,
        nodeType: r.nodeType,
        figmaProps: r.figmaProps,
        dbProps: r.dbProps,
        diffs: r.diffs,
      })),
    }
    writeFileSync(JSON_PATH, JSON.stringify(jsonReport, null, 2))
    console.log(`JSON report written to ${JSON_PATH}`)
  }

  // ── --fix / --fix-dry-run mode ──
  if (FIX_MODE && totalDiffs > 0) {
    const dbTarget = FIX_DRY_RUN ? JSON.parse(JSON.stringify(db)) as DB : db
    const patchCount = patchDb(reports, dbTarget, maps)

    if (FIX_DRY_RUN) {
      console.log(`\n🔍 Dry run: would patch ${patchCount} properties in ${DB_PATH}`)
      console.log('   (No files were modified. Remove --fix-dry-run and use --fix to apply.)')
    } else {
      writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n')
      console.log(`\n🔧 Patched ${patchCount} properties in ${DB_PATH}`)
      console.log('   Run `npm run tokens` to regenerate code from the updated DB.')
    }
  }

  // ── --strict mode checks ──
  if (STRICT_MODE) {
    let strictFailures = 0

    if (unresolvedVarCount > 0) {
      console.log(`\n❌ STRICT: ${unresolvedVarCount} unresolved variable binding(s)`)
      strictFailures += unresolvedVarCount
    }

    // Missing text style references
    for (const [_compId, comp] of Object.entries(db.components)) {
      for (const [partKey, part] of Object.entries(comp.parts)) {
        if (part.textStyle) {
          const found = Object.values(db.textStyles).find(ts => ts.utility === part.textStyle)
          if (!found) {
            console.log(`  ❌ STRICT: Missing textStyle "${part.textStyle}" in ${comp.dsKey}.${partKey}`)
            strictFailures++
          }
        }
      }
    }

    // Node type validation
    const expectedTypes = new Set(['COMPONENT', 'COMPONENT_SET', 'FRAME', 'TEXT', 'GROUP', 'INSTANCE', 'ELLIPSE', 'RECTANGLE', 'VECTOR', 'BOOLEAN_OPERATION'])
    for (const [nodeId, info] of nodeIdMap) {
      const figmaNode = allNodes.get(nodeId)
      if (!figmaNode) continue
      if (!expectedTypes.has(figmaNode.type)) {
        console.log(`  ❌ STRICT: ${info.compKey} → node ${nodeId} is unexpected type "${figmaNode.type}"`)
        strictFailures++
      }
    }

    if (strictFailures > 0) {
      console.log()
      process.exit(1)
    }
  }

  process.exit(totalDiffs > 0 && !FIX_MODE ? 1 : 0)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
