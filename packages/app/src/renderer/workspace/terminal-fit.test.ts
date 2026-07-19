import { describe, expect, it } from 'vitest'
import { createDisplayFrameGate } from '../ui/display-frame'
import { createTerminalFitScheduler } from './terminal-fit'

describe('terminal fit scheduler', () => {
  it('does not schedule a second frame for an unchanged host size', () => {
    let size = { width: 400, height: 240, devicePixelRatio: 1.25 }
    const callbacks: Array<(timestamp: number) => void> = []
    let scheduled = 0
    let fit = 0
    const frame = createDisplayFrameGate(
      (callback) => {
        callbacks.push(callback)
        scheduled += 1
        return scheduled
      },
      () => undefined,
    )
    const scheduler = createTerminalFitScheduler(
      () => size,
      () => { fit += 1 },
      frame,
    )

    scheduler.schedule(true)
    scheduler.schedule()
    expect(scheduled).toBe(1)
    expect(fit).toBe(0)
    callbacks.shift()?.(16)
    expect(fit).toBe(1)

    size = { ...size, width: 401 }
    scheduler.schedule()
    expect(scheduled).toBe(2)
    callbacks.shift()?.(32)
    expect(fit).toBe(2)
  })

  it('refits when display scaling changes without a CSS size change', () => {
    let size = { width: 400, height: 240, devicePixelRatio: 1.25 }
    const callbacks: Array<(timestamp: number) => void> = []
    let fit = 0
    const frame = createDisplayFrameGate(
      (callback) => {
        callbacks.push(callback)
        return callbacks.length
      },
      () => undefined,
    )
    const scheduler = createTerminalFitScheduler(
      () => size,
      () => { fit += 1 },
      frame,
    )

    scheduler.schedule(true)
    callbacks.shift()?.(16)
    size = { ...size, devicePixelRatio: 1.5 }
    scheduler.schedule()
    callbacks.shift()?.(32)

    expect(fit).toBe(2)
  })

  it('ignores subpixel CSS jitter that maps to the same physical geometry', () => {
    let size = { width: 400, height: 240, devicePixelRatio: 1.25 }
    const callbacks: Array<(timestamp: number) => void> = []
    let scheduled = 0
    const frame = createDisplayFrameGate(
      (callback) => {
        callbacks.push(callback)
        scheduled += 1
        return scheduled
      },
      () => undefined,
    )
    const scheduler = createTerminalFitScheduler(
      () => size,
      () => undefined,
      frame,
    )

    scheduler.schedule(true)
    callbacks.shift()?.(16)
    size = { ...size, width: 400.1 }
    scheduler.schedule()

    expect(scheduled).toBe(1)
  })
})
