/**
 * An in-memory `localStorage` for node-side gates that load a persisted
 * Zustand store. Import it FIRST (before anything that pulls in a store):
 * ES imports evaluate in order, and the persist middleware decides at store
 * creation whether storage exists — without it every write is silently dropped
 * ("storage is currently unavailable") and nothing about persistence is tested.
 */
export const memoryStorage = new Map<string, string>()

const storage = {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => { memoryStorage.set(k, String(v)) },
  removeItem: (k: string) => { memoryStorage.delete(k) },
  clear: () => memoryStorage.clear(),
  key: (i: number) => [...memoryStorage.keys()][i] ?? null,
  get length() { return memoryStorage.size },
}

// Zustand's default persist storage reads `window.localStorage`.
const g = globalThis as { localStorage?: unknown; window?: unknown }
g.localStorage = storage
g.window ??= g
