/**
 * NodePalette - Categorized list of draggable nodes
 */

import { nodeRegistry } from '../nodes/registry'
import { ds } from '@/generated/ds'

export function NodePalette() {
  const categories = nodeRegistry.getCategories()

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className={ds.nodePalette.root}>
      <div className={ds.nodePalette.categoryGroup}>
        {categories.map((category) => {
          const nodes = nodeRegistry.getByCategory(category)
          return (
            <div key={category}>
              <h3 className={ds.categoryHeader.root}>
                {category}
              </h3>
              <div className={ds.nodePalette.itemList}>
                {nodes.map((node) => (
                  <div
                    key={node.type}
                    draggable
                    onDragStart={(e) => onDragStart(e, node.type)}
                    className={ds.paletteItem.root}
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
    </div>
  )
}
