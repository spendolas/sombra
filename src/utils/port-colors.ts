/**
 * Shared port type color definitions — single source of truth
 * Matches Figma "Port Types" variable collection (dark mode values)
 */

export const PORT_COLORS: Record<string, string> = {
  float: '#d4d4d8',
  vec2: '#34d399',
  vec3: '#60a5fa',
  vec4: '#a78bfa',
  color: '#fbbf24',
  sampler2D: '#f472b6',
  fnref: '#22d3ee',
  default: '#6b7280',
}

export function getPortColor(type: string): string {
  return PORT_COLORS[type] ?? PORT_COLORS.default
}
