/**
 * NodePalette - Categorized list of draggable nodes
 */

import { nodeRegistry } from '../nodes/registry'
import { cn } from '@/lib/utils'
import { ds } from '@/generated/ds'

export function NodePalette() {
  const categories = nodeRegistry.getCategories()

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className={ds.nodePalette.categoryGroup}>
      {categories.map((category) => {
        const nodes = nodeRegistry.getByCategory(category)
        return (
          <div key={category}>
            <h3 className={cn(ds.categoryHeader.root, "text-category text-fg-subtle")}>
              {category}
            </h3>
            <div className="flex flex-col gap-xs">
              {nodes.map((node) => (
                <div
                  key={node.type}
                  draggable
                  onDragStart={(e) => onDragStart(e, node.type)}
                  className={cn(
                    ds.paletteItem.root,
                    "text-body cursor-move transition-colors text-fg-dim hover:bg-surface-elevated hover:text-fg"
                  )}
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
