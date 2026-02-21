/**
 * NodePalette - Categorized list of draggable nodes
 */

import { nodeRegistry } from '../nodes/registry'
import { Separator } from '@/components/ui/separator'

export function NodePalette() {
  const categories = nodeRegistry.getCategories()

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="space-y-3">
      {categories.map((category, idx) => {
        const nodes = nodeRegistry.getByCategory(category)
        return (
          <div key={category}>
            {idx > 0 && <Separator className="mb-3" />}
            <h3 className="text-[10px] font-semibold uppercase tracking-wider mb-2 text-fg-subtle">
              {category}
            </h3>
            <div className="space-y-1">
              {nodes.map((node) => (
                <div
                  key={node.type}
                  draggable
                  onDragStart={(e) => onDragStart(e, node.type)}
                  className="px-2 py-1.5 rounded text-xs cursor-move transition-colors bg-surface-raised text-fg-dim border border-edge-subtle hover:bg-surface-elevated hover:text-fg"
                  title={node.description}
                >
                  {node.label}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
