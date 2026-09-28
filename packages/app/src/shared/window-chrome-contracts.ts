// Main owns native window state; preload projects these facts into CSS attributes.
export const WINDOW_CHROME_QUERY_CHANNEL = 'littlesheep:window-chrome-query'
export const WINDOW_CHROME_CHANNEL = 'littlesheep:window-chrome'

export interface WindowChromeState {
  layout: 'beta' | 'chali'
  backdrop: 'acrylic' | 'vibrancy' | 'solid'
}

export function isWindowChromeState(value: unknown): value is WindowChromeState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WindowChromeState>
  return (state.layout === 'beta' || state.layout === 'chali')
    && (state.backdrop === 'acrylic' || state.backdrop === 'vibrancy' || state.backdrop === 'solid')
}
