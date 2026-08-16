export interface ChatScrollGeometry {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  clientWidth: number
  viewportHeight: number
  viewportWidth: number
}

export function readChatScrollGeometry(viewport: HTMLElement): ChatScrollGeometry {
  const bounds = viewport.getBoundingClientRect()
  return {
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    clientHeight: viewport.clientHeight,
    clientWidth: viewport.clientWidth,
    viewportHeight: bounds.height,
    viewportWidth: bounds.width,
  }
}

export function didChatViewportResize(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
): boolean {
  return previous.viewportHeight !== current.viewportHeight || previous.viewportWidth !== current.viewportWidth
}

/** Preserves the visible bottom edge while wrapping or viewport height changes above it. */
export function resolveBottomAnchoredScrollTop(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
): number {
  const previousMaximum = Math.max(0, previous.scrollHeight - previous.clientHeight)
  const previousTop = clamp(previous.scrollTop, 0, previousMaximum)
  const previousBottomGap = previousMaximum - previousTop
  const currentMaximum = Math.max(0, current.scrollHeight - current.clientHeight)

  return clamp(currentMaximum - previousBottomGap, 0, currentMaximum)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
