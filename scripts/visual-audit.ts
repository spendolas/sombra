/**
 * visual-audit.ts — Property-level DB vs browser computed style comparison.
 *
 * Phase 1: Token verification — CSS variables on :root match DB values.
 * Phase 2: Component verification — computed styles on /ds-preview elements
 *          match DB component part expectations.
 *
 * Outputs: artifacts/visual-audit/report.md
 *
 * Prereqs:
 *   - Dev server running (npm run dev)
 *   - System Chrome installed (playwright-core uses channel: 'chrome')
 *
 * Usage:
 *   npm run audit:visual
 *   DEV_PORT=5174 npm run audit:visual   # custom port
 */

import { chromium, type Page } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')
const REPORT_DIR = resolve(ROOT, 'artifacts/visual-audit')
const REPORT_PATH = resolve(REPORT_DIR, 'report.md')
const DEV_PORT = process.env.DEV_PORT || '5173'
const BASE_URL = `http://localhost:${DEV_PORT}/sombra/ds-preview.html`

// ─── Types ───────────────────────────────────────────────────────────────────

interface DBColor {
  figmaName: string
  cssVar: string
  value: string
  tailwind: { namespace: string; key: string }
}

interface DBSpacing {
  figmaName: string
  cssVar: string
  value: number
  unit: string
  tailwind: { namespace: string; key: string }
}

interface DBRadius {
  figmaName: string
  value: number
  unit: string
  tailwind: { namespace: string; key: string }
}

interface DBSize {
  figmaName: string
  cssVar: string
  value: number
  unit: string
  tailwind: Array<{ namespace: string; key: string }>
}

interface DBTextStyle {
  figmaName: string
  utility: string
  properties: Record<string, string | number>
}

interface StrokeDef {
  color?: string
  weight?: number
  side?: string
}

interface ComponentPart {
  figmaNodeId: string | null
  fill?: string
  stroke?: StrokeDef
  radius?: string | Record<string, string>
  padding?: string | Record<string, string>
  gap?: string | Record<string, string>
  textStyle?: string
  textColor?: string
  opacity?: number
  layout?: string
  effects?: Array<{ type: string; class: string }>
  [key: string]: unknown
}

interface ComponentEntry {
  name: string
  dsKey: string
  parts: Record<string, ComponentPart>
}

interface DB {
  colors: Record<string, DBColor>
  spacing: Record<string, DBSpacing>
  radius: Record<string, DBRadius>
  sizes: Record<string, DBSize>
  textStyles: Record<string, DBTextStyle>
  components: Record<string, ComponentEntry>
  computed?: Record<string, unknown>
}

// ─── Result Types ────────────────────────────────────────────────────────────

interface TokenResult {
  category: 'color' | 'spacing' | 'radius' | 'size'
  name: string
  cssVar: string
  expected: string
  actual: string
  match: boolean
}

interface PropertyComparison {
  property: string
  expected: string
  actual: string
  match: boolean
}

interface ComponentResult {
  dsComponent: string
  dsVariant: string
  found: boolean
  comparisons: PropertyComparison[]
}

// ─── Value Maps ──────────────────────────────────────────────────────────────

function buildMaps(db: DB) {
  // figmaName → hex for colors
  const colorFigmaNameToHex = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    colorFigmaNameToHex.set(entry.figmaName, entry.value)
  }

  // tailwind key → hex for colors
  const colorKeyToHex = new Map<string, string>()
  for (const entry of Object.values(db.colors)) {
    colorKeyToHex.set(entry.tailwind.key, entry.value)
  }

  // spacing token key → px
  const spacingKeyToPx = new Map<string, number>()
  for (const entry of Object.values(db.spacing)) {
    spacingKeyToPx.set(entry.tailwind.key, entry.value)
  }

  // radius token key → px
  const radiusKeyToPx = new Map<string, number>()
  for (const entry of Object.values(db.radius)) {
    radiusKeyToPx.set(entry.tailwind.key, entry.value)
  }

  // size token key → px
  const sizeKeyToPx = new Map<string, number>()
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      sizeKeyToPx.set(tw.key, entry.value)
    }
  }

  return { colorFigmaNameToHex, colorKeyToHex, spacingKeyToPx, radiusKeyToPx, sizeKeyToPx }
}

type Maps = ReturnType<typeof buildMaps>

// ─── Color Resolution ────────────────────────────────────────────────────────

/** Resolve a fill/textColor value from DB to hex. Handles figmaName and tailwind key formats. */
function resolveColorHex(value: string, maps: Maps): string | null {
  // Direct figmaName lookup (e.g. "surface/raised")
  const byFigmaName = maps.colorFigmaNameToHex.get(value)
  if (byFigmaName) return byFigmaName

  // Direct tailwind key lookup (e.g. "surface-raised", "fg-dim")
  const byKey = maps.colorKeyToHex.get(value)
  if (byKey) return byKey

  // Convert figmaName slash to dash and try key (e.g. "surface/raised" → "surface-raised")
  const dashKey = value.replace(/\//g, '-')
  const byDash = maps.colorKeyToHex.get(dashKey)
  if (byDash) return byDash

  // Hardcoded CSS colors
  if (value === 'black') return '#000000'
  if (value === 'white') return '#ffffff'

  return null
}

function hexToRgb(hex: string): string | null {
  hex = hex.replace('#', '')
  if (hex.length !== 6) return null
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgb(${r}, ${g}, ${b})`
}

/** Normalize a color string for comparison. */
function normalizeColor(value: string): string {
  if (value.startsWith('#')) return hexToRgb(value) ?? value
  // Normalize rgba(r, g, b, 1) → rgb(r, g, b)
  const rgbaFull = value.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*1\)/)
  if (rgbaFull) return `rgb(${rgbaFull[1]}, ${rgbaFull[2]}, ${rgbaFull[3]})`
  return value
}

// ─── Expected CSS from DB Part ───────────────────────────────────────────────

interface ExpectedCSS {
  [property: string]: string
}

function computeExpectedCSS(part: ComponentPart, db: DB, maps: Maps): ExpectedCSS {
  const expected: ExpectedCSS = {}

  // Fill → background-color
  if (part.fill) {
    const hex = resolveColorHex(part.fill, maps)
    if (hex) expected['background-color'] = hex
  }

  // Stroke → border-color, border-width
  if (part.stroke) {
    if (part.stroke.color) {
      const hex = resolveColorHex(part.stroke.color, maps)
      if (hex) expected['border-color'] = hex
    }
    if (part.stroke.weight != null) {
      expected['border-width'] = `${part.stroke.weight}px`
    }
  }

  // Radius → border-*-radius
  if (part.radius) {
    if (typeof part.radius === 'string') {
      const px = maps.radiusKeyToPx.get(part.radius)
      if (px != null) {
        const v = px >= 9999 ? '9999px' : `${px}px`
        expected['border-top-left-radius'] = v
        expected['border-top-right-radius'] = v
        expected['border-bottom-left-radius'] = v
        expected['border-bottom-right-radius'] = v
      }
    } else {
      // Per-corner: handle top/bottom shorthand and individual corners
      const corners: Record<string, string | undefined> = {}
      const r = part.radius
      if (r.top) { corners.tl = r.top; corners.tr = r.top }
      if (r.bottom) { corners.bl = r.bottom; corners.br = r.bottom }
      if (r.tl) corners.tl = r.tl
      if (r.tr) corners.tr = r.tr
      if (r.bl) corners.bl = r.bl
      if (r.br) corners.br = r.br
      for (const [corner, cssName] of [
        ['tl', 'border-top-left-radius'],
        ['tr', 'border-top-right-radius'],
        ['bl', 'border-bottom-left-radius'],
        ['br', 'border-bottom-right-radius'],
      ] as const) {
        const key = corners[corner]
        if (key) {
          const px = maps.radiusKeyToPx.get(key)
          if (px != null) expected[cssName] = px >= 9999 ? '9999px' : `${px}px`
        }
      }
    }
  }

  // Padding
  if (part.padding) {
    if (typeof part.padding === 'string') {
      const px = maps.spacingKeyToPx.get(part.padding)
      if (px != null) {
        expected['padding-top'] = `${px}px`
        expected['padding-right'] = `${px}px`
        expected['padding-bottom'] = `${px}px`
        expected['padding-left'] = `${px}px`
      }
    } else {
      const p = part.padding
      if (p.x) {
        const px = maps.spacingKeyToPx.get(p.x)
        if (px != null) { expected['padding-left'] = `${px}px`; expected['padding-right'] = `${px}px` }
      }
      if (p.y) {
        const px = maps.spacingKeyToPx.get(p.y)
        if (px != null) { expected['padding-top'] = `${px}px`; expected['padding-bottom'] = `${px}px` }
      }
      for (const [key, cssProp] of [
        ['left', 'padding-left'], ['right', 'padding-right'],
        ['top', 'padding-top'], ['bottom', 'padding-bottom'],
      ] as const) {
        if (p[key]) {
          const px = maps.spacingKeyToPx.get(p[key] as string)
          if (px != null) expected[cssProp] = `${px}px`
        }
      }
    }
  }

  // Gap
  if (part.gap && typeof part.gap === 'string') {
    const px = maps.spacingKeyToPx.get(part.gap)
    if (px != null) expected['gap'] = `${px}px`
  }

  // Text style → font-size, font-weight, line-height
  if (part.textStyle) {
    const style = Object.values(db.textStyles).find(ts => ts.utility === part.textStyle)
    if (style) {
      const p = style.properties
      if (p.fontSize) expected['font-size'] = String(p.fontSize)
      if (p.fontWeight) expected['font-weight'] = String(p.fontWeight)
      if (p.lineHeight && p.fontSize) {
        const fs = parseFloat(String(p.fontSize))
        const lh = parseFloat(String(p.lineHeight))
        expected['line-height'] = `${Math.round(fs * lh * 100) / 100}px`
      }
      if (p.letterSpacing && String(p.letterSpacing) !== '0') {
        const ls = String(p.letterSpacing)
        if (ls.endsWith('em') && p.fontSize) {
          const fs = parseFloat(String(p.fontSize))
          expected['letter-spacing'] = `${Math.round(parseFloat(ls) * fs * 100) / 100}px`
        } else {
          expected['letter-spacing'] = ls
        }
      }
    }
  }

  // Text color → color
  if (part.textColor) {
    const hex = resolveColorHex(part.textColor, maps)
    if (hex) expected['color'] = hex
  }

  // Opacity
  if (part.opacity != null && part.opacity < 1) {
    expected['opacity'] = String(part.opacity)
  }

  return expected
}

// ─── Comparison Helpers ──────────────────────────────────────────────────────

const COLOR_PROPS = new Set(['background-color', 'border-color', 'color'])
const PX_PROPS = new Set([
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-width', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'gap', 'font-size', 'line-height', 'letter-spacing',
])

function valuesMatch(property: string, expected: string, actual: string): boolean {
  if (COLOR_PROPS.has(property)) {
    return normalizeColor(expected) === normalizeColor(actual)
  }

  if (PX_PROPS.has(property)) {
    const expPx = parseFloat(expected)
    const actPx = parseFloat(actual)
    if (!isNaN(expPx) && !isNaN(actPx)) return Math.abs(expPx - actPx) <= 1
  }

  if (property === 'font-weight') {
    return String(parseInt(expected)) === String(parseInt(actual))
  }

  if (property === 'opacity') {
    return Math.abs(parseFloat(expected) - parseFloat(actual)) <= 0.02
  }

  return expected === actual
}

// ─── Phase 1: Token Verification ─────────────────────────────────────────────

async function verifyTokens(page: Page, db: DB): Promise<TokenResult[]> {
  const results: TokenResult[] = []

  // ── Colors ──
  const colorEntries = Object.values(db.colors).map(c => ({
    name: c.tailwind.key,
    cssVar: c.cssVar,
    dbValue: c.value,
  }))

  // Resolve all colors through browser temp elements in one call
  // (handles oklch, hex, and any other CSS color format)
  const resolvedColors = await page.evaluate((entries) => {
    return entries.map(e => {
      // Resolve actual CSS var value
      const raw = getComputedStyle(document.documentElement).getPropertyValue(e.cssVar).trim()
      const actualTemp = document.createElement('div')
      actualTemp.style.backgroundColor = raw || `var(${e.cssVar})`
      document.body.appendChild(actualTemp)
      const actual = getComputedStyle(actualTemp).backgroundColor
      document.body.removeChild(actualTemp)

      // Resolve expected DB value through browser (for oklch etc.)
      const expectedTemp = document.createElement('div')
      expectedTemp.style.backgroundColor = e.dbValue
      document.body.appendChild(expectedTemp)
      const expected = getComputedStyle(expectedTemp).backgroundColor
      document.body.removeChild(expectedTemp)

      return { actual, expected }
    })
  }, colorEntries)

  for (let i = 0; i < colorEntries.length; i++) {
    const entry = colorEntries[i]
    const { actual, expected } = resolvedColors[i]

    results.push({
      category: 'color',
      name: entry.name,
      cssVar: entry.cssVar,
      expected: `${entry.dbValue} → ${expected}`,
      actual,
      match: normalizeColor(expected) === normalizeColor(actual),
    })
  }

  // ── Spacing ──
  const spacingEntries = Object.values(db.spacing).map(s => ({
    name: s.tailwind.key,
    cssVar: s.cssVar,
    expected: `${s.value}px`,
  }))

  const resolvedSpacing = await page.evaluate((entries) => {
    return entries.map(e => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(e.cssVar).trim()
      return raw || '(not set)'
    })
  }, spacingEntries)

  for (let i = 0; i < spacingEntries.length; i++) {
    const entry = spacingEntries[i]
    const actual = resolvedSpacing[i]
    const expPx = parseFloat(entry.expected)
    const actPx = parseFloat(actual)
    results.push({
      category: 'spacing',
      name: entry.name,
      cssVar: entry.cssVar,
      expected: entry.expected,
      actual,
      match: !isNaN(actPx) && Math.abs(expPx - actPx) <= 0.5,
    })
  }

  // ── Radius ──
  const radiusEntries = Object.values(db.radius).map(r => ({
    name: r.tailwind.key,
    cssVar: `--radius-${r.tailwind.key}`,
    expected: `${r.value}px`,
  }))

  const resolvedRadius = await page.evaluate((entries) => {
    return entries.map(e => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(e.cssVar).trim()
      return raw || '(not set)'
    })
  }, radiusEntries)

  for (let i = 0; i < radiusEntries.length; i++) {
    const entry = radiusEntries[i]
    const actual = resolvedRadius[i]
    const expPx = parseFloat(entry.expected)
    const actPx = parseFloat(actual)
    results.push({
      category: 'radius',
      name: entry.name,
      cssVar: entry.cssVar,
      expected: entry.expected,
      actual,
      match: !isNaN(actPx) && Math.abs(expPx - actPx) <= 0.5,
    })
  }

  // ── Sizes ──
  const sizeEntries = Object.values(db.sizes).map(s => ({
    name: s.tailwind[0]?.key ?? s.figmaName,
    cssVar: s.cssVar,
    expected: `${s.value}px`,
  }))

  const resolvedSizes = await page.evaluate((entries) => {
    return entries.map(e => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(e.cssVar).trim()
      return raw || '(not set)'
    })
  }, sizeEntries)

  for (let i = 0; i < sizeEntries.length; i++) {
    const entry = sizeEntries[i]
    const actual = resolvedSizes[i]
    const expPx = parseFloat(entry.expected)
    const actPx = parseFloat(actual)
    results.push({
      category: 'size',
      name: entry.name,
      cssVar: entry.cssVar,
      expected: entry.expected,
      actual,
      match: !isNaN(actPx) && Math.abs(expPx - actPx) <= 0.5,
    })
  }

  return results
}

// ─── Phase 2: Component Verification ─────────────────────────────────────────

const CSS_PROPS_TO_EXTRACT = [
  'background-color', 'border-color', 'border-width',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'color', 'opacity', 'box-shadow',
]

async function verifyComponents(page: Page, db: DB, maps: Maps): Promise<ComponentResult[]> {
  const results: ComponentResult[] = []

  // Build DB lookup: dsKey → { partKey → expected CSS }
  const dbByComponent = new Map<string, Map<string, ExpectedCSS>>()
  for (const comp of Object.values(db.components)) {
    const partsMap = new Map<string, ExpectedCSS>()
    for (const [partKey, part] of Object.entries(comp.parts)) {
      const expected = computeExpectedCSS(part, db, maps)
      if (Object.keys(expected).length > 0) {
        partsMap.set(partKey, expected)
      }
    }
    if (partsMap.size > 0) {
      dbByComponent.set(comp.dsKey, partsMap)
    }
  }

  // Extract computed styles from all data-ds-* elements in the browser
  const browserElements = await page.evaluate((cssProps) => {
    const elements = document.querySelectorAll('[data-ds-component][data-ds-variant]')
    return Array.from(elements).map(el => {
      const dsComponent = el.getAttribute('data-ds-component')!
      const dsVariant = el.getAttribute('data-ds-variant')!

      // Find the visual target element (first non-label child)
      let target: Element = el
      const children = Array.from(el.children)
      // Skip label spans at the bottom of cells
      const visualChildren = children.filter(c => {
        if (c.tagName === 'SPAN' && c.classList.contains('mt-1')) return false
        return true
      })
      if (visualChildren.length > 0) target = visualChildren[0]

      const computed = getComputedStyle(target)
      const styles: Record<string, string> = {}
      for (const prop of cssProps) {
        styles[prop] = computed.getPropertyValue(prop)
      }

      return { dsComponent, dsVariant, styles }
    })
  }, CSS_PROPS_TO_EXTRACT)

  // Track which DB parts got matched
  const matchedParts = new Set<string>()

  // For each browser element, find matching DB expectations
  // Strategy: exact variant match → "root" fallback
  for (const browserEl of browserElements) {
    const { dsComponent, dsVariant } = browserEl

    // Skip foundation elements (handled by Phase 1)
    if (dsComponent.startsWith('foundation-')) continue

    const partsMap = dbByComponent.get(dsComponent)
    if (!partsMap) continue

    // Try exact match first (e.g. button.solid → button.solid)
    let expected = partsMap.get(dsVariant)
    let matchedPartKey = dsVariant

    // Fallback to "root" part (e.g. separator.horizontal → separator.root)
    // Skip complex organisms where the Cell's first child isn't the styled root
    const SKIP_ROOT_FALLBACK = new Set([
      'nodeCard', 'propertiesPanel', 'nodePalette', 'previewToolbar',
      'colorSwatch', 'connectableParamRow',
    ])
    if (!expected && partsMap.has('root') && !SKIP_ROOT_FALLBACK.has(dsComponent)) {
      expected = partsMap.get('root')!
      matchedPartKey = 'root'
    }

    if (!expected) continue

    const partId = `${dsComponent}|${matchedPartKey}|${dsVariant}`
    // Only compare each DB part once per unique browser variant
    if (matchedParts.has(partId)) continue
    matchedParts.add(partId)

    const comparisons: PropertyComparison[] = []
    for (const [prop, expectedVal] of Object.entries(expected)) {
      const actualVal = browserEl.styles[prop] ?? ''

      // Skip transparent backgrounds unless we expected a real color
      if (prop === 'background-color' && actualVal === 'rgba(0, 0, 0, 0)') {
        if (expectedVal !== '#000000' && expectedVal !== 'transparent') {
          comparisons.push({ property: prop, expected: expectedVal, actual: actualVal, match: false })
        }
        continue
      }

      const match = valuesMatch(prop, expectedVal, actualVal)
      comparisons.push({
        property: prop,
        expected: expectedVal,
        actual: actualVal,
        match,
      })
    }

    results.push({
      dsComponent,
      dsVariant: matchedPartKey === dsVariant ? dsVariant : `${dsVariant} → ${matchedPartKey}`,
      found: true,
      comparisons,
    })
  }

  // Report DB parts that had no browser match at all
  for (const [dsKey, partsMap] of dbByComponent) {
    for (const [partKey] of partsMap) {
      const wasMatched = [...matchedParts].some(id => id.startsWith(`${dsKey}|${partKey}|`))
      if (!wasMatched) {
        results.push({ dsComponent: dsKey, dsVariant: partKey, found: false, comparisons: [] })
      }
    }
  }

  return results
}

// ─── Report Generation ───────────────────────────────────────────────────────

function generateReport(tokenResults: TokenResult[], componentResults: ComponentResult[]): string {
  const now = new Date().toISOString()
  const lines: string[] = []

  lines.push('# Visual Audit Report')
  lines.push(`Generated: ${now}\n`)

  // ── Token Summary ──
  const tokenMatches = tokenResults.filter(r => r.match).length
  const tokenTotal = tokenResults.length

  lines.push('## Phase 1: Token Verification')
  lines.push('')
  lines.push('| Category | Total | Matches | Divergences |')
  lines.push('|----------|-------|---------|-------------|')
  for (const cat of ['color', 'spacing', 'radius', 'size'] as const) {
    const catResults = tokenResults.filter(r => r.category === cat)
    const catMatches = catResults.filter(r => r.match).length
    const catDiv = catResults.length - catMatches
    lines.push(`| ${cat} | ${catResults.length} | ${catMatches} | ${catDiv} |`)
  }
  lines.push(`| **Total** | **${tokenTotal}** | **${tokenMatches}** | **${tokenTotal - tokenMatches}** |`)
  lines.push('')

  const tokenDivergences = tokenResults.filter(r => !r.match)
  if (tokenDivergences.length > 0) {
    lines.push('### Token Divergences')
    lines.push('')
    lines.push('| Token | CSS Var | Expected | Actual |')
    lines.push('|-------|---------|----------|--------|')
    for (const d of tokenDivergences) {
      lines.push(`| ${d.name} | \`${d.cssVar}\` | ${d.expected} | ${d.actual} |`)
    }
    lines.push('')
  } else {
    lines.push('All tokens match. No divergences found.\n')
  }

  // ── Component Summary ──
  const compTotal = componentResults.length
  const compFound = componentResults.filter(r => r.found).length
  const compMissing = compTotal - compFound
  const compClean = componentResults.filter(r => r.found && r.comparisons.every(c => c.match)).length
  const compDivergent = componentResults.filter(r => r.found && r.comparisons.some(c => !c.match)).length
  const totalPropChecks = componentResults.reduce((n, r) => n + r.comparisons.length, 0)
  const totalPropMatches = componentResults.reduce((n, r) => n + r.comparisons.filter(c => c.match).length, 0)

  lines.push('## Phase 2: Component Verification')
  lines.push('')
  lines.push('| Metric | Count |')
  lines.push('|--------|-------|')
  lines.push(`| Component parts with expectations | ${compTotal} |`)
  lines.push(`| Elements found in browser | ${compFound} |`)
  lines.push(`| Elements missing | ${compMissing} |`)
  lines.push(`| Clean (all properties match) | ${compClean} |`)
  lines.push(`| Divergent (≥1 property mismatch) | ${compDivergent} |`)
  lines.push(`| Properties checked | ${totalPropChecks} |`)
  lines.push(`| Properties matching | ${totalPropMatches} |`)
  lines.push('')

  // Clean components
  const cleanComps = componentResults.filter(r => r.found && r.comparisons.every(c => c.match))
  if (cleanComps.length > 0) {
    lines.push('### Clean Components')
    lines.push('')
    lines.push(cleanComps.map(c => `\`${c.dsComponent}.${c.dsVariant}\``).join(', '))
    lines.push('')
  }

  // Missing elements
  const missingComps = componentResults.filter(r => !r.found)
  if (missingComps.length > 0) {
    lines.push('### Missing Elements')
    lines.push('')
    lines.push('These component parts have DB expectations but no matching `data-ds-component`/`data-ds-variant` element in `/ds-preview`:')
    lines.push('')
    lines.push(missingComps.map(c => `\`${c.dsComponent}.${c.dsVariant}\``).join(', '))
    lines.push('')
  }

  // Divergences
  const divergentComps = componentResults.filter(r => r.found && r.comparisons.some(c => !c.match))
  if (divergentComps.length > 0) {
    lines.push('### Component Divergences')
    lines.push('')
    lines.push('| Component | Variant | Property | Expected | Actual |')
    lines.push('|-----------|---------|----------|----------|--------|')
    for (const comp of divergentComps) {
      for (const c of comp.comparisons.filter(c => !c.match)) {
        const exp = COLOR_PROPS.has(c.property) ? normalizeColor(c.expected) : c.expected
        lines.push(`| ${comp.dsComponent} | ${comp.dsVariant} | ${c.property} | ${exp} | ${c.actual} |`)
      }
    }
    lines.push('')
  }

  // Conclusion
  const totalDiv = tokenDivergences.length +
    divergentComps.reduce((n, c) => n + c.comparisons.filter(x => !x.match).length, 0)

  lines.push('## Conclusion')
  lines.push('')
  if (totalDiv === 0 && compMissing === 0) {
    lines.push('**All tokens and component styles match.** The design system is fully in sync.')
  } else if (totalDiv === 0) {
    lines.push(`**All found elements match.** ${compMissing} component parts are missing from /ds-preview (not rendered with data-ds-* attributes).`)
  } else {
    lines.push(`Found **${totalDiv} divergence(s)** across ${tokenDivergences.length} token(s) and ${divergentComps.length} component(s). ${compMissing} elements missing from /ds-preview.`)
  }

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Visual Audit — DB vs Browser Comparison')
  console.log('=======================================\n')

  // Check dev server
  try {
    const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch {
    console.error(`Dev server not responding at ${BASE_URL}`)
    console.error('Start the dev server first: npm run dev')
    process.exit(1)
  }

  // Load DB
  const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  const maps = buildMaps(db)
  console.log('Loaded design system database')

  // Launch browser
  console.log('Launching Chrome...')
  let browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  } catch {
    try {
      // Fallback to Chromium if Chrome not found
      browser = await chromium.launch({ headless: true })
    } catch {
      console.error('Chrome not found. Install Chrome or set CHROME_PATH.')
      process.exit(1)
    }
  }

  try {
    const page = await browser.newPage()
    console.log(`Navigating to ${BASE_URL}...`)
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 })

    // Wait for React to render
    await page.waitForSelector('[data-ds-component]', { timeout: 10000 })

    const elementCount = await page.evaluate(() =>
      document.querySelectorAll('[data-ds-component]').length
    )
    console.log(`Page loaded. Found ${elementCount} data-ds-component elements.\n`)

    // Phase 1: Token verification
    console.log('Phase 1: Token verification...')
    const tokenResults = await verifyTokens(page, db)
    const tokenDiv = tokenResults.filter(r => !r.match).length
    console.log(`  ${tokenResults.length} tokens checked, ${tokenDiv} divergence(s)`)

    // Phase 2: Component verification
    console.log('\nPhase 2: Component verification...')
    const componentResults = await verifyComponents(page, db, maps)
    const compFound = componentResults.filter(r => r.found).length
    const compClean = componentResults.filter(r => r.found && r.comparisons.every(c => c.match)).length
    const compDiv = componentResults.filter(r => r.found && r.comparisons.some(c => !c.match)).length
    console.log(`  ${componentResults.length} parts checked`)
    console.log(`  ${compFound} found, ${componentResults.length - compFound} missing`)
    console.log(`  ${compClean} clean, ${compDiv} divergent`)

    // Generate report
    const report = generateReport(tokenResults, componentResults)
    mkdirSync(REPORT_DIR, { recursive: true })
    writeFileSync(REPORT_PATH, report)
    console.log(`\nReport: ${REPORT_PATH}`)

    // Summary
    const totalDiv = tokenDiv +
      componentResults.reduce((n, c) => n + c.comparisons.filter(x => !x.match).length, 0)

    if (totalDiv === 0) {
      console.log('\n✅ All tokens and component styles match!')
    } else {
      console.log(`\n⚠ Found ${totalDiv} divergence(s). See report for details.`)
    }

    await browser.close()
    process.exit(totalDiv > 0 ? 1 : 0)
  } catch (err) {
    await browser.close()
    throw err
  }
}

main().catch((err) => {
  console.error('Error:', (err as Error).message)
  process.exit(1)
})
