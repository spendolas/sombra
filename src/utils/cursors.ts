/**
 * Custom SVG cursors (white outline + indigo stroke, visible on any background).
 * Shared by the image crop gizmo (ImageUploader) and the preview gizmo overlay so
 * they use the same Figma-derived icons. Angle-parameterised scale/rotate cursors
 * remain local to ImageUploader.
 */

/** Wrap an inline SVG as a CSS `cursor` value with a 12,12 hotspot + fallback. */
export function svgCursor(svg: string, fallback: string): string {
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}') 12 12, ${fallback}`
}

/** 4-way arrow Move cursor (static). Used when dragging/hovering draggable handles. */
export function moveCursor(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none">`
    + `<g stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M12 5v14M5 12h14"/>`
    + `<path d="M12 5l-2.5 3m2.5-3l2.5 3"/>`
    + `<path d="M12 19l-2.5-3m2.5 3l2.5-3"/>`
    + `<path d="M5 12l3-2.5m-3 2.5l3 2.5"/>`
    + `<path d="M19 12l-3-2.5m3 2.5l-3 2.5"/>`
    + `</g>`
    + `<g stroke="#6366f1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M12 5v14M5 12h14"/>`
    + `<path d="M12 5l-2.5 3m2.5-3l2.5 3"/>`
    + `<path d="M12 19l-2.5-3m2.5 3l2.5-3"/>`
    + `<path d="M5 12l3-2.5m-3 2.5l3 2.5"/>`
    + `<path d="M19 12l-3-2.5m3 2.5l-3 2.5"/>`
    + `</g></svg>`
  return svgCursor(svg, 'move')
}
