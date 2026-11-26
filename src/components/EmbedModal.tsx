import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGraphStore } from '@/stores/graphStore'
import { encodeCompactHash } from '@/utils/sombra-file'
import { publishScene, type PublishResult } from '@/embed/publish'
import { mount, type SceneHandle } from '@/embed/player'
import type { KnobDescriptor } from '@/embed/artifact'
import type { KnobEntry, KnobNameClash } from '@/embed/manifest'
import { icons } from '@/components/icons'
import { KnobTable, type KnobTableItem } from '@/components/KnobTable'

/** The one clipboard write the modal uses — snippet buttons and knob keys alike. */
const writeClipboard = (text: string) => navigator.clipboard.writeText(text)

const KNOB_FOOTNOTE = 'Named nodes come first and keep their key in every scene. Double-click a node’s title to name it; rename a knob here.'

/** Row id ↔ the knob's editor address. Node ids never contain a NUL. */
const SEP = '\u0000'
const rowIdOf = (nodeId: string, paramId: string) => `${nodeId}${SEP}${paramId}`
const addressOf = (id: string) => { const i = id.indexOf(SEP); return { nodeId: id.slice(0, i), paramId: id.slice(i + 1) } }

/** What a knob-table edit can change: names and hide flags (a cheap re-publish key). */
const knobSignature = (nodes: { id: string; data: { knobs?: unknown } }[]) =>
  JSON.stringify(nodes.filter((n) => n.data.knobs).map((n) => [n.id, n.data.knobs]))

/**
 * Manifest → table rows, in manifest (graph) order; the table lists named rows
 * first. Fragment Output's knobs ride with the named ones (board 993:3778: "it
 * is always public" — its key never depends on the rest of the graph). Keys of
 * a node numbered by a name clash carry the clash mark.
 */
function knobRows(entries: KnobEntry[], clashes: KnobNameClash[]): KnobTableItem[] {
  const numbered = new Set(clashes.map((c) => c.nodeId))
  return entries.map(({ knob: k, paramId, defaultName, hidden, nameClash }) => ({
    id: rowIdOf(k.nodeId, paramId),
    key: k.key, type: k.type, default: k.default, min: k.min, max: k.max,
    named: k.named === true || k.nodeType === 'fragment_output',
    name: k.label,
    defaultName,
    // The key minus its name part, for the live preview while typing.
    ...(k.key.endsWith(k.param) ? { keyPrefix: k.key.slice(0, k.key.length - k.param.length) } : {}),
    ...(hidden ? { hidden: true } : {}),
    ...(numbered.has(k.nodeId) ? { clash: true } : nameClash ? { clash: true, clashNote: 'name taken, numbered' } : {}),
  }))
}

const COUNT = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']
const listOf = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/**
 * The name-clash notice (board wording, Figma 994:5360): "Two nodes are named
 * “site.balance”. The second one publishes as site-balance-2-value. Rename one
 * of them so each key stays the one you meant." One sentence per clashing name.
 */
function clashNotice(manifest: KnobDescriptor[], clashes: KnobNameClash[]): string | undefined {
  if (clashes.length === 0) return undefined
  const groups = new Map<string, KnobNameClash[]>()
  for (const c of clashes) groups.set(c.heldBy, [...(groups.get(c.heldBy) ?? []), c])
  const keysOf = (id: string) => manifest.filter((k) => k.nodeId === id).map((k) => k.key)
  const parts: string[] = []
  let many = false
  for (const [label, cs] of groups) {
    const n = cs.length + 1
    many ||= n > 2
    const keys = cs.flatMap((c) => keysOf(c.nodeId))
    parts.push(`${COUNT[n] ?? n} nodes are named “${label}”.`)
    parts.push(cs.length === 1 ? `The second one publishes as ${listOf(keys)}.` : `The later ones publish as ${listOf(keys)}.`)
  }
  parts.push(many || groups.size > 1
    ? 'Rename them so each key stays the one you meant.'
    : 'Rename one of them so each key stays the one you meant.')
  return parts.join(' ')
}

export function EmbedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)
  // Knob names / hide flags change the manifest (keys, what is published), never the picture.
  const knobSig = useGraphStore((s) => knobSignature(s.nodes))
  const setKnobOverride = useGraphStore((s) => s.setKnobOverride)

  useEffect(() => {
    if (!open) return
    setError(null)
    try {
      const { nodes, edges } = useGraphStore.getState()
      const hash = encodeCompactHash(nodes, edges)
      setResult(publishScene(nodes, edges, hash))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    }
  }, [open, knobSig])

  // The preview shows the same picture whatever the knob names are, so it is
  // mounted once per opening (from the first result), not on every rename.
  const [previewScene, setPreviewScene] = useState<string | null>(null)
  useEffect(() => { if (!open) setPreviewScene(null) }, [open])
  useEffect(() => { if (open && result && previewScene === null) setPreviewScene(result.sceneB64) }, [open, result, previewScene])

  // Live preview using the in-repo player (no built bundle needed in dev).
  useEffect(() => {
    if (!open || !previewScene || !previewRef.current) return
    let disposed = false
    previewRef.current.innerHTML = ''
    mount(previewRef.current, { scene: previewScene }).then((h) => {
      if (disposed) h.destroy(); else handleRef.current = h
    })
    return () => { disposed = true; handleRef.current?.destroy(); handleRef.current = null }
  }, [open, previewScene])

  const sizeKb = useMemo(() => result ? (result.sizeBytes / 1024).toFixed(1) : '0', [result])
  const fileKb = useMemo(() => result ? (result.fileBytes / 1024).toFixed(1) : '0', [result])
  const heavy = !!result && result.fileBytes > 200 * 1024
  const knobs = useMemo(() => result ? knobRows(result.knobs, result.clashes) : [], [result])
  const notice = useMemo(() => result ? clashNotice(result.manifest, result.clashes) : undefined, [result])

  if (!open) return null
  const copy = (text: string, which: string) => {
    void writeClipboard(text).then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500) })
  }
  const download = () => {
    if (!result) return
    const url = URL.createObjectURL(new Blob([new Uint8Array(result.sceneBytes)], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'scene.ombra'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Portal to <body> so the overlay escapes the React Flow viewport's transformed
  // stacking context — otherwise z-index can't lift it above the preview canvas.
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[720px] max-w-[92vw] max-h-[88vh] overflow-auto rounded-lg bg-surface-alt p-5 text-fg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-fg font-medium">Embed shader</h2>
          <button className="text-fg-subtle hover:text-fg" onClick={onClose}>✕</button>
        </div>

        {error && <div className="text-red-400 text-sm mb-3">{error}</div>}

        <div ref={previewRef} className="w-full aspect-video bg-black rounded mb-3" />

        {/* Hosted (primary): download the compiled .ombra file, host it anywhere, paste this.
            (.ombra = compiled shader for the player; .sombra = editable graph for the editor.) */}
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-fg-subtle">
            Hosted file: {fileKb} KB {heavy && <span className="text-amber-400">— large; consider downscaling baked images</span>}
          </div>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded bg-indigo text-fg text-xs hover:bg-indigo-hover"
            onClick={download}
          >
            <icons.download className="w-3.5 h-3.5" /> Download .ombra
          </button>
        </div>
        <div className="relative">
          <pre className="bg-surface-raised text-fg-dim text-xs p-3 pr-10 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">{result?.snippets.hosted ?? ''}</pre>
          <button
            className="absolute top-2 right-2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-elevated"
            title="Copy embed snippet" aria-label="Copy embed snippet"
            onClick={() => result && copy(result.snippets.hosted, 'hosted')}
          >
            {copied === 'hosted' ? <icons.check className="w-4 h-4 text-success" /> : <icons.copy className="w-4 h-4" />}
          </button>
        </div>
        <div className="text-xs text-fg-subtle mt-1">
          Host the file anywhere and replace the URL. If it's on a different domain than the page, it must send <code className="font-mono">Access-Control-Allow-Origin</code>.
        </div>

        {result && (
          <div className="mt-4" data-section="control">
            <div className="text-sm text-fg-dim mb-1">Control it from JavaScript (optional — same embed)</div>
            <div className="relative">
              <pre className="bg-surface-raised text-fg-dim text-xs p-3 pr-10 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">{result.snippets.control}</pre>
              <button
                className="absolute top-2 right-2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-elevated"
                title="Copy control snippet" aria-label="Copy control snippet"
                onClick={() => copy(result.snippets.control, 'control')}
              >
                {copied === 'control' ? <icons.check className="w-4 h-4 text-success" /> : <icons.copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-xs text-fg-subtle mt-1">
              List controllable params at runtime with <code className="font-mono">shader.nodes()</code>, then drive them via <code className="font-mono">shader.set(nodeId, param, value)</code>.
            </div>
            {/* The keys shader.set() takes, next to the code that uses them (Figma 993:3778). */}
            <KnobTable
              knobs={knobs} notice={notice} footnote={KNOB_FOOTNOTE} onCopy={writeClipboard}
              onRename={(id, name) => { const a = addressOf(id); setKnobOverride(a.nodeId, a.paramId, { name }) }}
              onToggleHidden={(id, hidden) => { const a = addressOf(id); setKnobOverride(a.nodeId, a.paramId, { hidden }) }}
            />
          </div>
        )}

        {/* Inline: the whole scene in the attribute — no hosting, bigger snippet. */}
        {result && (
          <details className="mt-4">
            <summary className="text-sm text-fg-dim cursor-pointer select-none hover:text-fg">Inline — self-contained, no hosting ({sizeKb} KB in the tag)</summary>
            <div className="relative mt-2">
              <pre className="bg-surface-raised text-fg-dim text-xs p-3 pr-10 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">{result.snippets.embed}</pre>
              <button
                className="absolute top-2 right-2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-elevated"
                title="Copy inline snippet" aria-label="Copy inline snippet"
                onClick={() => copy(result.snippets.embed, 'embed')}
              >
                {copied === 'embed' ? <icons.check className="w-4 h-4 text-success" /> : <icons.copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-xs text-fg-subtle mt-2">The entire scene lives in the tag — no file to host, but a large string. Best for small scenes.</div>
          </details>
        )}

        {/* Isolated iframe fallback — a peripheral option, collapsed by default. */}
        {result && (
          <details className="mt-4">
            <summary className="text-sm text-fg-dim cursor-pointer select-none hover:text-fg">Advanced — isolated iframe (strict-CSP hosts, no JS control)</summary>
            <div className="relative mt-2">
              <pre className="bg-surface-raised text-fg-dim text-xs p-3 pr-10 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">{result.snippets.iframe}</pre>
              <button
                className="absolute top-2 right-2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-elevated"
                title="Copy iframe snippet" aria-label="Copy iframe snippet"
                onClick={() => copy(result.snippets.iframe, 'iframe')}
              >
                {copied === 'iframe' ? <icons.check className="w-4 h-4 text-success" /> : <icons.copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-xs text-fg-subtle mt-2">Fully sandboxed — heaviest at runtime and exposes no knob API. Use for strict-CSP hosts or paste-and-forget.</div>
          </details>
        )}
      </div>
    </div>,
    document.body,
  )
}
