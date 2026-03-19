/**
 * token-hero-audit.ts — Token Hero binding audit for Sombra.
 *
 * Connects to the Token Hero bridge WebSocket, queries Figma component
 * properties via Flow 1 (GET_COMPONENT_PROPERTIES), compares against
 * sombra.ds.json, and outputs AuditFinding[] JSON to stdout.
 *
 * Usage:
 *   npx tsx scripts/token-hero-audit.ts                        # full audit
 *   npx tsx scripts/token-hero-audit.ts --component nodeCard   # scoped audit
 *   npx tsx scripts/token-hero-audit.ts --port 7800            # custom port
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditFinding {
  figmaNodeId: string
  layerId: string
  layerName: string
  componentName: string
  divergenceType: DivergenceType
  figmaValue: string | number
  browserValue: string | number | null
  expectedToken: string | null
  actualToken: string | null
  suggestedFix?: SuggestedFix
}

type DivergenceType =
  | 'CASCADE_LOSS'
  | 'WRONG_TOKEN'
  | 'TOKEN_MISSING'
  | 'NOT_APPLIED'
  | 'UNRECORDED_VARIANT_DELTA'
  | 'REMOVED_NESTED'

type SuggestedFix =
  | { op: 'rebind'; targetTokenName: string; targetTokenId: string; property: string }
  | { op: 'create_token'; suggestedName: string; suggestedValue: string | number; collection: string }
  | { op: 'patch_json'; patch: PatchOp[] }

interface PatchOp {
  op: 'replace' | 'add' | 'remove'
  path: string
  value?: unknown
}

interface LayerProperty {
  value: string | number
  tokenId: string | null
  tokenName: string | null
  isBound: boolean
  isOverridden: boolean
}

interface Layer {
  layerId: string
  layerName: string
  properties: Record<string, LayerProperty>
}

interface ComponentResult {
  nodeId: string
  componentName: string
  figmaFileKey: string
  isComponentSet: boolean
  layers?: Layer[]
  variants?: Record<string, { variantNodeId: string; layers: Layer[] }>
}

interface BridgeMessage {
  id: string
  protocolVersion: number
  type: string
  payload: unknown
  timestamp: number
}

interface TokenEntry {
  figmaName: string
  variableId: string
  value: string | number
}

interface PartDef {
  figmaNodeId?: string
  auditIgnore?: string[]
  fill?: string
  stroke?: { color?: string; weight?: number; side?: string }
  radius?: string | { top?: string; bottom?: string }
  padding?: string | { x?: string; y?: string; top?: string; bottom?: string; left?: string; right?: string }
  gap?: string | { x?: string; y?: string }
  textStyle?: string
  textColor?: string
  width?: string | number
  height?: string | number
  layout?: string
  align?: string
  justify?: string
  overflow?: string
  position?: string
  extra?: string
  hover?: unknown
  userSelect?: string
  [key: string]: unknown
}

interface ComponentDef {
  name: string
  type: string
  dsKey: string
  codeFile: string
  parts: Record<string, PartDef>
  variants?: Record<string, Record<string, string>>
}

interface SombraDB {
  version: number
  figmaFileKey: string
  colors: Record<string, { figmaName: string; value: string }>
  portColors?: Record<string, unknown>
  spacing: Record<string, { figmaName: string; value: number }>
  radius: Record<string, { figmaName: string; value: number }>
  sizes: Record<string, { figmaName: string; value: number }>
  textStyles: Record<string, { figmaName: string; utility: string; properties: Record<string, unknown> }>
  components: Record<string, ComponentDef>
}

// ─── Config ─────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..')
const DB_PATH = resolve(ROOT, 'tokens/sombra.ds.json')

const portIdx = process.argv.indexOf('--port')
const PORT = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 7799

const compIdx = process.argv.indexOf('--component')
const SCOPED_KEY = compIdx !== -1 ? process.argv[compIdx + 1] : null

// ─── Load token source ──────────────────────────────────────────────────────

const db: SombraDB = JSON.parse(readFileSync(DB_PATH, 'utf-8'))

// ─── Build token lookup maps ────────────────────────────────────────────────
// Maps: shortName → { variableId, figmaName }

const colorsByName = new Map<string, TokenEntry>()
for (const [varId, tok] of Object.entries(db.colors)) {
  colorsByName.set(tok.figmaName, { figmaName: tok.figmaName, variableId: varId, value: tok.value })
}

const radiusByShort = new Map<string, TokenEntry>()
for (const [varId, tok] of Object.entries(db.radius)) {
  // figmaName is like "md/8" — short name is "md"
  const short = tok.figmaName.split('/')[0]
  radiusByShort.set(short, { figmaName: tok.figmaName, variableId: varId, value: tok.value })
}

const spacingByShort = new Map<string, TokenEntry>()
for (const [varId, tok] of Object.entries(db.spacing)) {
  // figmaName is like "md/8", "spacing/2xs", "handle-offset/10"
  const parts = tok.figmaName.split('/')
  // For "spacing/2xs" → short = "2xs"; for "md/8" → short = "md"
  const short = parts[0] === 'spacing' ? parts[1] : parts[0]
  spacingByShort.set(short, { figmaName: tok.figmaName, variableId: varId, value: tok.value })
}

const sizesByName = new Map<string, TokenEntry>()
for (const [varId, tok] of Object.entries(db.sizes)) {
  // figmaName is like "handle", "icon/sm", "select/h"
  sizesByName.set(tok.figmaName, { figmaName: tok.figmaName, variableId: varId, value: tok.value })
  // Also map dash-separated form: "select-h" → "select/h"
  const dashForm = tok.figmaName.replace(/\//g, '-')
  if (dashForm !== tok.figmaName) {
    sizesByName.set(dashForm, { figmaName: tok.figmaName, variableId: varId, value: tok.value })
  }
}

const textStylesByUtility = new Map<string, { figmaName: string; properties: Record<string, unknown> }>()
for (const [, ts] of Object.entries(db.textStyles)) {
  textStylesByUtility.set(ts.utility, { figmaName: ts.figmaName, properties: ts.properties })
}

// ─── Token resolution ───────────────────────────────────────────────────────

type TokenCollection = 'colors' | 'radius' | 'spacing' | 'sizes'

function resolveToken(shortName: string, collection: TokenCollection): TokenEntry | null {
  switch (collection) {
    case 'colors':
      return colorsByName.get(shortName) ?? null
    case 'radius':
      return radiusByShort.get(shortName) ?? null
    case 'spacing':
      return spacingByShort.get(shortName) ?? null
    case 'sizes':
      return sizesByName.get(shortName) ?? null
  }
}

// ─── Property mapping ───────────────────────────────────────────────────────
// Maps sombra part properties to Figma layer property keys + token collection

interface PropertyCheck {
  figmaProp: string
  collection: TokenCollection
  expectedShortName: string
}

function getPropertyChecks(part: PartDef, ignoreList: string[]): PropertyCheck[] {
  const checks: PropertyCheck[] = []

  // Fill
  if (part.fill && !ignoreList.includes('fill')) {
    checks.push({ figmaProp: 'fill', collection: 'colors', expectedShortName: part.fill })
  }

  // Stroke color
  if (part.stroke && typeof part.stroke === 'object' && part.stroke.color && !ignoreList.includes('stroke')) {
    checks.push({ figmaProp: 'stroke', collection: 'colors', expectedShortName: part.stroke.color })
  }

  // Text color (maps to fill on text nodes)
  if (part.textColor && !ignoreList.includes('textColor')) {
    checks.push({ figmaProp: 'fill', collection: 'colors', expectedShortName: part.textColor })
  }

  // Corner radius
  if (part.radius && !ignoreList.includes('radius')) {
    if (typeof part.radius === 'string') {
      checks.push({ figmaProp: 'cornerRadius', collection: 'radius', expectedShortName: part.radius })
    } else {
      // Object form: { top: "md", bottom: "sm" } — check topLeftRadius
      if (part.radius.top) {
        checks.push({ figmaProp: 'cornerRadius', collection: 'radius', expectedShortName: part.radius.top })
      }
    }
  }

  // Padding
  if (part.padding && !ignoreList.includes('padding')) {
    if (typeof part.padding === 'string') {
      // Uniform padding — check all 4 sides
      for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
        checks.push({ figmaProp: side, collection: 'spacing', expectedShortName: part.padding })
      }
    } else {
      const p = part.padding
      if (p.x) {
        checks.push({ figmaProp: 'paddingLeft', collection: 'spacing', expectedShortName: p.x })
        checks.push({ figmaProp: 'paddingRight', collection: 'spacing', expectedShortName: p.x })
      }
      if (p.y) {
        checks.push({ figmaProp: 'paddingTop', collection: 'spacing', expectedShortName: p.y })
        checks.push({ figmaProp: 'paddingBottom', collection: 'spacing', expectedShortName: p.y })
      }
      if (p.top) checks.push({ figmaProp: 'paddingTop', collection: 'spacing', expectedShortName: p.top })
      if (p.bottom) checks.push({ figmaProp: 'paddingBottom', collection: 'spacing', expectedShortName: p.bottom })
      if (p.left) checks.push({ figmaProp: 'paddingLeft', collection: 'spacing', expectedShortName: p.left })
      if (p.right) checks.push({ figmaProp: 'paddingRight', collection: 'spacing', expectedShortName: p.right })
    }
  }

  // Gap (itemSpacing)
  if (part.gap && !ignoreList.includes('gap')) {
    if (typeof part.gap === 'string') {
      checks.push({ figmaProp: 'itemSpacing', collection: 'spacing', expectedShortName: part.gap })
    } else {
      // Object form: { y: "md" } — y is the primary axis spacing
      const g = part.gap
      if (g.y) checks.push({ figmaProp: 'itemSpacing', collection: 'spacing', expectedShortName: g.y })
      if (g.x) checks.push({ figmaProp: 'itemSpacing', collection: 'spacing', expectedShortName: g.x })
    }
  }

  // Width/Height — only if they reference tokens (not literal values like "[32px]" or bare numbers)
  if (part.width && typeof part.width === 'string' && !part.width.startsWith('[') && !ignoreList.includes('width')) {
    if (part.width !== 'full' && part.width !== 'auto') {
      checks.push({ figmaProp: 'width', collection: 'sizes', expectedShortName: part.width })
    }
  }
  if (part.height && typeof part.height === 'string' && !part.height.startsWith('[') && !ignoreList.includes('height')) {
    if (part.height !== 'full' && part.height !== 'auto') {
      const sizeToken = resolveToken(part.height, 'sizes')
      if (sizeToken) {
        checks.push({ figmaProp: 'height', collection: 'sizes', expectedShortName: part.height })
      }
    }
  }

  return checks
}

// ─── Comparison logic ───────────────────────────────────────────────────────

function auditLayer(
  layer: Layer,
  partName: string,
  part: PartDef,
  componentName: string,
  componentNodeId: string,
): AuditFinding[] {
  const findings: AuditFinding[] = []
  const ignoreList = part.auditIgnore ?? []
  const checks = getPropertyChecks(part, ignoreList)

  for (const check of checks) {
    const figmaProp = layer.properties[check.figmaProp]
    const expectedToken = resolveToken(check.expectedShortName, check.collection)

    if (!expectedToken) {
      // Token reference in sombra.ds.json doesn't resolve — skip
      continue
    }

    if (!figmaProp) {
      // Property not present in Figma response (e.g., node doesn't have this property)
      continue
    }

    if (!figmaProp.isBound) {
      // Not bound to any variable → TOKEN_MISSING
      findings.push({
        figmaNodeId: componentNodeId,
        layerId: layer.layerId,
        layerName: layer.layerName + ' → ' + partName + '.' + check.figmaProp,
        componentName,
        divergenceType: 'TOKEN_MISSING',
        figmaValue: figmaProp.value,
        browserValue: null,
        expectedToken: expectedToken.figmaName,
        actualToken: null,
        suggestedFix: {
          op: 'rebind',
          targetTokenName: expectedToken.figmaName,
          targetTokenId: expectedToken.variableId,
          property: check.figmaProp === 'fill' || check.figmaProp === 'stroke' ? check.figmaProp + 's' : check.figmaProp,
        },
      })
    } else if (figmaProp.tokenId !== expectedToken.variableId) {
      // Bound to wrong variable → WRONG_TOKEN
      findings.push({
        figmaNodeId: componentNodeId,
        layerId: layer.layerId,
        layerName: layer.layerName + ' → ' + partName + '.' + check.figmaProp,
        componentName,
        divergenceType: 'WRONG_TOKEN',
        figmaValue: figmaProp.value,
        browserValue: null,
        expectedToken: expectedToken.figmaName,
        actualToken: figmaProp.tokenName,
        suggestedFix: {
          op: 'rebind',
          targetTokenName: expectedToken.figmaName,
          targetTokenId: expectedToken.variableId,
          property: check.figmaProp === 'fill' || check.figmaProp === 'stroke' ? check.figmaProp + 's' : check.figmaProp,
        },
      })
    }
    // else: correctly bound — no finding
  }

  return findings
}

// ─── WebSocket client ───────────────────────────────────────────────────────

function createMessage(type: string, payload: unknown): string {
  const msg: BridgeMessage = {
    id: randomUUID(),
    protocolVersion: 1,
    type,
    payload,
    timestamp: Date.now(),
  }
  return JSON.stringify(msg)
}

async function queryComponentProperties(
  ws: WebSocket,
  figmaNodeId: string,
  timeoutMs = 15000,
): Promise<ComponentResult | null> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const msg: BridgeMessage = {
      id: requestId,
      protocolVersion: 1,
      type: 'GET_COMPONENT_PROPERTIES',
      payload: { figmaNodeId, timeoutMs },
      timestamp: Date.now(),
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timeout querying ${figmaNodeId}`))
    }, timeoutMs + 2000)

    function onMessage(event: MessageEvent) {
      let data: BridgeMessage
      try {
        data = JSON.parse(String(event.data))
      } catch {
        return
      }

      if (data.id !== requestId) return

      if (data.type === 'COMPONENT_PROPERTIES_RESULT') {
        cleanup()
        const payload = data.payload as { nodeId: string } | null
        resolve(payload as ComponentResult | null)
      } else if (data.type === 'ERROR') {
        cleanup()
        const err = data.payload as { message?: string }
        reject(new Error(err?.message ?? 'Unknown error'))
      }
    }

    function cleanup() {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
    }

    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify(msg))
  })
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Filter components based on --component flag
  const targetComponents: Array<[string, ComponentDef]> = []

  for (const [compId, comp] of Object.entries(db.components)) {
    if (SCOPED_KEY) {
      if (comp.dsKey !== SCOPED_KEY && compId !== SCOPED_KEY) continue
    }
    targetComponents.push([compId, comp])
  }

  if (targetComponents.length === 0) {
    if (SCOPED_KEY) {
      process.stderr.write(`No component found for key: ${SCOPED_KEY}\n`)
      process.exit(1)
    }
    // No components at all — output empty findings
    process.stdout.write('[]')
    process.exit(0)
  }

  // Connect to bridge
  const url = `ws://127.0.0.1:${PORT}`
  let ws: WebSocket

  try {
    ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error(`WebSocket connection failed: ${url}`)))
      setTimeout(() => reject(new Error(`Connection timeout: ${url}`)), 5000)
    })
  } catch (err) {
    process.stderr.write(`Failed to connect to Token Hero bridge at ${url}\n`)
    process.stderr.write(`Make sure the bridge app is running.\n`)
    process.exit(1)
  }

  process.stderr.write(`Connected to bridge at ${url}\n`)
  process.stderr.write(`Auditing ${targetComponents.length} component(s)...\n`)

  const allFindings: AuditFinding[] = []

  for (const [compId, comp] of targetComponents) {
    // Get the root figmaNodeId for this component
    const rootPart = comp.parts.root ?? Object.values(comp.parts)[0]
    const rootNodeId = rootPart?.figmaNodeId ?? compId

    process.stderr.write(`  ${comp.name} (${rootNodeId})...`)

    let result: ComponentResult | null
    try {
      result = await queryComponentProperties(ws, rootNodeId)
    } catch (err) {
      process.stderr.write(` ERROR: ${(err as Error).message}\n`)
      continue
    }

    if (!result) {
      process.stderr.write(` not found in Figma\n`)
      continue
    }

    // Get all layers (flatten variants if component set)
    let allLayers: Layer[] = []
    if (result.isComponentSet && result.variants) {
      for (const variant of Object.values(result.variants)) {
        allLayers = allLayers.concat(variant.layers)
      }
    } else if (result.layers) {
      allLayers = result.layers
    }

    // Build layer lookup by ID
    const layerById = new Map<string, Layer>()
    for (const layer of allLayers) {
      layerById.set(layer.layerId, layer)
    }

    // Audit each part
    let partFindings = 0
    for (const [partName, part] of Object.entries(comp.parts)) {
      if (!part.figmaNodeId) continue

      const layer = layerById.get(part.figmaNodeId)
      if (!layer) {
        // Layer not found in Figma response — might be deeply nested or hidden
        continue
      }

      const findings = auditLayer(layer, partName, part, comp.name, rootNodeId)
      allFindings.push(...findings)
      partFindings += findings.length
    }

    process.stderr.write(` ${partFindings} finding(s)\n`)
  }

  // Close WebSocket
  ws.close()

  // Output findings as JSON to stdout
  process.stdout.write(JSON.stringify(allFindings))

  process.stderr.write(`\nTotal: ${allFindings.length} finding(s)\n`)
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`)
  process.exit(1)
})
