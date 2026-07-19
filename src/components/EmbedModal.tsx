import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGraphStore } from '@/stores/graphStore'
import { encodeCompactHash } from '@/utils/sombra-file'
import { publishScene, type PublishResult } from '@/embed/publish'
import { mount, type SceneHandle } from '@/embed/player'

type Tab = 'copy' | 'dev' | 'advanced'

export function EmbedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('copy')
  const [result, setResult] = useState<PublishResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneHandle | null>(null)

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
  }, [open])

  // Live preview using the in-repo player (no built bundle needed in dev).
  useEffect(() => {
    if (!open || !result || !previewRef.current) return
    let disposed = false
    previewRef.current.innerHTML = ''
    mount(previewRef.current, { scene: result.sceneB64 }).then((h) => {
      if (disposed) h.destroy(); else handleRef.current = h
    })
    return () => { disposed = true; handleRef.current?.destroy(); handleRef.current = null }
  }, [open, result])

  const sizeKb = useMemo(() => result ? (result.sizeBytes / 1024).toFixed(1) : '0', [result])
  const heavy = !!result && result.sizeBytes > 200 * 1024

  // Group knobs by owning node so the list is readable even when many nodes
  // expose same-named params (scale, seed, offset…).
  const grouped = useMemo(() => {
    const m = new Map<string, PublishResult['manifest']>()
    for (const k of result?.manifest ?? []) {
      const arr = m.get(k.node) ?? []
      arr.push(k)
      m.set(k.node, arr)
    }
    return [...m.entries()]
  }, [result])

  if (!open) return null
  const snippet = result ? (tab === 'copy' ? result.snippets.copyPaste : tab === 'dev' ? result.snippets.developer : result.snippets.iframe) : ''
  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500) })
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

        <div className="flex gap-2 mb-3">
          {(['copy', 'dev', 'advanced'] as Tab[]).map((t) => (
            <button key={t}
              className={`px-3 py-1 rounded text-sm ${tab === t ? 'bg-indigo text-fg' : 'bg-surface-raised text-fg-dim'}`}
              onClick={() => setTab(t)}>
              {t === 'copy' ? 'Copy-paste' : t === 'dev' ? 'Developer' : 'Advanced'}
            </button>
          ))}
        </div>

        <div className="text-xs text-fg-subtle mb-2">
          Payload: {sizeKb} KB {heavy && <span className="text-amber-400">— large; consider downscaling baked images</span>}
        </div>

        <pre className="bg-surface-raised text-fg-dim text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">{snippet}</pre>
        <button className="mt-2 px-3 py-1 rounded bg-indigo text-fg text-sm" onClick={() => copy(snippet, tab)}>
          {copied === tab ? 'Copied ✓' : 'Copy'}
        </button>

        {tab === 'dev' && result && (
          <div className="mt-4">
            <div className="text-sm text-fg-dim mb-1">Knobs ({result.manifest.length})</div>
            <table className="w-full text-xs text-fg-dim">
              <thead><tr className="text-fg-subtle text-left"><th>param</th><th>key</th><th>type</th><th>range</th><th>example</th></tr></thead>
              <tbody>
                {grouped.map(([node, knobs]) => (
                  <Fragment key={node}>
                    <tr><td colSpan={5} className="pt-3 pb-1 text-fg font-medium">{node}</td></tr>
                    {knobs.map((k) => (
                      <tr key={k.key}>
                        <td className="pl-2">{k.label}</td>
                        <td className="font-mono">{k.key}</td>
                        <td>{k.type}</td>
                        <td>{k.min ?? '—'} … {k.max ?? '—'}</td>
                        <td className="font-mono">shader.set('{k.key}', {k.type === 'color' ? '[1,0,0]' : (k.max ?? 1)})</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
