import { create } from 'zustand'

/**
 * Runtime (non-persisted) renderer facts, set once after the main renderer
 * initializes. Kept out of settingsStore because that store is fully persisted
 * to localStorage — GPU vendor is a per-session hardware fact, not a setting.
 */
interface RendererState {
  /** WebGPU adapter is an AMD GPU — where a transparent canvas flickers under
   *  macOS/Chrome, so the editor warns before enabling see-through. */
  isAmd: boolean
  setIsAmd: (isAmd: boolean) => void
}

export const useRendererStore = create<RendererState>((set) => ({
  isAmd: false,
  setIsAmd: (isAmd) => set({ isAmd }),
}))
