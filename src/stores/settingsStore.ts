/**
 * Settings store - manages UI preferences and app settings
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PreviewMode = 'docked' | 'fullwindow' | 'floating'
export type SplitDirection = 'vertical' | 'horizontal'

/**
 * Settings state interface
 */
interface SettingsState {
  // UI preferences
  showMiniMap: boolean
  showGrid: boolean
  gridSize: number
  snapToGrid: boolean

  // Preview settings
  previewHeight: number  // Height of preview panel in pixels
  autoCompile: boolean   // Auto-compile on graph changes
  compileDebounceMs: number  // Debounce delay for auto-compile
  previewMode: PreviewMode
  splitDirection: SplitDirection
  floatingPosition: { x: number; y: number }
  floatingSize: { width: number; height: number }
  verticalSplitPct: number   // Preview panel % when vertical split
  horizontalSplitPct: number // Preview panel % when horizontal split

  // Node defaults
  defaultNodeWidth: number
  defaultNodeHeight: number

  // Actions
  setShowMiniMap: (show: boolean) => void
  setShowGrid: (show: boolean) => void
  setGridSize: (size: number) => void
  setSnapToGrid: (snap: boolean) => void
  setPreviewHeight: (height: number) => void
  setAutoCompile: (auto: boolean) => void
  setCompileDebounceMs: (ms: number) => void
  setPreviewMode: (mode: PreviewMode) => void
  setSplitDirection: (dir: SplitDirection) => void
  setFloatingPosition: (pos: { x: number; y: number }) => void
  setFloatingSize: (size: { width: number; height: number }) => void
  setSplitPct: (dir: SplitDirection, pct: number) => void
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
  previewHeight: 256,  // 16rem
  autoCompile: true,
  compileDebounceMs: 100,
  previewMode: 'docked',
  splitDirection: 'vertical',
  floatingPosition: { x: -1, y: -1 },  // sentinel → compute default on first use
  floatingSize: { width: 400, height: 300 },
  verticalSplitPct: 30,
  horizontalSplitPct: 30,
  defaultNodeWidth: 200,
  defaultNodeHeight: 100,
}

type SettingsActions = {
  setShowMiniMap: (show: boolean) => void
  setShowGrid: (show: boolean) => void
  setGridSize: (size: number) => void
  setSnapToGrid: (snap: boolean) => void
  setPreviewHeight: (height: number) => void
  setAutoCompile: (auto: boolean) => void
  setCompileDebounceMs: (ms: number) => void
  setPreviewMode: (mode: PreviewMode) => void
  setSplitDirection: (dir: SplitDirection) => void
  setFloatingPosition: (pos: { x: number; y: number }) => void
  setFloatingSize: (size: { width: number; height: number }) => void
  setSplitPct: (dir: SplitDirection, pct: number) => void
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
      setPreviewHeight: (height) => set({ previewHeight: height }),
      setAutoCompile: (auto) => set({ autoCompile: auto }),
      setCompileDebounceMs: (ms) => set({ compileDebounceMs: ms }),
      setPreviewMode: (mode) => set({ previewMode: mode }),
      setSplitDirection: (dir) => set({ splitDirection: dir }),
      setFloatingPosition: (pos) => set({ floatingPosition: pos }),
      setFloatingSize: (size) => set({ floatingSize: size }),
      setSplitPct: (dir, pct) => set(dir === 'vertical' ? { verticalSplitPct: pct } : { horizontalSplitPct: pct }),

      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'sombra-settings',  // localStorage key
    }
  )
)
