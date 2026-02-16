/**
 * Settings store - manages UI preferences and app settings
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

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

      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'sombra-settings',  // localStorage key
    }
  )
)
