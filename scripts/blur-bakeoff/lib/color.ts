// Standard sRGB <-> linear-light transfer functions (IEC 61966-2-1).
// All values are normalized to [0,1]. These are the single source of truth for
// the "blur in linear space" correctness the pipeline does NOT provide itself.

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
}
