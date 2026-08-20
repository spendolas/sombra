/**
 * Settings store - manages UI preferences and app settings
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PreviewMode = 'docked' | 'fullwindow' | 'floating'
export type SplitDirection = 'vertical' | 'horizontal'
export type PreviewBackgroundMode = 'checker' | 'solid' | 'none'

/**
 * Settings state interface
 */
interface SettingsState {
  // UI preferences
  showMiniMap: boolean
  showGrid: boolean
  gridSize: number
  snapToGrid: boolean
  nodesPanelOpen: boolean  // Floaty Nodes palette overlay — persisted, default off
  // Global coords-view switch: 'off' = no gizmo; 'world'/'node' = gizmo shown,
  // axes + offset-slider display interpreted in that frame. Persisted.
  gizmoView: 'off' | 'world' | 'node'

  // Preview settings
  previewHeight: number  // Height of preview panel in pixels
  autoCompile: boolean   // Auto-compile on graph changes
  compileDebounceMs: number  // Debounce delay for auto-compile
  previewMode: PreviewMode
  previousPreviewMode: PreviewMode
  splitDirection: SplitDirection
  floatingPosition: { x: number; y: number }
  floatingSize: { width: number; height: number }
  verticalSplitPct: number   // Preview panel % when vertical split
  horizontalSplitPct: number // Preview panel % when horizontal split
  verticalSplitSwapped: boolean    // Per-direction swap state
  horizontalSplitSwapped: boolean
  previewBackground: { mode: PreviewBackgroundMode; color: string }

  // Node defaults
  defaultNodeWidth: number
  defaultNodeHeight: number

  // Actions
  setShowMiniMap: (show: boolean) => void
  setShowGrid: (show: boolean) => void
  setGridSize: (size: number) => void
  setSnapToGrid: (snap: boolean) => void
  setNodesPanelOpen: (open: boolean) => void
  toggleNodesPanel: () => void
  setGizmoView: (view: 'off' | 'world' | 'node') => void
  setPreviewHeight: (height: number) => void
  setAutoCompile: (auto: boolean) => void
  setCompileDebounceMs: (ms: number) => void
  setPreviewMode: (mode: PreviewMode) => void
  setSplitDirection: (dir: SplitDirection) => void
  setFloatingPosition: (pos: { x: number; y: number }) => void
  setFloatingSize: (size: { width: number; height: number }) => void
  setSplitPct: (dir: SplitDirection, pct: number) => void
  toggleSplitSwapped: () => void
  setPreviewBackground: (bg: Partial<{ mode: PreviewBackgroundMode; color: string }>) => void
  reset: () => void
}

/**
 * Default settings
 */
const DEFAULT_SETTINGS: Omit<SettingsState, keyof SettingsActions> = {
  showMiniMap: true,
  showGrid: true,
  gridSize: 16,
  snapToGrid: false,
  nodesPanelOpen: false,
  gizmoView: 'world',
  previewHeight: 256,  // 16rem
  autoCompile: true,
  compileDebounceMs: 100,
  previewMode: 'docked',
  previousPreviewMode: 'docked',
  // First-timer default layout: side-by-side split with the shader (preview) on
  // the left at the golden ratio. (react-resizable-panels 'horizontal' = a
  // vertical divider / left-right panes; swap puts the preview panel first = left.)
  splitDirection: 'horizontal',
  floatingPosition: { x: -1, y: -1 },  // sentinel → compute default on first use
  floatingSize: { width: 400, height: 300 },
  verticalSplitPct: 30,
  horizontalSplitPct: 38.2,  // golden ratio — shader (left panel) gets the minor share, editor the major
  verticalSplitSwapped: false,
  horizontalSplitSwapped: true,  // preview (shader) on the left, editor on the right
  previewBackground: { mode: 'checker', color: '#1a1a2e' },
  defaultNodeWidth: 200,
  defaultNodeHeight: 100,
}

type SettingsActions = {
  setShowMiniMap: (show: boolean) => void
  setShowGrid: (show: boolean) => void
  setGridSize: (size: number) => void
  setSnapToGrid: (snap: boolean) => void
  setNodesPanelOpen: (open: boolean) => void
  toggleNodesPanel: () => void
  setGizmoView: (view: 'off' | 'world' | 'node') => void
  setPreviewHeight: (height: number) => void
  setAutoCompile: (auto: boolean) => void
  setCompileDebounceMs: (ms: number) => void
  setPreviewMode: (mode: PreviewMode) => void
  setSplitDirection: (dir: SplitDirection) => void
  setFloatingPosition: (pos: { x: number; y: number }) => void
  setFloatingSize: (size: { width: number; height: number }) => void
  setSplitPct: (dir: SplitDirection, pct: number) => void
  toggleSplitSwapped: () => void
  setPreviewBackground: (bg: Partial<{ mode: PreviewBackgroundMode; color: string }>) => void
  reset: () => void
}

/**
 * Settings store - persisted to localStorage
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,

      setShowMiniMap: (show) => set({ showMiniMap: show }),
      setShowGrid: (show) => set({ showGrid: show }),
      setGridSize: (size) => set({ gridSize: size }),
      setSnapToGrid: (snap) => set({ snapToGrid: snap }),
      setNodesPanelOpen: (open) => set({ nodesPanelOpen: open }),
      toggleNodesPanel: () => set((s) => ({ nodesPanelOpen: !s.nodesPanelOpen })),
      setGizmoView: (view) => set({ gizmoView: view }),
      setPreviewHeight: (height) => set({ previewHeight: height }),
      setAutoCompile: (auto) => set({ autoCompile: auto }),
      setCompileDebounceMs: (ms) => set({ compileDebounceMs: ms }),
      setPreviewMode: (mode) => set((s) => ({ previousPreviewMode: s.previewMode, previewMode: mode })),
      setSplitDirection: (dir) => set({ splitDirection: dir }),
      setFloatingPosition: (pos) => set({ floatingPosition: pos }),
      setFloatingSize: (size) => set({ floatingSize: size }),
      setSplitPct: (dir, pct) => set(dir === 'vertical' ? { verticalSplitPct: pct } : { horizontalSplitPct: pct }),
      toggleSplitSwapped: () => set((s) => s.splitDirection === 'vertical' ? { verticalSplitSwapped: !s.verticalSplitSwapped } : { horizontalSplitSwapped: !s.horizontalSplitSwapped }),
      setPreviewBackground: (bg) => set((s) => ({ previewBackground: { ...s.previewBackground, ...bg } })),

      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'sombra-settings',  // localStorage key
    }
  )
)
