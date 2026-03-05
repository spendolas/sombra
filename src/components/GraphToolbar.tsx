/**
 * GraphToolbar — floating save/load pill at the top-left of the canvas.
 */

import { useCallback } from 'react'
import { Panel, useReactFlow } from '@xyflow/react'
import { Download, FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useGraphStore } from '@/stores/graphStore'
import {
  exportToFile,
  importFromFile,
  downloadSombraFile,
  openSombraFile,
} from '@/utils/sombra-file'

export function GraphToolbar() {
  const { fitView } = useReactFlow()

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
      // Silently ignore cancellation
      if (err instanceof Error && err.message === 'File selection cancelled') return
      console.error('[Sombra] Failed to open file:', err)
    }
  }, [fitView])

  return (
    <Panel
      position="top-left"
      className="flex flex-row bg-surface-alt rounded-md p-xs gap-xs"
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
    </Panel>
  )
}
