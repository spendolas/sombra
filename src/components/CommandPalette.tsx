/**
 * CommandPalette - Cmd+K node search and placement overlay
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { useGraphStore } from '../stores/graphStore'
import { searchNodes, groupByCategory } from '../utils/fuzzy-search'

interface CommandPaletteProps {
  onClose: () => void
  mousePosition: { x: number; y: number }
}

export function CommandPalette({ onClose, mousePosition }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()
  const addNode = useGraphStore((s) => s.addNode)

  const allNodes = useMemo(() => nodeRegistry.getAll(), [])
  const results = useMemo(() => searchNodes(query, allNodes), [query, allNodes])
  const grouped = useMemo(() => groupByCategory(results), [results])

  // Flat list for keyboard navigation (category headers excluded)
  const flatResults = useMemo(() => results, [results])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Scroll selected item into view
  useEffect(() => {
    const item = listRef.current?.querySelector('[data-selected="true"]')
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const placeNode = useCallback(
    (nodeType: string) => {
      const def = nodeRegistry.get(nodeType)
      if (!def) return

      const position = screenToFlowPosition(mousePosition)

      const defaultParams: Record<string, unknown> = {}
      if (def.params) {
        for (const p of def.params) {
          if (p.default !== undefined) {
            defaultParams[p.id] = p.default
          }
        }
      }

      const newNode: Node<NodeData> = {
        id: `${nodeType}-${Date.now()}`,
        type: 'shaderNode',
        position,
        selected: true,
        data: {
          type: nodeType,
          params: defaultParams,
        },
      }

      addNode(newNode)
      onClose()
    },
    [screenToFlowPosition, addNode, onClose]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (flatResults[selectedIndex]) {
            placeNode(flatResults[selectedIndex].definition.type)
          }
          break
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    },
    [flatResults, selectedIndex, placeNode, onClose]
  )

  // Track flat index across grouped display
  let flatIndex = -1

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 bg-surface/80"
      onClick={onClose}
      onKeyDown={onKeyDown}
    >
      {/* Dialog */}
      <div
        className="fixed left-1/2 -translate-x-1/2 top-[20vh] w-[420px] max-h-[50vh] bg-surface-raised border border-edge rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center px-4 py-3 border-b border-edge">
          <svg
            className="w-4 h-4 text-fg-muted mr-3 shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-full bg-transparent text-fg outline-none placeholder:text-fg-muted text-sm"
          />
        </div>

        {/* Results list */}
        <div ref={listRef} className="overflow-y-auto flex-1 py-1">
          {flatResults.length === 0 ? (
            <div className="px-4 py-8 text-center text-fg-muted text-sm">
              No matching nodes
            </div>
          ) : (
            Array.from(grouped.entries()).map(([category, items]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-[11px] text-fg-subtle uppercase tracking-wider">
                  {category}
                </div>
                {items.map((result) => {
                  flatIndex++
                  const isSelected = flatIndex === selectedIndex
                  const currentIndex = flatIndex
                  return (
                    <div
                      key={result.definition.type}
                      data-selected={isSelected}
                      className={`px-4 py-1.5 flex items-center justify-between cursor-pointer ${
                        isSelected ? 'bg-indigo/20' : 'hover:bg-surface-elevated'
                      }`}
                      onClick={() => placeNode(result.definition.type)}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                    >
                      <span className="text-fg text-sm">{result.definition.label}</span>
                      {result.definition.description && (
                        <span className="text-fg-muted text-xs truncate ml-4 max-w-[55%] text-right">
                          {result.definition.description}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
