/**
 * GraphToolbar — floating save/load pill at the top-left of the canvas.
 */

import { useCallback, useState } from 'react'
import { Panel, useReactFlow } from '@xyflow/react'
import { Check, Download, FolderOpen, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
      <Button
        variant="ghost"
        size="icon"
        onClick={handleSave}
        title="Save graph (.sombra)"
      >
        <Download className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleOpen}
        title="Open graph (.sombra)"
      >
        <FolderOpen className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleShare}
        title="Copy shareable viewer URL"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-400" />
        ) : (
          <Share2 className="h-4 w-4" />
        )}
      </Button>
    </Panel>
  )
}
