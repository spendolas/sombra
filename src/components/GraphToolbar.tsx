/**
 * GraphToolbar — the save/load/share/embed/export actions pill. Rendered as the
 * actions group inside NodesPanelOverlay's top-left cluster (it no longer owns a
 * React Flow Panel of its own — the overlay owns the single top-left Panel).
 */

import { useCallback, useState, lazy, Suspense } from 'react'
import { useReactFlow } from '@xyflow/react'
import { IconButton } from '@/components/IconButton'
import { useGraphStore } from '@/stores/graphStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { getFitViewPadding } from '@/components/nodes-panel-layout'
import {
  exportToFile,
  importFromFile,
  downloadSombraFile,
  openSombraFile,
  encodeCompactHash,
} from '@/utils/sombra-file'
import { normalizeGraphImages } from '@/utils/process-image'
import { ds } from '@/generated/ds'
import { EmbedModal } from '@/components/EmbedModal'

const ExportModal = lazy(() =>
  import('@/export/ExportModal').then((m) => ({ default: m.ExportModal })),
)

export function GraphToolbar() {
  const { fitView } = useReactFlow()
  const [copied, setCopied] = useState(false)
  const [embedOpen, setEmbedOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  const handleSave = useCallback(() => {
    const { nodes, edges } = useGraphStore.getState()
    const file = exportToFile(nodes, edges)
    downloadSombraFile(file)
  }, [])

  const handleOpen = useCallback(async () => {
    try {
      const json = await openSombraFile()
      const { nodes, edges } = importFromFile(json)
      // Downscale/re-encode any large embedded image (e.g. a .sombra carrying a
      // 67MB source) — the same import processing an uploaded file gets.
      const normalized = await normalizeGraphImages(nodes)
      useGraphStore.getState().loadGraph(normalized, edges)
      setTimeout(() => fitView({ padding: getFitViewPadding(useSettingsStore.getState().nodesPanelOpen), duration: 300 }), 50)
    } catch (err) {
      if (err instanceof Error && err.message === 'File selection cancelled') return
      console.error('[Sombra] Failed to open file:', err)
    }
  }, [fitView])

  const handleShare = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState()
    const hash = encodeCompactHash(nodes, edges)
    const url = `${location.origin}/sombra/viewer.html#g=${hash}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      console.error('[Sombra] Failed to copy share URL to clipboard')
    }
  }, [])

  return (
    <>
      <div className={ds.graphToolbar.root}>
        <IconButton
          icon="download"
          onClick={handleSave}
          title="Save graph (.sombra)"
        />
        <IconButton
          icon="folderOpen"
          onClick={handleOpen}
          title="Open graph (.sombra)"
        />
        <IconButton
          icon={copied ? 'check' : 'share'}
          iconClassName={copied ? 'text-success' : undefined}
          onClick={handleShare}
          title="Copy shareable viewer URL"
        />
        <IconButton
          icon="code"
          onClick={() => setEmbedOpen(true)}
          title="Embed on a website"
        />
        <IconButton
          icon="film"
          onClick={() => setExportOpen(true)}
          title="Export video / image sequence"
        />
      </div>
      <EmbedModal open={embedOpen} onClose={() => setEmbedOpen(false)} />
      {exportOpen && (
        <Suspense fallback={null}>
          <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
