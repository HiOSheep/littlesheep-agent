import { describe, expect, it } from 'vitest'
import {
  FLOATING_HELP_VIEWPORT_MARGIN_PX,
  clampFloatingHelpTipPosition,
  resolveFloatingHelpLayout,
} from './floating-help'

describe('floating help positioning', () => {
  it('keeps a wide measured tooltip inside the viewport', () => {
    const position = clampFloatingHelpTipPosition(980, 740, 560, 160, 1024, 768)

    expect(position).toEqual({ x: 452, y: 596 })
  })

  it('keeps a compact tooltip beside its trigger when there is room', () => {
    const position = clampFloatingHelpTipPosition(114, 90, 96, 36, 1024, 768)

    expect(position).toEqual({ x: 114, y: 90 })
  })

  it('preserves the viewport margin in a constrained window', () => {
    const position = clampFloatingHelpTipPosition(-20, -10, 300, 120, 280, 100)

    expect(position).toEqual({
      x: FLOATING_HELP_VIEWPORT_MARGIN_PX,
      y: FLOATING_HELP_VIEWPORT_MARGIN_PX,
    })
  })

  it('places menu descriptions to the right when the side has room', () => {
    expect(resolveFloatingHelpLayout({
      placement: 'right',
      avoidRect: { left: 10, top: 8, right: 490, bottom: 194 },
    }, 795)).toEqual({
      placement: 'right',
      maxWidth: 283,
    })
  })

  it('falls back to the other side when the preferred side is constrained', () => {
    expect(resolveFloatingHelpLayout({
      placement: 'right',
      avoidRect: { left: 360, top: 8, right: 780, bottom: 194 },
    }, 795)).toEqual({
      placement: 'left',
      maxWidth: 338,
    })
  })
})
