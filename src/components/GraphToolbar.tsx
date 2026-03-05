/**
 * GraphToolbar — floating save/load pill at the top-left of the canvas.
 */

import { useCallback, useState } from 'react'
import { Panel, useReactFlow } from '@xyflow/react'
import { IconButton } from '@/components/IconButton'
import { useGraphStore } from '@/stores/graphStore'
import {
  exportToFile,
  importFromFile,
  downloadSombraFile,
  openSombraFile,
  encodeGraphToHash,
} from '@/utils/sombra-file'
import { ds } from '@/generated/ds'

export function GraphToolbar() {
  const { fitView } = useReactFlow()
  const [copied, setCopied] = useState(false)

  const handleSave = useCallback(() => {
    const { nodes, edges } = useGraphStore.getState()
    const file = exportToFile(nodes, edges)
    downloadSombraFile(file)
  }, [])

  const handleOpen = useCallback(async () => {
    try {
      const json = await openSombraFile()
      const { nodes, edges } = importFromFile(json)
      useGraphStore.getState().loadGraph(nodes, edges)
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50)
    } catch (err) {
      if (err instanceof Error && err.message === 'File selection cancelled') return
      console.error('[Sombra] Failed to open file:', err)
    }
  }, [fitView])

  const handleShare = useCallback(async () => {
    const { nodes, edges } = useGraphStore.getState()
    const hash = encodeGraphToHash(nodes, edges)
    const url = `${location.origin}/sombra/viewer.html#graph=${hash}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      console.error('[Sombra] Failed to copy share URL to clipboard')
    }
  }, [])

  return (
    <Panel
      position="top-left"
      className={ds.graphToolbar.root}
    >
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
        iconClassName={copied ? 'text-green-400' : undefined}
        onClick={handleShare}
        title="Copy shareable viewer URL"
      />
    </Panel>
  )
}
