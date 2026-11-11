/**
 * Site-conformance checklist, static half (feature request §6.3, C1..C8): what
 * a host site needs from a `.ombra`, judged from the file alone.
 *
 * Plain TS with no node:* and no DOM imports, so an editor-side module (a
 * future "Publish for site" preset, SR-13) can reuse it as is. It reads the
 * artifact through the player's own decoder. The player bundle must NOT import
 * it — this is editor/tooling code (verify-embed-bundle.ts guards the player's
 * import graph).
 *
 *   C1 Decodes      inflates; v === 1; kind === 'frozen'; plan.success; ≥ 1 pass
 *   C2 Palette      ≥ 2 knobs `site-palette-stop-<n>`, n contiguous from 0,
 *                   type 'color', glslType 'vec4', 4-component defaults
 *   C3 Field alpha  `fragment-output-alpha` exists, type 'float'
 *   C4 Balance      `site-balance-value` exists (warn if missing)
 *   C5 Seed         `site-seed-value` exists (warn if missing)
 *   C6 No clashes   no `site-*` key carries a de-dup suffix from a duplicate label
 *   C7 Quality      plan.qualityTier 'high' | 'medium' (warn on adaptive / low)
 *   C8 Info         pass count, bytes, images, WGSL present, randomizeOnLoad
 */
import { decodeArtifactBytes, type SceneArtifact, type KnobDescriptor } from '../../src/embed/artifact'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info'
export interface CheckRow { id: string; title: string; status: CheckStatus; detail: string }
export interface SiteReport { rows: CheckRow[]; ok: boolean; artifact?: SceneArtifact }

const PALETTE_RE = /^site-palette-stop-(\d+)$/

/** Run C1..C8 over the raw `.ombra` bytes. `ok` is false iff any row failed. */
export function checkSiteArtifact(bytes: Uint8Array): SiteReport {
  const rows: CheckRow[] = []
  const row = (id: string, title: string, status: CheckStatus, detail: string) => rows.push({ id, title, status, detail })

  // ── C1 ─────────────────────────────────────────────────────────────────────
  let a: SceneArtifact
  try {
    a = decodeArtifactBytes(bytes)
  } catch (e) {
    row('C1', 'Decodes', 'fail', `does not inflate/parse: ${e instanceof Error ? e.message : String(e)}`)
    return { rows, ok: false }
  }
  const c1: string[] = []
  if (a?.v !== 1) c1.push(`v = ${JSON.stringify(a?.v)}`)
  if (a?.kind !== 'frozen') c1.push(`kind = ${JSON.stringify(a?.kind)}`)
  if (a?.plan?.success !== true) c1.push('plan.success is not true')
  const passes = Array.isArray(a?.plan?.passes) ? a.plan.passes.length : 0
  if (passes < 1) c1.push('no passes')
  if (!Array.isArray(a?.manifest)) c1.push('no manifest array')
  row('C1', 'Decodes', c1.length ? 'fail' : 'pass', c1.length ? c1.join('; ') : `v1 frozen, ${passes} pass(es)`)
  if (c1.length) return { rows, ok: false, artifact: a }

  const manifest: KnobDescriptor[] = a.manifest
  const byKey = new Map(manifest.map((k) => [k.key, k]))

  // ── C2 ─────────────────────────────────────────────────────────────────────
  const stops = manifest
    .map((k) => ({ k, m: PALETTE_RE.exec(k.key) }))
    .filter((x): x is { k: KnobDescriptor; m: RegExpExecArray } => x.m !== null)
    .map(({ k, m }) => ({ k, n: Number(m[1]) }))
    .sort((x, y) => x.n - y.n)
  const c2: string[] = []
  if (stops.length < 2) c2.push(`${stops.length} stop knob(s), need ≥ 2`)
  stops.forEach(({ n }, i) => { if (n !== i) c2.push(`stop indices not contiguous from 0 (${stops.map((s) => s.n).join(',')})`) })
  for (const { k } of stops) {
    if (k.type !== 'color' || k.glslType !== 'vec4') c2.push(`${k.key} is ${k.type}/${k.glslType}, need color/vec4`)
    if (!Array.isArray(k.default) || k.default.length !== 4) c2.push(`${k.key} default is not RGBA (${JSON.stringify(k.default)})`)
  }
  row('C2', 'Palette', c2.length ? 'fail' : 'pass',
    c2.length ? [...new Set(c2)].join('; ') : `${stops.length} stops: ${stops.map((s) => s.k.key).join(', ')}`)

  // ── C3 ─────────────────────────────────────────────────────────────────────
  const alpha = byKey.get('fragment-output-alpha')
  row('C3', 'Field alpha', alpha && alpha.type === 'float' ? 'pass' : 'fail',
    alpha ? `fragment-output-alpha: ${alpha.type}` : 'fragment-output-alpha missing (Fragment Output alpha wired or absent?)')

  // ── C4 / C5 (optional roles) ───────────────────────────────────────────────
  for (const [id, title, key] of [['C4', 'Balance', 'site-balance-value'], ['C5', 'Seed', 'site-seed-value']] as const) {
    const k = byKey.get(key)
    row(id, title, k ? 'pass' : 'warn', k ? `${key}: ${k.type}, default ${JSON.stringify(k.default)}` : `${key} missing (optional role)`)
  }

  // ── C6 ─────────────────────────────────────────────────────────────────────
  // A duplicate custom label is de-duplicated " 2", " 3" in graph order
  // (manifest.ts buildNodeNames), so the clash shows as a named node whose
  // display name is "<label> <k>" while another named node owns "<label>".
  const namedNodes = new Map<string, string>()   // nodeId → display name, named knobs under site-*
  for (const k of manifest) if (k.key.startsWith('site-')) namedNodes.set(k.nodeId, k.node)
  const names = new Set(namedNodes.values())
  const clashes = [...namedNodes.values()].filter((name) => {
    const m = /^(.*) (\d+)$/.exec(name)
    return m !== null && Number(m[2]) >= 2 && names.has(m[1])
  })
  const unnamedSite = manifest.filter((k) => k.key.startsWith('site-') && 'named' in k && k.named !== true)
  const c6 = [
    ...clashes.map((n) => `"${n}" is a de-duplicated copy of another node's label`),
    ...unnamedSite.map((k) => `${k.key} starts with site- but its node is not author-named`),
  ]
  row('C6', 'No clashes', c6.length ? 'fail' : 'pass',
    c6.length ? c6.join('; ') : `${namedNodes.size} site-* node(s), no duplicate labels`)

  // ── C7 ─────────────────────────────────────────────────────────────────────
  const tier = a.plan.qualityTier ?? 'adaptive'
  row('C7', 'Quality', tier === 'high' || tier === 'medium' ? 'pass' : 'warn',
    `qualityTier ${tier}${tier === 'high' || tier === 'medium' ? '' : ' — set Render Quality to High (or Medium) before publishing'}`)

  // ── C8 (info) ──────────────────────────────────────────────────────────────
  const wgsl = !!a.plan.wgsl?.passes?.length
  row('C8', 'Info', 'info', [
    `${passes} pass(es)`, `${bytes.length} B`, `${a.images?.length ?? 0} image(s)`,
    `WGSL ${wgsl ? 'present' : 'absent (plays on WebGL2 only)'}`,
    `randomizeOnLoad ${a.randomizeOnLoad?.length ? [...new Set(a.randomizeOnLoad)].join(',') : 'absent'}`,
    `${manifest.length} knobs`,
  ].join(' · '))

  return { rows, ok: rows.every((r) => r.status !== 'fail'), artifact: a }
}

/** Fixed-width text table of a report (for the CLI). */
export function formatSiteReport(rows: CheckRow[]): string {
  const tag: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' }
  const w = Math.max(...rows.map((r) => r.title.length))
  return rows.map((r) => `  ${r.id.padEnd(3)} ${r.title.padEnd(w)}  ${tag[r.status]}  ${r.detail}`).join('\n')
}
