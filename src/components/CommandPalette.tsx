/**
 * CommandPalette - Cmd+K node search and placement overlay
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { Node } from '@xyflow/react'
import type { NodeData } from '../nodes/types'
import { nodeRegistry } from '../nodes/registry'
import { useGraphStore } from '../stores/graphStore'
import { searchNodes, groupByCategory, type SearchResult } from '../utils/fuzzy-search'

/** Node types that can only exist once on the graph */
const SINGLETON_TYPES = new Set(['fragment_output'])

const RECENTS_KEY = 'sombra-recent-nodes'
const MAX_RECENTS = 3

function loadRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]') }
  catch { return [] }
}

function saveRecents(recents: string[]) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
}

interface CommandPaletteProps {
  onClose: () => void
  mousePosition: { x: number; y: number }
}

export function CommandPalette({ onClose, mousePosition }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [shaking, setShaking] = useState(false)
  const [recents, setRecents] = useState(loadRecents)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition } = useReactFlow()
  const addNode = useGraphStore((s) => s.addNode)
  const graphNodes = useGraphStore((s) => s.nodes)

  const allNodes = useMemo(() => nodeRegistry.getAll(), [])
  const recentsSet = useMemo(() => new Set(recents), [recents])

  // Search results with recent boost
  const results = useMemo(() => {
    const raw = searchNodes(query, allNodes)
    if (!query.trim() || recentsSet.size === 0) return raw
    // Boost recent types by subtracting from score
    return raw
      .map(r => recentsSet.has(r.definition.type) ? { ...r, score: r.score - 3 } : r)
      .sort((a, b) => a.score - b.score)
  }, [query, allNodes, recentsSet])

  // Build recent items for empty-query display
  const recentResults = useMemo<SearchResult[]>(() => {
    if (query.trim()) return []
    return recents
      .map(type => nodeRegistry.get(type))
      .filter(Boolean)
      .map(def => ({ definition: def!, score: -1, matchField: 'label' as const }))
  }, [query, recents])

  const grouped = useMemo(() => {
    const groups = groupByCategory(results)
    return groups
  }, [results])

  // Track which singleton types are already on the graph
  const existingSingletons = useMemo(
    () => new Set(graphNodes.filter(n => SINGLETON_TYPES.has(n.data.type)).map(n => n.data.type)),
    [graphNodes],
  )

  const isDisabled = useCallback(
    (type: string) => SINGLETON_TYPES.has(type) && existingSingletons.has(type),
    [existingSingletons],
  )

  // Flat list for keyboard navigation: recents first, then grouped results
  const flatResults = useMemo(() => [...recentResults, ...results], [recentResults, results])

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

  const triggerShake = useCallback(() => {
    setShaking(true)
    setTimeout(() => setShaking(false), 500)
  }, [])

  const placeNode = useCallback(
    (nodeType: string) => {
      if (isDisabled(nodeType)) {
        triggerShake()
        return
      }

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

      // Deselect all existing nodes before adding the new one
      const currentNodes = useGraphStore.getState().nodes
      if (currentNodes.some(n => n.selected)) {
        useGraphStore.getState().setNodes(currentNodes.map(n => n.selected ? { ...n, selected: false } : n))
      }
      addNode(newNode)

      // Update recents
      const updated = [nodeType, ...recents.filter(t => t !== nodeType)].slice(0, MAX_RECENTS)
      setRecents(updated)
      saveRecents(updated)

      onClose()
    },
    [screenToFlowPosition, addNode, onClose, isDisabled, triggerShake, recents],
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

  // Render a result row
  const renderItem = (result: SearchResult, idx: number) => {
    const isSelected = idx === selectedIndex
    const disabled = isDisabled(result.definition.type)
    return (
      <div
        key={`${result.definition.type}-${idx}`}
        data-selected={isSelected}
        className={`px-4 py-1.5 flex items-center justify-between ${
          disabled
            ? 'opacity-[var(--disabled-opacity)] cursor-not-allowed'
            : `cursor-pointer ${isSelected ? 'bg-highlight' : 'hover:bg-hover'}`
        }`}
        onClick={() => placeNode(result.definition.type)}
        onMouseEnter={() => setSelectedIndex(idx)}
      >
        <span className={`text-sm ${disabled ? 'text-fg-muted' : 'text-fg'}`}>
          {result.definition.label}
        </span>
        {disabled ? (
          <span className="text-fg-muted text-xs italic ml-4">
            already in graph
          </span>
        ) : result.definition.description ? (
          <span className="text-fg-muted text-xs truncate ml-4 max-w-[55%] text-right">
            {result.definition.description}
          </span>
        ) : null}
      </div>
    )
  }

  // Track flat index for keyboard navigation
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
        ref={dialogRef}
        className="fixed left-1/2 -translate-x-1/2 top-[20vh] w-[420px] max-h-[50vh] bg-surface-raised border border-edge rounded-lg shadow-2xl overflow-hidden flex flex-col"
        style={shaking ? {
          animation: 'cmd-palette-shake 0.4s ease-in-out',
        } : undefined}
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
            <>
              {/* Recent section */}
              {recentResults.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 text-[11px] text-fg-subtle uppercase tracking-wider">
                    Recent
                  </div>
                  {recentResults.map((result) => {
                    flatIndex++
                    return renderItem(result, flatIndex)
                  })}
                </div>
              )}

              {/* Category sections */}
              {Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category}>
                  <div className="px-4 py-1.5 text-[11px] text-fg-subtle uppercase tracking-wider">
                    {category}
                  </div>
                  {items.map((result) => {
                    flatIndex++
                    return renderItem(result, flatIndex)
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
