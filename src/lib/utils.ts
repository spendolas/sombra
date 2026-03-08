import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge<'sombra-text-style'>({
  extend: {
    classGroups: {
      // Sombra @utility text styles — composite utilities that set font-size,
      // font-weight, line-height (and sometimes letter-spacing, text-transform).
      // Must be a separate group from text-color so twMerge doesn't strip e.g.
      // text-node-title when combined with text-fg.
      'sombra-text-style': [
        {
          text: [
            'node-title', 'section', 'category', 'body', 'description',
            'handle', 'param', 'category-meta', 'mono-value', 'mono-id', 'port-type',
          ],
        },
      ],
    },
    conflictingClassGroups: {
      // Sombra text styles are composite — they override individual typography utils
      'sombra-text-style': ['font-size', 'font-weight', 'leading', 'tracking'],
      // And vice versa: individual typography utils override sombra text styles
      'font-size': ['sombra-text-style'],
      'font-weight': ['sombra-text-style'],
      'leading': ['sombra-text-style'],
      'tracking': ['sombra-text-style'],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
