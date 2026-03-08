/**
 * generate-tokens.ts — Reads tokens/sombra.ds.json and generates:
 *   1. src/index.css  (marker-delimited regions for tokens)
 *   2. src/generated/ds.ts  (component Tailwind class strings)
 *   3. src/utils/port-colors.ts  (port type color constants)
 *
 * Usage:
 *   npx tsx scripts/generate-tokens.ts           # generate files
 *   npx tsx scripts/generate-tokens.ts --check   # CI guard (exit 1 if drift)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

// ─── Paths ───────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')
const CSS_PATH = resolve(ROOT, 'src/index.css')
const DS_PATH = resolve(ROOT, 'src/generated/ds.ts')
const PORT_COLORS_PATH = resolve(ROOT, 'src/utils/port-colors.ts')

const CHECK_MODE = process.argv.includes('--check')

// ─── Types ───────────────────────────────────────────────────────────────────

interface TailwindRef {
  namespace: string
  key: string
}

interface ColorEntry {
  figmaName: string
  cssVar: string
  value: string
  tailwind: TailwindRef
}

interface SpacingEntry {
  figmaName: string
  cssVar: string
  value: number
  unit: string
  tailwind: TailwindRef
}

interface RadiusEntry {
  figmaName: string
  value: number
  unit: string
  tailwind: TailwindRef
}

interface SizeEntry {
  figmaName: string
  cssVar: string
  value: number
  unit: string
  tailwind: TailwindRef[]
}

interface ComputedEntry {
  cssVar: string
  expression: string
  tailwind: TailwindRef
}

interface TextStyleEntry {
  figmaName: string
  utility: string
  properties: Record<string, string | number>
}

interface PortColorEntry {
  figmaName: string
  value: string
}

interface StrokeDef {
  side?: string
  color?: string
  weight?: number
}

interface StateDef {
  fill?: string
  textColor?: string
  stroke?: string
  cursor?: string
  opacity?: number
  ring?: string
  shadow?: string
}

interface ComponentPart {
  figmaNodeId: string | null
  // Layout
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
  // Text
  textStyle?: string
  textColor?: string
  // Interaction
  cursor?: string
  transition?: string
  userSelect?: string
  // Layout extras
  position?: string
  z?: number | string
  overflow?: string
  opacity?: number
  inset?: string
  width?: string
  height?: string
  minWidth?: string
  pointerEvents?: string
  // States
  hover?: Partial<StateDef>
  active?: Partial<StateDef>
  disabled?: Partial<StateDef>
  selected?: Partial<StateDef>
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
  lastSync: string
  figmaFileKey: string
  colors: Record<string, ColorEntry>
  portColors: Record<string, PortColorEntry>
  spacing: Record<string, SpacingEntry>
  radius: Record<string, RadiusEntry>
  sizes: Record<string, SizeEntry>
  computed: Record<string, ComputedEntry>
  textStyles: Record<string, TextStyleEntry>
  components: Record<string, ComponentEntry>
}

// ─── Read DB ─────────────────────────────────────────────────────────────────

const db: DB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))

// ─── CSS Generation ──────────────────────────────────────────────────────────

/** Generate the :root CSS variables region (root-vars) */
function generateRootVars(): string {
  const lines: string[] = []

  // Colors
  lines.push('  /* Sombra color palette */')
  const colorGroups: Record<string, ColorEntry[]> = {}
  for (const entry of Object.values(db.colors)) {
    const group = entry.figmaName.split('/')[0]
    if (!colorGroups[group]) colorGroups[group] = []
    colorGroups[group].push(entry)
  }

  for (const [group, entries] of Object.entries(colorGroups)) {
    if (group !== Object.keys(colorGroups)[0]) lines.push('')
    for (const entry of entries) {
      const comment = entry.value.startsWith('oklch')
        ? ` /* ${entry.figmaName}  ${findVarId(db.colors, entry)} — white 10% */`
        : ''
      lines.push(`  ${entry.cssVar}: ${entry.value};${comment}`)
    }
  }

  // Spacing
  lines.push('')
  lines.push('  /* ── Sombra spacing tokens (Figma: Spacing collection) ── */')
  for (const [varId, entry] of Object.entries(db.spacing)) {
    const id = varId.replace('VariableID:', '')
    const key = entry.cssVar.replace('--sp-', '')
    lines.push(`  ${entry.cssVar}: ${entry.value}${entry.unit};   /* spacing/${key}  ${varId} */`)
  }

  // Sizes
  lines.push('')
  lines.push('  /* ── Sombra size tokens (Figma: Sizes collection) ── */')
  for (const [varId, entry] of Object.entries(db.sizes)) {
    const name = entry.figmaName.replace('/', '-')
    const padded = (entry.cssVar + ':').padEnd(19)
    lines.push(`  ${padded} ${entry.value}${entry.unit};  /* size/${name.padEnd(12)} ${varId} */`)
  }

  // Computed
  lines.push('')
  lines.push('  /* ── Computed ── */')
  for (const entry of Object.values(db.computed)) {
    lines.push(`  ${entry.cssVar}: ${entry.expression};`)
  }

  return lines.join('\n')
}

/** Generate the @theme inline radius region (theme-radius) */
function generateThemeRadius(): string {
  const lines: string[] = []
  for (const [varId, entry] of Object.entries(db.radius)) {
    const comment = entry.figmaName === 'sm/4' ? `  /* Figma radius/sm (${varId}) */` : ''
    lines.push(`  --radius-${entry.tailwind.key}: ${entry.value}${entry.unit};${comment}`)
  }
  return lines.join('\n')
}

/** Generate the @theme inline Sombra registrations (theme-sombra) */
function generateThemeSombra(): string {
  const lines: string[] = []

  // Colors
  lines.push('  /* Sombra design tokens */')
  for (const entry of Object.values(db.colors)) {
    lines.push(`  --color-${entry.tailwind.key}: var(${entry.cssVar});`)
  }

  // Spacing
  lines.push('')
  lines.push('  /* ── Sombra spacing → Tailwind utilities ── */')
  for (const entry of Object.values(db.spacing)) {
    lines.push(`  --spacing-${entry.tailwind.key}: var(${entry.cssVar});`)
  }
  // Computed spacing
  for (const entry of Object.values(db.computed)) {
    if (entry.tailwind.namespace === 'spacing') {
      lines.push(`  --spacing-${entry.tailwind.key}: var(${entry.cssVar});`)
    }
  }

  // Sizes registered as spacing
  lines.push('')
  lines.push('  /* Sizes registered as spacing (for h-*, w-* utilities) */')
  const spacingSizeRegs = new Map<string, string>()
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      if (tw.namespace === 'spacing') {
        spacingSizeRegs.set(tw.key, entry.cssVar)
      }
    }
  }
  // Mirror size-* tokens into spacing-* so h-*/w-* classes work for size keys.
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      if (tw.namespace === 'size' && !spacingSizeRegs.has(tw.key)) {
        spacingSizeRegs.set(tw.key, entry.cssVar)
      }
    }
  }
  for (const [key, cssVar] of spacingSizeRegs) {
    lines.push(`  --spacing-${key}:${' '.repeat(Math.max(1, 6 - key.length))}var(${cssVar});`)
  }

  // Sizes registered as size
  lines.push('')
  lines.push('  /* ── Sombra sizes → Tailwind size-* utilities ── */')
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      if (tw.namespace === 'size') {
        lines.push(`  --size-${tw.key}:${' '.repeat(Math.max(1, 7 - tw.key.length))}var(${entry.cssVar});`)
      }
    }
  }

  // Min-width
  lines.push('')
  lines.push('  /* ── Min-width → Tailwind min-w-node ── */')
  for (const entry of Object.values(db.sizes)) {
    for (const tw of entry.tailwind) {
      if (tw.namespace === 'min-width') {
        lines.push(`  --min-width-${tw.key}: var(${entry.cssVar});`)
      }
    }
  }

  return lines.join('\n')
}

/** Generate the @utility text style blocks (utilities) */
function generateUtilities(): string {
  const lines: string[] = []
  lines.push('/* ── Figma text style → Tailwind @utility ── */')
  lines.push('')

  const entries = Object.values(db.textStyles)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const props = entry.properties
    const padded = (entry.utility + ' {').padEnd(33)
    lines.push(`@utility ${padded} /* ${entry.figmaName}: ${describeTextStyle(props)} */`)
    lines.push(`  font-size: ${props.fontSize};`)
    lines.push(`  font-weight: ${props.fontWeight};`)
    if (props.fontFamily) lines.push(`  font-family: ${props.fontFamily};`)
    if (props.letterSpacing) lines.push(`  letter-spacing: ${props.letterSpacing};`)
    if (props.textTransform) lines.push(`  text-transform: ${props.textTransform};`)
    lines.push(`  line-height: ${props.lineHeight};`)
    lines.push('}')
    // No blank line after last utility
  }

  return lines.join('\n')
}

function describeTextStyle(props: Record<string, string | number>): string {
  const parts: string[] = []
  parts.push(String(props.fontSize))
  parts.push(Number(props.fontWeight) >= 600 ? 'SemiBold' : 'Regular')
  if (props.letterSpacing) parts.push(`${props.letterSpacing} ls`)
  if (props.textTransform === 'uppercase') parts.push('UPPER')
  if (props.fontFamily) parts.push('mono')
  if (props.lineHeight && props.lineHeight !== 1.5) {
    parts.push(`LH ${Number(props.lineHeight) * 100}%`)
  }
  return parts.join(', ')
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function findVarId(section: Record<string, { figmaName: string }>, entry: { figmaName: string }): string {
  for (const [id, e] of Object.entries(section)) {
    if (e === entry) return id
  }
  return ''
}

/** Replace content between markers in a file */
function replaceRegion(content: string, regionName: string, generated: string): string {
  const startMarker = `/* === GENERATED:START ${regionName} === */`
  const endMarker = `/* === GENERATED:END ${regionName} === */`

  const startIdx = content.indexOf(startMarker)
  const endIdx = content.indexOf(endMarker)

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Marker region "${regionName}" not found in CSS. Expected:\n  ${startMarker}\n  ${endMarker}`)
  }

  const before = content.slice(0, startIdx + startMarker.length)
  const after = content.slice(endIdx)

  return before + '\n' + generated + '\n  ' + after
}

// ─── ds.ts Generation ────────────────────────────────────────────────────────

/** Build a color lookup: figmaName → tailwind key */
function buildColorMap(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of Object.values(db.colors)) {
    map[entry.figmaName] = entry.tailwind.key
  }
  return map
}

/** Convert a Figma fill name to a Tailwind bg- class */
function fillToClass(fill: string, colorMap: Record<string, string>): string {
  if (fill === 'black') return 'bg-black'
  const key = colorMap[fill]
  if (key) return `bg-${key}`
  // Fallback: convert slash to dash
  return `bg-${fill.replace(/\//g, '-')}`
}

/** Convert a stroke definition to Tailwind border classes */
function strokeToClasses(stroke: StrokeDef, colorMap: Record<string, string>): string[] {
  const classes: string[] = []

  const widthSuffix = stroke.weight && stroke.weight !== 1 ? `-${stroke.weight}` : ''
  if (stroke.side === 'bottom') classes.push(`border-b${widthSuffix}`)
  else if (stroke.side === 'top') classes.push(`border-t${widthSuffix}`)
  else if (stroke.side === 'left') classes.push(`border-l${widthSuffix}`)
  else if (stroke.side === 'right') classes.push(`border-r${widthSuffix}`)
  else classes.push(`border${widthSuffix}`)

  if (stroke.color) {
    const key = colorMap[stroke.color]
    if (key) {
      classes.push(`border-${key}`)
    } else {
      classes.push(`border-${stroke.color.replace(/\//g, '-')}`)
    }
  }

  return classes
}

/** Convert a radius to Tailwind rounded- class */
function radiusToClasses(radius: string | Record<string, string>): string[] {
  if (typeof radius === 'string') {
    return [`rounded-${radius}`]
  }
  const classes: string[] = []
  if (radius.top) classes.push(`rounded-t-${radius.top}`)
  if (radius.bottom) classes.push(`rounded-b-${radius.bottom}`)
  if (radius.left) classes.push(`rounded-l-${radius.left}`)
  if (radius.right) classes.push(`rounded-r-${radius.right}`)
  return classes
}

/** Convert padding to Tailwind p- classes */
function paddingToClasses(padding: string | Record<string, string>): string[] {
  if (typeof padding === 'string') {
    return [`p-${padding}`]
  }
  const classes: string[] = []
  if (padding.x) classes.push(`px-${padding.x}`)
  if (padding.y) classes.push(`py-${padding.y}`)
  if (padding.top) classes.push(`pt-${padding.top}`)
  if (padding.bottom) classes.push(`pb-${padding.bottom}`)
  if (padding.left) classes.push(`pl-${padding.left}`)
  if (padding.right) classes.push(`pr-${padding.right}`)
  return classes
}

/** Convert gap to Tailwind gap- classes */
function gapToClasses(gap: string | Record<string, string>): string[] {
  if (typeof gap === 'string') {
    return [`gap-${gap}`]
  }
  const classes: string[] = []
  if (gap.x) classes.push(`gap-x-${gap.x}`)
  if (gap.y) classes.push(`gap-y-${gap.y}`)
  return classes
}

/** Convert a component part to a Tailwind class string */
function partToClassString(part: ComponentPart, colorMap: Record<string, string>): string {
  const classes: string[] = []

  // Layout
  if (part.layout === 'horizontal') classes.push('flex', 'flex-row')
  if (part.layout === 'vertical') classes.push('flex', 'flex-col')

  // Alignment
  if (part.align === 'center') classes.push('items-center')
  if (part.align === 'start') classes.push('items-start')
  if (part.align === 'end') classes.push('items-end')

  // Justify
  if (part.justify === 'between') classes.push('justify-between')
  if (part.justify === 'center') classes.push('justify-center')
  if (part.justify === 'end') classes.push('justify-end')

  // Fill
  if (part.fill) classes.push(fillToClass(part.fill, colorMap))

  // Radius
  if (part.radius) classes.push(...radiusToClasses(part.radius))

  // Stroke
  if (part.stroke) classes.push(...strokeToClasses(part.stroke, colorMap))

  // Padding
  if (part.padding) classes.push(...paddingToClasses(part.padding))

  // Gap
  if (part.gap) classes.push(...gapToClasses(part.gap))

  // Text
  if (part.textStyle) classes.push(part.textStyle)
  if (part.textColor) classes.push(`text-${part.textColor}`)

  // Interaction
  if (part.cursor) classes.push(`cursor-${part.cursor}`)
  if (part.transition) classes.push(`transition-${part.transition}`)
  if (part.userSelect) classes.push(`select-${part.userSelect}`)

  // Layout extras
  if (part.position) classes.push(part.position)
  if (part.z != null) classes.push(`z-${part.z}`)
  if (part.overflow) classes.push(`overflow-${part.overflow}`)
  if (part.opacity != null) classes.push(`opacity-${part.opacity}`)
  if (part.inset) classes.push(`inset-${part.inset}`)
  if (part.width) classes.push(`w-${part.width}`)
  if (part.height) classes.push(`h-${part.height}`)
  if (part.minWidth) classes.push(`min-w-${part.minWidth}`)
  if (part.pointerEvents) classes.push(`pointer-events-${part.pointerEvents}`)

  // States
  for (const [prefix, state] of [['hover', part.hover], ['active', part.active], ['disabled', part.disabled], ['selected', part.selected]] as const) {
    if (!state) continue
    const s = state as Partial<StateDef>
    if (s.fill) classes.push(`${prefix}:bg-${colorMap[s.fill] ?? s.fill.replace(/\//g, '-')}`)
    if (s.textColor) classes.push(`${prefix}:text-${s.textColor}`)
    if (s.stroke) classes.push(`${prefix}:border-${s.stroke}`)
    if (s.cursor) classes.push(`${prefix}:cursor-${s.cursor}`)
    if (s.opacity != null) classes.push(`${prefix}:opacity-${s.opacity}`)
    if (s.ring) classes.push(`${prefix}:ring-${s.ring}`)
    if (s.shadow) classes.push(`${prefix}:shadow-${s.shadow}`)
  }

  // Effects
  if (part.effects) {
    for (const effect of part.effects) {
      classes.push(effect.class)
    }
  }

  // Extra (direct class passthrough)
  if (part.extra) classes.push(part.extra)

  return classes.join(' ')
}

/** Generate the full ds.ts file content */
function generateDsTs(): string {
  const colorMap = buildColorMap()
  const lines: string[] = []

  lines.push('// AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually')
  lines.push('// Run `npm run tokens` to regenerate')
  lines.push('')
  lines.push('export const ds = {')

  const components = Object.values(db.components)
  for (let i = 0; i < components.length; i++) {
    const comp = components[i]
    const parts = Object.entries(comp.parts)

    // Skip components with no meaningful class output
    const hasClasses = parts.some(([_, p]) => partToClassString(p, colorMap).length > 0)
    if (!hasClasses) continue

    lines.push(`  ${comp.dsKey}: {`)
    for (const [partName, part] of parts) {
      const classStr = partToClassString(part, colorMap)
      if (classStr) {
        lines.push(`    ${partName}: "${classStr}",`)
      }
    }
    lines.push('  },')
  }

  lines.push('} as const;')
  lines.push('')
  lines.push('export type DSComponent = keyof typeof ds;')
  lines.push('')

  return lines.join('\n')
}

// ─── port-colors.ts Generation ───────────────────────────────────────────────

function generatePortColors(): string {
  const lines: string[] = []

  lines.push('/**')
  lines.push(' * Shared port type color definitions — single source of truth')
  lines.push(' * AUTO-GENERATED from tokens/sombra.ds.json — do not edit manually')
  lines.push(' * Run `npm run tokens` to regenerate')
  lines.push(' */')
  lines.push('')
  lines.push('export const PORT_COLORS: Record<string, string> = {')

  for (const entry of Object.values(db.portColors)) {
    lines.push(`  ${entry.figmaName}: '${entry.value}',`)
  }

  lines.push('}')
  lines.push('')
  lines.push('export function getPortColor(type: string): string {')
  lines.push('  return PORT_COLORS[type] ?? PORT_COLORS.default')
  lines.push('}')
  lines.push('')

  return lines.join('\n')
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log(`Reading DB: ${DB_PATH}`)

  // 1. Generate CSS regions
  let css = readFileSync(CSS_PATH, 'utf-8')
  css = replaceRegion(css, 'root-vars', generateRootVars())
  css = replaceRegion(css, 'theme-radius', generateThemeRadius())
  css = replaceRegion(css, 'theme-sombra', generateThemeSombra())
  css = replaceRegion(css, 'utilities', generateUtilities())

  // 2. Generate ds.ts
  const dsTs = generateDsTs()

  // 3. Generate port-colors.ts
  const portColors = generatePortColors()

  if (CHECK_MODE) {
    let drift = false

    const currentCss = readFileSync(CSS_PATH, 'utf-8')
    if (currentCss !== css) {
      console.error('✗ src/index.css has drifted from DB')
      drift = true
    }

    if (existsSync(DS_PATH)) {
      const currentDs = readFileSync(DS_PATH, 'utf-8')
      if (currentDs !== dsTs) {
        console.error('✗ src/generated/ds.ts has drifted from DB')
        drift = true
      }
    } else {
      console.error('✗ src/generated/ds.ts does not exist')
      drift = true
    }

    if (existsSync(PORT_COLORS_PATH)) {
      const currentPort = readFileSync(PORT_COLORS_PATH, 'utf-8')
      if (currentPort !== portColors) {
        console.error('✗ src/utils/port-colors.ts has drifted from DB')
        drift = true
      }
    }

    if (drift) {
      console.error('\nRun `npm run tokens` to regenerate.')
      process.exit(1)
    }

    console.log('✓ All generated files match DB')
    process.exit(0)
  }

  // Write files
  writeFileSync(CSS_PATH, css, 'utf-8')
  console.log(`  ✓ src/index.css (4 regions updated)`)

  const dsDir = dirname(DS_PATH)
  if (!existsSync(dsDir)) mkdirSync(dsDir, { recursive: true })
  writeFileSync(DS_PATH, dsTs, 'utf-8')
  console.log(`  ✓ src/generated/ds.ts (${Object.values(db.components).length} components)`)

  writeFileSync(PORT_COLORS_PATH, portColors, 'utf-8')
  console.log(`  ✓ src/utils/port-colors.ts (${Object.keys(db.portColors).length} port types)`)

  console.log('\nDone.')
}

main()
