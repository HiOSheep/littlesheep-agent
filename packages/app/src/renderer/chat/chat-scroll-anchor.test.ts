import { describe, expect, it } from 'vitest'
import {
  didChatViewportResize,
  resolveBottomAnchoredScrollTop,
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
    expect(didChatViewportResize(previous, geometry({ viewportWidth: 699.5 }))).toBe(true)
    expect(didChatViewportResize(previous, geometry({ viewportHeight: 399.5 }))).toBe(true)
  })
})
