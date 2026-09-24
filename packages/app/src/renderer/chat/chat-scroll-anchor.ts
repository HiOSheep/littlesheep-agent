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
/** Every message carries this key, so a reading position can be named instead of guessed. */
export const CHAT_MESSAGE_ANCHOR_ATTRIBUTE = 'data-message-key'

export interface ChatAnchorProbe {
  key: string
  /** The element's top edge, relative to the viewport's own top edge (negative once scrolled past). */
  top: number
  /** The element's bottom edge, relative to the viewport's own top edge. */
  bottom: number
}

/** The message a reader is looking at, named by key and by where it sat in the viewport. */
export interface ChatVisibleAnchor {
  key: string
  top: number
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
 *
 * A reader above the bottom is anchored to a **message**, not to their distance
 * from the bottom edge: preserving that distance moves them by exactly the
 * amount the viewport changed, which is the jump reported as "the text left the
 * paragraph I was reading". Their correction therefore comes from
 * `resolveAnchoredScrollTop` over `selectChatVisibleAnchor`, and this function
 * answers only for the pinned case, whose anchor really is the bottom edge.
 */
export function resolveChatResizeScrollTop(
  previous: ChatScrollGeometry,
  current: ChatScrollGeometry,
  stickToBottom: boolean,
): number | null {
  if (!didChatViewportResize(previous, current)) return null
  if (!stickToBottom) return null
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

/**
 * Every keyed message in document order, measured against the viewport's own top
 * edge. The DOM read lives here and the decisions below stay pure, so the anchor
 * arithmetic is testable without a window.
 */
export function readChatAnchorProbes(container: HTMLElement): ChatAnchorProbe[] {
  const viewportTop = container.getBoundingClientRect().top
  const probes: ChatAnchorProbe[] = []
  container.querySelectorAll<HTMLElement>(`[${CHAT_MESSAGE_ANCHOR_ATTRIBUTE}]`).forEach((element) => {
    const key = element.getAttribute(CHAT_MESSAGE_ANCHOR_ATTRIBUTE)
    if (!key) return
    const bounds = element.getBoundingClientRect()
    probes.push({ key, top: bounds.top - viewportTop, bottom: bounds.bottom - viewportTop })
  })
  return probes
}

/**
 * The message the reader is actually reading: the first keyed message that is
 * still partly on screen. Everything above it has already been scrolled past.
 */
export function selectChatVisibleAnchor(
  probes: readonly ChatAnchorProbe[],
  viewportHeight: number,
): ChatVisibleAnchor | null {
  const visible = probes.find((probe) => probe.bottom > 0 && probe.top < viewportHeight)
  return visible ? { key: visible.key, top: visible.top } : null
}

/**
 * The scrollTop that puts the anchored message back where the reader last saw it
 * after the layout above or around it changed. `null` means "do not correct":
 * the anchor is gone (the history window replaced it), so the browser's own
 * position is better evidence than a guess.
 */
export function resolveAnchoredScrollTop(
  anchor: ChatVisibleAnchor,
  probes: readonly ChatAnchorProbe[],
  scrollTop: number,
): number | null {
  const probe = probes.find((candidate) => candidate.key === anchor.key)
  if (!probe) return null
  const next = scrollTop + (probe.top - anchor.top)
  return Number.isFinite(next) ? Math.max(0, next) : null
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
