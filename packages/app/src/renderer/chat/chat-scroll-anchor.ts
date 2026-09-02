export interface ChatScrollGeometry {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  clientWidth: number
  viewportHeight: number
  viewportWidth: number
}

export const CHAT_STICKY_BOTTOM_THRESHOLD = 72
export const CHAT_GEOMETRY_EPSILON = 0.5
export const CHAT_COMPOSER_OVERLAY_RESIZE_EVENT = 'littlesheep:chat-composer-overlay-resize'

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
  return didChatViewportHeightChange(previous, current) || didChatViewportWidthChange(previous, current)
}

export function didChatViewportWidthChange(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
): boolean {
  return Math.abs(previous.viewportWidth - current.viewportWidth) >= CHAT_GEOMETRY_EPSILON
    || Math.abs(previous.clientWidth - current.clientWidth) >= CHAT_GEOMETRY_EPSILON
}

export function didChatViewportHeightChange(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
): boolean {
  return Math.abs(previous.viewportHeight - current.viewportHeight) >= CHAT_GEOMETRY_EPSILON
    || Math.abs(previous.clientHeight - current.clientHeight) >= CHAT_GEOMETRY_EPSILON
}

export function isChatNearBottom(
  geometry: ChatScrollGeometry,
  threshold = CHAT_STICKY_BOTTOM_THRESHOLD,
): boolean {
  const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
  const top = clamp(geometry.scrollTop, 0, maximum)
  return maximum - top < threshold
}

/**
 * Resolves the one correction that may be applied after a resize burst has
 * settled. Width-only reflow must not move a user who is reading above the
 * bottom; a bottom-pinned chat may still follow its new bottom edge.
 */
export function resolveChatResizeScrollTop(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
  stickToBottom: boolean,
): number | null {
  const widthChanged = didChatViewportWidthChange(previous, current)
  const heightChanged = didChatViewportHeightChange(previous, current)
  if (!widthChanged && !heightChanged) return null
  if (widthChanged && !heightChanged && !stickToBottom) return null
  return resolveBottomAnchoredScrollTop(previous, current)
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
