/**
 * Shared value constants + option types for the Perf View controls. Split out of
 * the component files so both PerfView and PerfControls can import them without
 * tripping react-refresh's "only export components" rule.
 */

export interface ResolutionOption {
  label: string
  width: number
  height: number
}

export const RESOLUTIONS: ResolutionOption[] = [
  { label: '1920 × 1080', width: 1920, height: 1080 },
  { label: '2560 × 1440', width: 2560, height: 1440 },
  { label: '3840 × 2160', width: 3840, height: 2160 },
]

export interface NodeOption {
  id: string
  label: string
}
