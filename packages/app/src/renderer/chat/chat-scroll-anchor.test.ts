import { describe, expect, it } from 'vitest'
import {
  CHAT_COMPOSER_OVERLAY_RESIZE_EVENT,
  CHAT_MESSAGE_ANCHOR_ATTRIBUTE,
  CHAT_STICKY_BOTTOM_THRESHOLD,
  CHAT_GEOMETRY_EPSILON,
  didChatViewportHeightChange,
  didChatViewportResize,
  didChatViewportWidthChange,
  isChatNearBottom,
  resolveAnchoredScrollTop,
  resolveChatResizeScrollTop,
  resolveBottomAnchoredScrollTop,
  selectChatVisibleAnchor,
  type ChatAnchorProbe,
  type ChatScrollGeometry,
} from './chat-scroll-anchor'

function geometry(overrides: Partial<ChatScrollGeometry> = {}): ChatScrollGeometry {
  return {
    scrollHeight: 1_000,
    scrollTop: 500,
    clientHeight: 400,
    clientWidth: 700,
    viewportHeight: 400,
    viewportWidth: 700,
    ...overrides,
  }
}

describe('chat bottom scroll anchor', () => {
  it('keeps the current bottom gap when narrower text wraps above the viewport edge', () => {
    const previous = geometry()
    const current = geometry({
      scrollHeight: 1_120,
      clientHeight: 360,
      clientWidth: 520,
      viewportHeight: 360,
      viewportWidth: 520,
    })

    const nextTop = resolveBottomAnchoredScrollTop(previous, current)

    expect(nextTop).toBe(660)
    expect(current.scrollHeight - current.clientHeight - nextTop).toBe(100)
  })

  it('keeps a viewport already at the bottom pinned to the bottom', () => {
    const previous = geometry({ scrollTop: 600 })
    const current = geometry({
      scrollHeight: 1_180,
      clientHeight: 340,
      clientWidth: 500,
      viewportHeight: 340,
      viewportWidth: 500,
    })

    expect(resolveBottomAnchoredScrollTop(previous, current)).toBe(840)
  })

  it('preserves an intentional reading gap when the viewport grows', () => {
    const previous = geometry({ scrollHeight: 1_200, scrollTop: 500, clientHeight: 400 })
    const current = geometry({ scrollHeight: 1_000, clientHeight: 500, clientWidth: 820 })

    expect(resolveBottomAnchoredScrollTop(previous, current)).toBe(200)
  })

  it('clamps to the top when the resized content is shorter than the saved bottom gap', () => {
    const previous = geometry({ scrollHeight: 1_200, scrollTop: 100, clientHeight: 400 })
    const current = geometry({ scrollHeight: 500, clientHeight: 400, clientWidth: 900 })

    expect(resolveBottomAnchoredScrollTop(previous, current)).toBe(0)
  })

  it('repairs only actual viewport size changes', () => {
    const previous = geometry()

    expect(didChatViewportResize(previous, geometry({ scrollHeight: 1_080 }))).toBe(false)
    expect(didChatViewportWidthChange(previous, geometry({ viewportWidth: 699.5 }))).toBe(true)
    expect(didChatViewportHeightChange(previous, geometry({ viewportHeight: 399.5 }))).toBe(true)
    expect(didChatViewportResize(previous, geometry({ viewportWidth: 699.5 }))).toBe(true)
    expect(didChatViewportResize(previous, geometry({ viewportHeight: 399.5 }))).toBe(true)
  })

  it('does not move a non-bottom reader during a width-only reflow', () => {
    const previous = geometry({ scrollTop: 420 })
    const current = geometry({ scrollHeight: 1_160, clientWidth: 520, viewportWidth: 520 })

    expect(resolveChatResizeScrollTop(previous, current, false)).toBeNull()
  })

  it('repairs a bottom-pinned chat once after a width-only reflow', () => {
    const previous = geometry({ scrollTop: 600 })
    const current = geometry({ scrollHeight: 1_180, clientWidth: 520, viewportWidth: 520 })

    expect(resolveChatResizeScrollTop(previous, current, true)).toBe(780)
    expect(isChatNearBottom(previous)).toBe(true)
    expect(CHAT_STICKY_BOTTOM_THRESHOLD).toBe(72)
    expect(CHAT_GEOMETRY_EPSILON).toBe(0.5)
    expect(CHAT_COMPOSER_OVERLAY_RESIZE_EVENT).toBe('littlesheep:chat-composer-overlay-resize')
  })

  it('keeps height-change repairs available for intentional viewport resizing', () => {
    const previous = geometry({ scrollTop: 420 })
    const current = geometry({ clientHeight: 360, viewportHeight: 360 })

    // UX-19: the composer growing or the window shrinking must not move a reader
    // who is above the bottom. Preserving their bottom gap moved them by exactly
    // the viewport delta; their anchor is the message they were reading, and the
    // content coordinates of that message do not change here.
    expect(resolveChatResizeScrollTop(previous, current, false)).toBeNull()
    // A pinned reader still follows the edge its anchor really is.
    expect(resolveChatResizeScrollTop(geometry({ scrollTop: 600 }), current, true)).toBe(640)
  })
})

describe('chat visible anchor', () => {
  const probes: ChatAnchorProbe[] = [
    { key: 'm1', top: -640, bottom: -520 },
    { key: 'm2', top: -120, bottom: 40 },
    { key: 'm3', top: 40, bottom: 260 },
    { key: 'm4', top: 260, bottom: 420 },
  ]

  it('names the first message still on screen as the reader position', () => {
    expect(selectChatVisibleAnchor(probes, 400)).toEqual({ key: 'm2', top: -120 })
  })

  it('returns nothing when no keyed message is on screen', () => {
    expect(selectChatVisibleAnchor([{ key: 'm1', top: -900, bottom: -700 }], 400)).toBeNull()
    expect(selectChatVisibleAnchor([], 400)).toBeNull()
    expect(selectChatVisibleAnchor([{ key: 'm1', top: 900, bottom: 1_100 }], 400)).toBeNull()
  })

  it('corrects the scroll position by the anchor drift after a reflow', () => {
    const anchor = { key: 'm2', top: -120 }
    // Narrowing the pane re-wrapped the paragraphs above, pushing the anchor down 60px.
    const reflowed: ChatAnchorProbe[] = [
      { key: 'm1', top: -700, bottom: -560 },
      { key: 'm2', top: -60, bottom: 100 },
      { key: 'm3', top: 100, bottom: 320 },
    ]

    expect(resolveAnchoredScrollTop(anchor, reflowed, 620)).toBe(680)
  })

  it('refuses to guess when the anchored message is gone', () => {
    const anchor = { key: 'm2', top: -120 }
    expect(resolveAnchoredScrollTop(anchor, [{ key: 'm9', top: 0, bottom: 40 }], 620)).toBeNull()
  })

  it('never resolves to a negative scroll offset', () => {
    const anchor = { key: 'm2', top: -120 }
    expect(resolveAnchoredScrollTop(anchor, [{ key: 'm2', top: -400, bottom: -200 }], 100)).toBe(0)
  })

  it('uses the message key attribute the transcript actually renders', () => {
    expect(CHAT_MESSAGE_ANCHOR_ATTRIBUTE).toBe('data-message-key')
  })
})
