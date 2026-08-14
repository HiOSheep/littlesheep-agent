import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND,
  resolveWorkspaceTabLabelMotion,
} from './tab-label-motion'

describe('workspace tab label motion', () => {
  it('does not move labels that fit their viewport', () => {
    expect(resolveWorkspaceTabLabelMotion(120, 120)).toEqual({
      durationMs: 0,
      offsetPx: 0,
      overflowPx: 0,
    })
    expect(resolveWorkspaceTabLabelMotion(120, 121)).toEqual({
      durationMs: 0,
      offsetPx: 0,
      overflowPx: 0,
    })
  })

  it('moves exactly to the label end at one constant speed', () => {
    const shortOverflow = resolveWorkspaceTabLabelMotion(100, 132)
    const longOverflow = resolveWorkspaceTabLabelMotion(100, 164)

    expect(shortOverflow).toEqual({
      durationMs: 1_000,
      offsetPx: -32,
      overflowPx: 32,
    })
    expect(longOverflow).toEqual({
      durationMs: 2_000,
      offsetPx: -64,
      overflowPx: 64,
    })
    expect(longOverflow.overflowPx / (longOverflow.durationMs / 1_000)).toBe(
      WORKSPACE_TAB_LABEL_SCROLL_SPEED_PX_PER_SECOND,
    )
  })
})
