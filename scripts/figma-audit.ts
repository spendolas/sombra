/**
 * figma-audit.ts — Figma-first comprehensive visual audit.
 *
 * Extracts EVERY visual property from each Figma component part node,
 * then compares against sombra.ds.json. No early returns, no skipping.
 *
 * Properties checked: layout, padding (4 sides), gap, radius (4 corners),
 * fill + opacity, stroke color + weight, sizing modes + dimensions,
 * alignment, overflow, opacity, text style (fontSize, fontWeight,
 * lineHeight, letterSpacing), text color.
 *
 * Requires FIGMA_TOKEN env var.
 *
 * Usage:
 *   npx tsx scripts/figma-audit.ts              # report diffs
 *   npx tsx scripts/figma-audit.ts --json out   # write JSON report to file
 *   npx tsx scripts/figma-audit.ts --fix        # auto-patch DB from Figma
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

const FIX_MODE = process.argv.includes('--fix')
const JSON_IDX = process.argv.indexOf('--json')
const JSON_PATH = JSON_IDX !== -1 ? process.argv[JSON_IDX + 1] : null

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
  strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; visible?: boolean }>
  strokeWeight?: number
  strokeTopWeight?: number
  strokeBottomWeight?: number
  strokeLeftWeight?: number
  strokeRightWeight?: number
  strokeAlign?: 'INSIDE' | 'CENTER' | 'OUTSIDE'
  // Sizing
  layoutSizingVertical?: 'FIXED' | 'HUG' | 'FILL'
  layoutSizingHorizontal?: 'FIXED' | 'HUG' | 'FILL'
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number }
  // Clipping
  clipsContent?: boolean
  // Node-level opacity
  opacity?: number
  // Effects
  effects?: Array<{
    type: string; visible?: boolean; radius?: number
    color?: { r: number; g: number; b: number; a: number }
    offset?: { x: number; y: number }; spread?: number
  }>
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

type PropMap = Record<string, string | number | null>

interface Diff {
  key: string
  type: 'MISMATCH' | 'MISSING' | 'EXTRA'
  figma: string | number | null
  db: string | number | null
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
  return varToKey.get(bv.id) ?? null
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
  return varToKey.get(bv.id) ?? null
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

function resolveColor(
  bv: Record<string, BoundVariable | BoundVariable[]>,
  paintField: string,
  paints: Array<{ type: string; color?: { r: number; g: number; b: number; a: number }; opacity?: number; visible?: boolean }> | undefined,
  maps: Maps,
): { color: string | null; opacity: number | null } {
  // Try bound variable first
  let colorKey = resolvePaintBoundVar(bv, paintField, maps.colorVarToKey)

  let paintOpacity: number | null = null

  if (!colorKey && paints?.length) {
    const paint = paints.find(p => p.visible !== false && p.type === 'SOLID' && p.color)
    if (paint?.color) {
      const hex = figmaColorToHex(paint.color).toLowerCase()
      colorKey = maps.colorHexToKey.get(hex) ?? hex
      if (paint.opacity != null && paint.opacity < 1) {
        paintOpacity = Math.round(paint.opacity * 100) / 100
      }
    }
  }

  return { color: colorKey ?? null, opacity: paintOpacity }
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
  const cornerFields = [
    ['topLeftRadius', 'radius.tl', node.topLeftRadius ?? node.cornerRadius],
    ['topRightRadius', 'radius.tr', node.topRightRadius ?? node.cornerRadius],
    ['bottomLeftRadius', 'radius.bl', node.bottomLeftRadius ?? node.cornerRadius],
    ['bottomRightRadius', 'radius.br', node.bottomRightRadius ?? node.cornerRadius],
  ] as const
  for (const [figmaField, propKey, rawVal] of cornerFields) {
    const resolved = resolveRadius(bv, figmaField, rawVal, maps)
    if (resolved) props[propKey] = resolved
  }

  // ── Fill ──
  // For TEXT nodes, fills represent the text color, not a background fill.
  // Text color is handled separately via findTextChildren() below.
  if (node.type !== 'TEXT') {
    const fill = resolveColor(bv, 'fills', node.fills, maps)
    if (fill.color) props['fill'] = fill.color
    if (fill.opacity != null) props['fill.opacity'] = fill.opacity
  }

  // ── Stroke ──
  const stroke = resolveColor(bv, 'strokes', node.strokes, maps)
  if (stroke.color) {
    props['stroke.color'] = stroke.color
    const weight = node.strokeWeight ?? 0
    if (weight > 0) props['stroke.weight'] = weight
    if (stroke.opacity != null) props['stroke.opacity'] = stroke.opacity
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
      const p = part.padding
      if (p.x) { props['padding.left'] = p.x; props['padding.right'] = p.x }
      if (p.y) { props['padding.top'] = p.y; props['padding.bottom'] = p.y }
      if (p.left) props['padding.left'] = p.left
      if (p.right) props['padding.right'] = p.right
      if (p.top) props['padding.top'] = p.top
      if (p.bottom) props['padding.bottom'] = p.bottom
    }
  }

  // ── Gap ──
  if (part.gap) {
    if (typeof part.gap === 'string') {
      props['gap'] = part.gap
    } else {
      // DB uses x/y; Figma uses itemSpacing (primary) / counterAxisSpacing (cross)
      // Map based on layout direction
      const isHorizontal = part.layout === 'horizontal'
      const primaryKey = isHorizontal ? 'x' : 'y'
      const crossKey = isHorizontal ? 'y' : 'x'
      if (part.gap[primaryKey]) props['gap'] = part.gap[primaryKey]
      if (part.gap[crossKey]) props['gap.counter'] = part.gap[crossKey]
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
      const r = part.radius
      // Support top/bottom shorthand and individual corners
      if (r.top) { props['radius.tl'] = r.top; props['radius.tr'] = r.top }
      if (r.bottom) { props['radius.bl'] = r.bottom; props['radius.br'] = r.bottom }
      if (r.tl) props['radius.tl'] = r.tl
      if (r.tr) props['radius.tr'] = r.tr
      if (r.bl) props['radius.bl'] = r.bl
      if (r.br) props['radius.br'] = r.br
    }
  }

  // ── Fill ──
  if (part.fill) {
    const CSS_COLORS: Record<string, string> = { black: '#000000', white: '#ffffff' }
    const dbFillKey = maps.figmaNameToKey.get(part.fill)
      ?? CSS_COLORS[part.fill]
      ?? part.fill.replace(/\//g, '-')
    props['fill'] = dbFillKey
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
  }

  // ── Sizing ──
  for (const axis of ['height', 'width'] as const) {
    const dbValue = part[axis] as string | undefined
    if (!dbValue) continue

    if (dbValue === 'full') {
      props[`${axis}.mode`] = 'FILL'
    } else {
      // Parse "[32px]" bracket notation
      const bracketMatch = dbValue.match(/^\[(\d+(?:\.\d+)?)px\]$/)
      if (bracketMatch) {
        props[`${axis}.mode`] = 'FIXED'
        props[`${axis}.px`] = parseFloat(bracketMatch[1])
      } else {
        // Try resolving as size token
        const tokenPx = maps.sizeTokenToPx.get(dbValue)
        if (tokenPx != null) {
          props[`${axis}.mode`] = 'FIXED'
          props[`${axis}.px`] = tokenPx
        } else {
          // Tailwind numeric (e.g. "6" → 24px)
          const twNum = parseFloat(dbValue)
          if (!isNaN(twNum) && String(twNum) === dbValue) {
            props[`${axis}.mode`] = 'FIXED'
            props[`${axis}.px`] = twNum * 4
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

  // ── Text color ──
  if (part.textColor) props['textColor'] = part.textColor

  return props
}

// ─── Diff ────────────────────────────────────────────────────────────────────

function diffProps(
  figma: PropMap,
  db: PropMap,
  isTopLevelComponent: boolean,
  auditIgnore?: string[],
): Diff[] {
  const diffs: Diff[] = []
  const allKeys = new Set([...Object.keys(figma), ...Object.keys(db)])
  const ignoreSet = auditIgnore ? new Set(auditIgnore) : null

  for (const key of allKeys) {
    // Skip code-only DB fields
    const rootKey = key.split('.')[0]
    if (CODE_ONLY_KEYS.has(rootKey)) continue

    // Skip per-part auditIgnore fields (intentional code overrides)
    if (ignoreSet && (ignoreSet.has(rootKey) || ignoreSet.has(key))) continue

    // COMPONENT nodes: skip sizing (arbitrary canvas dims) and overflow
    // (Figma auto-sets clipsContent on master components of component sets)
    if (isTopLevelComponent && (key.startsWith('width') || key.startsWith('height') || key === 'overflow')) {
      continue
    }

    const fVal = figma[key] ?? null
    const dVal = db[key] ?? null

    if (fVal === null && dVal === null) continue

    if (fVal !== null && dVal === null) {
      diffs.push({ key, type: 'MISSING', figma: fVal, db: null })
    } else if (fVal === null && dVal !== null) {
      diffs.push({ key, type: 'EXTRA', figma: null, db: dVal })
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
      if (diff.type === 'EXTRA') continue // Don't remove DB-only fields
      if (diff.figma === null) continue

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
        part.opacity = Number(val)
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

      if (figmaFontSize != null && figmaFontWeight != null) {
        // Find a matching textStyle
        for (const ts of Object.values(db.textStyles)) {
          const p = ts.properties
          const tsFontSize = p['fontSize'] ? parseFloat(String(p['fontSize'])) : null
          const tsFontWeight = p['fontWeight'] ? Number(p['fontWeight']) : null
          const tsLineHeight = p['lineHeight'] ? parseFloat(String(p['lineHeight'])) : null

          if (tsFontSize === figmaFontSize && tsFontWeight === figmaFontWeight) {
            // Check line-height (ratio × fontSize should match Figma px)
            if (tsLineHeight != null && figmaLineHeight != null) {
              const expectedPx = Math.round(tsLineHeight * tsFontSize * 100) / 100
              if (Math.abs(expectedPx - figmaLineHeight) > 0.5) continue
            }
            part.textStyle = ts.utility
            patchCount++
            break
          }
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
        if (node.type === 'COMPONENT_SET' && node.children?.length) {
          node = node.children[0]
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
    const diffs = diffProps(figmaProps, dbProps, figmaNode.type === 'COMPONENT', info.part.auditIgnore as string[] | undefined)

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

  // Tallies
  const totalDiffs = reports.reduce((n, r) => n + r.diffs.length, 0)
  const mismatches = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'MISMATCH').length, 0)
  const missing = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'MISSING').length, 0)
  const extra = reports.reduce((n, r) => n + r.diffs.filter(d => d.type === 'EXTRA').length, 0)

  // ── Report ──
  console.log('─────────────────────────────────────')
  console.log(`Checked ${checked} component parts`)
  console.log(`  ${mismatches} mismatches`)
  console.log(`  ${missing} missing in DB`)
  console.log(`  ${extra} extra in DB`)
  console.log('─────────────────────────────────────\n')

  if (totalDiffs === 0) {
    console.log('✅ All Figma-designable properties match the DB!')
  } else {
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
        console.log()
      }
    }
  }

  // ── --json output ──
  if (JSON_PATH) {
    const jsonReport = {
      summary: { checked, mismatches, missing, extra, total: totalDiffs },
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

  // ── --fix mode ──
  if (FIX_MODE && totalDiffs > 0) {
    const patchCount = patchDb(reports, db, maps)
    writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n')
    console.log(`\n🔧 Patched ${patchCount} properties in ${DB_PATH}`)
    console.log('   Run `npm run tokens` to regenerate code from the updated DB.')
  }

  process.exit(totalDiffs > 0 && !FIX_MODE ? 1 : 0)
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
