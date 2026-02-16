/**
 * NodePalette - Categorized list of draggable nodes
 */

import { nodeRegistry } from '../nodes/registry'

export function NodePalette() {
  const categories = nodeRegistry.getCategories()

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className="space-y-4">
      {categories.map((category) => {
        const nodes = nodeRegistry.getByCategory(category)
        return (
          <div key={category}>
            <h3
              className="text-[10px] font-semibold uppercase tracking-wider mb-2"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {category}
            </h3>
            <div className="space-y-1">
              {nodes.map((node) => (
                <div
                  key={node.type}
                  draggable
                  onDragStart={(e) => onDragStart(e, node.type)}
                  className="px-2 py-1.5 rounded text-xs cursor-move transition-colors"
                  style={{
                    backgroundColor: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-secondary)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-elevated)'
                    e.currentTarget.style.borderColor = 'var(--border-primary)'
                    e.currentTarget.style.color = 'var(--text-primary)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'
                    e.currentTarget.style.borderColor = 'var(--border-secondary)'
                    e.currentTarget.style.color = 'var(--text-secondary)'
                  }}
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
