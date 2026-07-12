/**
 * schema.ts — Zod schema for tokens/sombra.ds.json
 *
 * Validates the entire design-system database shape.
 * Wire into figma-pull.ts (after write) and generate-tokens.ts (before read)
 * to fail fast on corrupt or drifted data.
 *
 * Usage:
 *   npx tsx scripts/schema.ts              # validate sombra.ds.json
 *   npx tsx scripts/schema.ts --verbose    # show all errors
 */

import { z } from 'zod'

// ── Primitives ──────────────────────────────────────────────────────────────

const TailwindRef = z.object({
  namespace: z.string(),
  key: z.string(),
})

/**
 * Color values in the DB can be:
 *  - hex:   #0f0f1a
 *  - rgba:  rgba(99, 102, 241, 0.15)
 *  - oklch: oklch(1 0 0 / 10%)
 */
const ColorValue = z.string().check(
  z.refine((v) => /^(#[0-9a-fA-F]{3,8}|rgba?\(|oklch\()/.test(v), {
    message: 'Must be hex (#xxx or #xxxxxx), rgba(...), or oklch(...)',
  }),
)

// ── Token Entries ───────────────────────────────────────────────────────────

const ColorEntry = z.object({
  figmaName: z.string(),
  cssVar: z.string(),
  value: ColorValue,
  tailwind: TailwindRef,
})

const PortColorEntry = z.object({
  figmaName: z.string(),
  value: z.string(), // hex only, no oklch/rgba in port colors
})

const SpacingEntry = z.object({
  figmaName: z.string(),
  cssVar: z.string(),
  value: z.number(),
  unit: z.literal('px'),
  tailwind: TailwindRef,
})

/** Radius entries have no cssVar — unlike spacing/sizes */
const RadiusEntry = z.object({
  figmaName: z.string(),
  value: z.number(),
  unit: z.literal('px'),
  tailwind: TailwindRef,
})

/** Sizes map to an *array* of TailwindRefs (can hit multiple namespaces) */
const SizeEntry = z.object({
  figmaName: z.string(),
  cssVar: z.string(),
  value: z.number(),
  unit: z.literal('px'),
  tailwind: z.array(TailwindRef),
})

const TextStyleEntry = z.object({
  figmaName: z.string(),
  utility: z.string(),
  properties: z.record(z.string(), z.union([z.string(), z.number()])),
})

// ── Component System ────────────────────────────────────────────────────────

const StrokeDef = z.object({
  side: z.string().optional(),
  color: z.string().optional(),
  weight: z.number().optional(),
  topWeight: z.number().optional(),
  rightWeight: z.number().optional(),
  bottomWeight: z.number().optional(),
  leftWeight: z.number().optional(),
  style: z.enum(['solid', 'dashed']).optional(),
})

const StateDef = z.object({
  fill: z.string().optional(),
  textColor: z.string().optional(),
  stroke: z.string().optional(),
  cursor: z.string().optional(),
  opacity: z.number().optional(),
  ring: z.string().optional(),
  shadow: z.string().optional(),
})

const EffectDef = z.object({
  type: z.string(),
  class: z.string(),
})

/** padding/radius/gap can be a plain token string or a directional record */
const StringOrRecord = z.union([z.string(), z.record(z.string(), z.string())])

const ComponentPart = z.object({
  figmaNodeId: z.string().nullable().optional(),
  // Layout
  layout: z.enum(['horizontal', 'vertical']).optional(),
  fill: z.string().optional(),
  stroke: StrokeDef.optional(),
  radius: StringOrRecord.optional(),
  padding: StringOrRecord.optional(),
  gap: StringOrRecord.optional(),
  align: z.string().optional(),
  justify: z.string().optional(),
  effects: z.array(EffectDef).optional(),
  extra: z.string().optional(),
  // Text
  textStyle: z.string().optional(),
  textColor: z.string().optional(),
  textAlign: z.string().optional(),
  textAlignVertical: z.string().optional(),
  textDecoration: z.string().optional(),
  textCase: z.string().optional(),
  // Visual
  blendMode: z.string().optional(),
  // Interaction
  cursor: z.string().optional(),
  transition: z.string().optional(),
  userSelect: z.string().optional(),
  // Layout extras
  position: z.string().optional(),
  z: z.union([z.number(), z.string()]).optional(),
  overflow: z.string().optional(),
  opacity: z.number().optional(),
  inset: z.string().optional(),
  width: z.string().optional(),
  height: z.string().optional(),
  minWidth: z.string().optional(),
  pointerEvents: z.string().optional(),
  // States
  hover: StateDef.optional(),
  active: StateDef.optional(),
  disabled: StateDef.optional(),
  selected: StateDef.optional(),
  // Auditing
  auditIgnore: z.array(z.string()).optional(),
})

const ComponentEntry = z.object({
  name: z.string(),
  type: z.enum(['organism', 'molecule', 'atom']),
  dsKey: z.string(),
  codeFile: z.string().nullable(),
  parts: z.record(z.string(), ComponentPart),
})

// ── Node Templates ──────────────────────────────────────────────────────────

/** Regular node template (Noise, Arithmetic, etc.) */
const NodeTemplate = z.object({
  name: z.string(),
  category: z.string(),
  nodeFile: z.string(),
})

/** The `_shared` template has fill/stroke/radius instead of name/category */
const SharedNodeTemplate = z.object({
  fill: z.string(),
  stroke: z.string(),
  radius: z.string(),
})

// ── Scenes ──────────────────────────────────────────────────────────────────

const Scene = z.object({
  name: z.string(),
  size: z.tuple([z.number(), z.number()]),
})

// ── Top-level DB ────────────────────────────────────────────────────────────

export const SombraDB = z.object({
  version: z.number().int().positive(),
  lastSync: z.iso.datetime(),
  figmaFileKey: z.string(),
  lastFigmaVersion: z.number().optional(),
  colors: z.record(z.string(), ColorEntry),
  portColors: z.record(z.string(), PortColorEntry),
  spacing: z.record(z.string(), SpacingEntry),
  radius: z.record(z.string(), RadiusEntry),
  sizes: z.record(z.string(), SizeEntry),
  computed: z.record(z.string(), z.unknown()),
  textStyles: z.record(z.string(), TextStyleEntry),
  components: z.record(z.string(), ComponentEntry),
  nodeTemplates: z.record(
    z.string(),
    z.union([SharedNodeTemplate, NodeTemplate]),
  ),
  scenes: z.record(z.string(), Scene),
})

export type SombraDB = z.infer<typeof SombraDB>

// ── CLI runner ──────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('schema.ts')) {
  const { readFileSync } = await import('fs')
  const { resolve } = await import('path')

  const ROOT = resolve(import.meta.dirname, '..')
  const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')
  const verbose = process.argv.includes('--verbose')

  console.log(`Validating ${DB_PATH}…`)

  const raw = JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  const result = SombraDB.safeParse(raw)

  if (result.success) {
    const db = result.data
    console.log('✓ Valid')
    console.log(`  version:        ${db.version}`)
    console.log(`  lastSync:       ${db.lastSync}`)
    console.log(`  colors:         ${Object.keys(db.colors).length}`)
    console.log(`  portColors:     ${Object.keys(db.portColors).length}`)
    console.log(`  spacing:        ${Object.keys(db.spacing).length}`)
    console.log(`  radius:         ${Object.keys(db.radius).length}`)
    console.log(`  sizes:          ${Object.keys(db.sizes).length}`)
    console.log(`  textStyles:     ${Object.keys(db.textStyles).length}`)
    console.log(`  components:     ${Object.keys(db.components).length}`)
    console.log(`  nodeTemplates:  ${Object.keys(db.nodeTemplates).length}`)
    console.log(`  scenes:         ${Object.keys(db.scenes).length}`)
  } else {
    console.error('✗ Validation failed')
    const flat = result.error.flatten()
    if (verbose) {
      console.error(JSON.stringify(result.error.issues, null, 2))
    } else {
      const fieldErrors = Object.entries(flat.fieldErrors)
      for (const [field, msgs] of fieldErrors.slice(0, 20)) {
        console.error(`  ${field}: ${(msgs as string[]).join(', ')}`)
      }
      if (fieldErrors.length > 20) {
        console.error(`  … and ${fieldErrors.length - 20} more`)
      }
      if (flat.formErrors.length > 0) {
        console.error(`  Form errors: ${flat.formErrors.join(', ')}`)
      }
      console.error('\nRun with --verbose for full error details.')
    }
    process.exit(1)
  }
}
