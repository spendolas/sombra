/**
 * Dev-only gate for the in-editor Perf View HUD. Mirrors the `isWebGL2Forced()`
 * idiom in `src/renderer/create-renderer.ts`: a URL param read once at mount.
 * `?perf=1` splits the editor and mounts <PerfView mode="editor" />.
 */
export function isPerfViewEnabled(): boolean {
  return (
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('perf') === '1'
  )
}
