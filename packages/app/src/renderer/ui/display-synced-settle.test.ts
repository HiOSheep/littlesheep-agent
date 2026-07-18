import { describe, expect, it } from 'vitest'
import {
  DISPLAY_SETTLE_IDLE_MS,
  DISPLAY_SETTLE_MAX_MS,
  createDisplaySettleState,
  observeDisplaySettleFrame,
  shouldContinueDisplaySettle,
} from './display-synced-settle'

describe('display-synced settling', () => {
  function settleDuration(frameInterval: number): number {
    let timestamp = 0
    let state = createDisplaySettleState(timestamp, 'stable')
    do {
      timestamp += frameInterval
      state = observeDisplaySettleFrame(state, timestamp, 'stable')
    } while (shouldContinueDisplaySettle(state, timestamp))
    return timestamp
  }

  it('uses elapsed time instead of a fixed frame count', () => {
    let state = createDisplaySettleState(0, 'stable')
    state = observeDisplaySettleFrame(state, 16, 'stable')
    state = observeDisplaySettleFrame(state, 32, 'stable')
    expect(shouldContinueDisplaySettle(state, DISPLAY_SETTLE_IDLE_MS - 1)).toBe(true)
    expect(shouldContinueDisplaySettle(state, DISPLAY_SETTLE_IDLE_MS)).toBe(false)
  })

  it('keeps settling after a late layout change', () => {
    let state = createDisplaySettleState(0, 'initial')
    state = observeDisplaySettleFrame(state, 100, 'initial')
    state = observeDisplaySettleFrame(state, 150, 'expanded')
    expect(shouldContinueDisplaySettle(state, 150 + DISPLAY_SETTLE_IDLE_MS - 1)).toBe(true)
    expect(shouldContinueDisplaySettle(state, 150 + DISPLAY_SETTLE_IDLE_MS)).toBe(false)
  })

  it('always allows the minimum settling frames', () => {
    let state = createDisplaySettleState(0, 'stable')
    state = observeDisplaySettleFrame(state, 200, 'stable')
    expect(shouldContinueDisplaySettle(state, 200)).toBe(true)
  })

  it('keeps wall-clock settling nearly identical at 60Hz and 240Hz', () => {
    const at60Hz = settleDuration(1000 / 60)
    const at240Hz = settleDuration(1000 / 240)
    expect(Math.abs(at60Hz - at240Hz)).toBeLessThanOrEqual(1000 / 60)
  })

  it('has a hard upper bound for hostile or continuously changing layouts', () => {
    let state = createDisplaySettleState(0, '0')
    for (let frame = 1; frame <= 100; frame += 1) {
      state = observeDisplaySettleFrame(state, frame * 20, String(frame))
    }
    expect(shouldContinueDisplaySettle(state, DISPLAY_SETTLE_MAX_MS)).toBe(false)
  })
})
