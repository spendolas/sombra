/**
 * audit-collect.ts — Collects fresh Figma Plugin API data via Chrome CDP.
 *
 * Connects to the running Chrome instance (via Playwright CDP), finds the
 * open Figma tab, injects a Plugin API snippet, and writes the results to
 * tokens/.figma-vars-cache.json.
 *
 * Requires Chrome to be running with --remote-debugging-port (default 9222).
 * Set CHROME_DEBUG_PORT env var to override.
 *
 * Usage:
 *   npx tsx scripts/audit-collect.ts
 */

import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '..')
const CACHE_PATH = resolve(ROOT, 'tokens/.figma-vars-cache.json')
const CDP_PORT = Number(process.env.CHROME_DEBUG_PORT || 9222)

// ─── Plugin API snippet ─────────────────────────────────────────────────────
// Runs in the Figma page context. Returns a JSON-serializable object with
// all variables, text styles (with OT features), effect styles, and
// per-component text style assignments.

const COLLECT_SNIPPET = `
(async () => {
  // ── Variables ──
  const vars = await figma.variables.getLocalVariablesAsync();
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const colMap = {};
  for (const col of collections)
    colMap[col.id] = { name: col.name, mid: col.modes[0].modeId };

  const variables = [];
  for (const v of vars) {
    const col = colMap[v.variableCollectionId];
    const raw = v.valuesByMode[col.mid];
    variables.push({
      id: v.id,
      name: v.name,
      collection: col.name,
      type: v.resolvedType,
      value: raw,
    });
  }

  // ── Text styles ──
  const textStylesRaw = await figma.getLocalTextStylesAsync();
  const textStyles = [];
  for (const s of textStylesRaw) {
    textStyles.push({
      id: s.id,
      key: s.key,
      name: s.name,
      fontSize: s.fontSize,
      fontFamily: s.fontName?.family,
      fontStyle: s.fontName?.style,
      lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing,
      textCase: s.textCase,
      textDecoration: s.textDecoration,
      openTypeFeatures: s.openTypeFeatures || {},
    });
  }

  // Build style ID → name map for component lookups
  const styleIdToName = {};
  for (const s of textStylesRaw) styleIdToName[s.id] = s.name;

  // ── Effect styles ──
  const effectStylesRaw = await figma.getLocalEffectStylesAsync();
  const effectStyles = [];
  for (const e of effectStylesRaw) {
    effectStyles.push({
      id: e.id,
      key: e.key,
      name: e.name,
      effects: e.effects.map(ef => ({
        type: ef.type,
        visible: ef.visible,
        color: ef.color ? {
          r: Math.round(ef.color.r * 255),
          g: Math.round(ef.color.g * 255),
          b: Math.round(ef.color.b * 255),
          a: ef.color.a,
        } : null,
        offset: ef.offset || null,
        radius: ef.radius ?? null,
        spread: ef.spread ?? null,
      })),
    });
  }

  // ── Paint styles ──
  const paintStylesRaw = await figma.getLocalPaintStylesAsync();
  const paintStyles = paintStylesRaw.map(p => ({
    id: p.id,
    key: p.key,
    name: p.name,
    paints: p.paints.map(f => ({ type: f.type, visible: f.visible ?? true })),
  }));

  // ── Component text style assignments ──
  // For each component, find text children and report their text style + OT features
  function findAll(node, types) {
    const found = [];
    if (types.includes(node.type)) found.push(node);
    if ('children' in node) {
      for (const c of node.children) found.push(...findAll(c, types));
    }
    return found;
  }

  const allComps = [];
  for (const page of figma.root.children) {
    const comps = findAll(page, ['COMPONENT_SET', 'COMPONENT']);
    for (const c of comps) {
      if (c.type === 'COMPONENT' && c.parent?.type === 'COMPONENT_SET') continue;
      allComps.push(c);
    }
  }

  const componentTextMap = {};
  for (const comp of allComps) {
    const target = comp.type === 'COMPONENT_SET' && comp.children?.length
      ? comp.children[0] : comp;
    const texts = findAll(target, ['TEXT']);
    const textEntries = [];
    for (const t of texts) {
      const sid = t.textStyleId;
      const styleName = sid ? (styleIdToName[sid] || null) : null;
      let otfKeys = [];
      try {
        const len = Math.max(1, t.characters.length);
        const ot = t.getRangeOpenTypeFeatures(0, len);
        otfKeys = Object.entries(ot)
          .filter(([k, v]) => v === true)
          .map(([k]) => k);
      } catch {}
      textEntries.push({
        name: t.name,
        textStyle: styleName,
        fontSize: t.fontSize,
        fontWeight: t.fontName?.style,
        opentypeFeatures: otfKeys.length > 0 ? otfKeys : undefined,
      });
    }
    if (textEntries.length > 0) {
      componentTextMap[comp.id] = {
        name: comp.name,
        texts: textEntries,
      };
    }
  }

  return JSON.stringify({
    collectedAt: new Date().toISOString(),
    variables,
    textStyles,
    effectStyles,
    paintStyles,
    componentTextMap,
  });
})()
`

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Figma audit:collect — Plugin API via Chrome CDP')
  console.log('================================================\n')

  // Try to connect to Chrome via CDP
  let browser
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`)
  } catch {
    console.error(
      `Could not connect to Chrome on port ${CDP_PORT}.\n\n` +
      `Open the Sombra Figma file in Chrome before running audit:full.\n\n` +
      `To enable CDP, start Chrome with:\n` +
      `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${CDP_PORT}\n\n` +
      `Or set CHROME_DEBUG_PORT env var to a different port.`
    )
    process.exit(1)
  }

  // Find the Figma tab
  const contexts = browser.contexts()
  let figmaPage = null
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.url().includes('figma.com/design')) {
        figmaPage = page
        break
      }
    }
    if (figmaPage) break
  }

  if (!figmaPage) {
    console.error(
      'No Figma design tab found in Chrome.\n\n' +
      'Open the Sombra Figma file in Chrome before running audit:full.'
    )
    await browser.close()
    process.exit(1)
  }

  console.log(`Found Figma tab: ${figmaPage.url()}\n`)

  // Inject the Plugin API snippet
  console.log('Collecting variables, text styles, effects, components...')
  let result: string
  try {
    result = await figmaPage.evaluate(COLLECT_SNIPPET) as string
  } catch (err) {
    console.error(
      `Failed to execute Plugin API snippet.\n` +
      `Make sure the Figma file is fully loaded and you have edit access.\n\n` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    )
    await browser.close()
    process.exit(1)
  }

  // Parse and validate
  const data = JSON.parse(result)

  // Write cache file
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8')

  const varCount = data.variables?.length ?? 0
  const textCount = data.textStyles?.length ?? 0
  const effectCount = data.effectStyles?.length ?? 0
  const compCount = Object.keys(data.componentTextMap ?? {}).length ?? 0

  console.log(`\n✓ Cache written to tokens/.figma-vars-cache.json`)
  console.log(`  Timestamp: ${data.collectedAt}`)
  console.log(`  Variables: ${varCount}`)
  console.log(`  Text styles: ${textCount}`)
  console.log(`  Effect styles: ${effectCount}`)
  console.log(`  Components with text: ${compCount}`)

  await browser.close()
}

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
