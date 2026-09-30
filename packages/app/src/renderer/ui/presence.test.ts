import { describe, expect, it } from 'vitest'
import { presenceMotionPlan } from './presence'

describe('presence motion lifecycle', () => {
  it('removes frame setup and exit delay when reduced motion is requested', () => {
    expect(presenceMotionPlan(true, 190, 2)).toEqual({ durationMs: 0, entryFrames: 0 })
    expect(presenceMotionPlan(true, 560, 1)).toEqual({ durationMs: 0, entryFrames: 0 })
  })

  it('keeps the configured frame and bounded duration when motion is enabled', () => {
    expect(presenceMotionPlan(false, 190, 2)).toEqual({ durationMs: 190, entryFrames: 2 })
    expect(presenceMotionPlan(false, -5, 1)).toEqual({ durationMs: 0, entryFrames: 1 })
  })
})
