import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGraphStore } from '@/stores/graphStore'
import { encodeCompactHash } from '@/utils/sombra-file'
import { publishScene, type PublishResult } from '@/embed/publish'
import { mount, type SceneHandle } from '@/embed/player'
import { icons } from '@/components/icons'

export function EmbedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
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
  const fileKb = useMemo(() => result ? (result.fileBytes / 1024).toFixed(1) : '0', [result])
  const heavy = !!result && result.fileBytes > 200 * 1024

  if (!open) return null
  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text).then(() => { setCopied(which); setTimeout(() => setCopied(null), 1500) })
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
            {copied === 'hosted' ? <icons.check className="w-4 h-4" /> : <icons.copy className="w-4 h-4" />}
          </button>
        </div>
        <div className="text-xs text-fg-subtle mt-1">
          Host the file anywhere and replace the URL. If it's on a different domain than the page, it must send <code className="font-mono">Access-Control-Allow-Origin</code>.
        </div>

        {result && (
          <div className="mt-4">
            <div className="text-sm text-fg-dim mb-1">Control it from JavaScript (optional — same embed)</div>
            <div className="relative">
              <pre className="bg-surface-raised text-fg-dim text-xs p-3 pr-10 rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">{result.snippets.control}</pre>
              <button
                className="absolute top-2 right-2 p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-elevated"
                title="Copy control snippet" aria-label="Copy control snippet"
                onClick={() => copy(result.snippets.control, 'control')}
              >
                {copied === 'control' ? <icons.check className="w-4 h-4" /> : <icons.copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="text-xs text-fg-subtle mt-1">
              List controllable params at runtime with <code className="font-mono">shader.nodes()</code>, then drive them via <code className="font-mono">shader.set(nodeId, param, value)</code>.
            </div>
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
                {copied === 'embed' ? <icons.check className="w-4 h-4" /> : <icons.copy className="w-4 h-4" />}
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
                {copied === 'iframe' ? <icons.check className="w-4 h-4" /> : <icons.copy className="w-4 h-4" />}
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
