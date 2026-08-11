import type { Input } from 'electron'

export const APPLICATION_ZOOM_FACTOR = 1

type ApplicationZoomInput = Pick<
  Input,
  'type' | 'key' | 'code' | 'control' | 'meta' | 'alt'
>

const APPLICATION_ZOOM_KEYS = new Set(['+', '-', '=', '0'])
const APPLICATION_ZOOM_CODES = new Set([
  'Digit0',
  'Equal',
  'Minus',
  'Numpad0',
  'NumpadAdd',
  'NumpadSubtract',
])

export function isApplicationZoomShortcut(input: ApplicationZoomInput): boolean {
  if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta)) return false
  return APPLICATION_ZOOM_KEYS.has(input.key) || APPLICATION_ZOOM_CODES.has(input.code)
}
