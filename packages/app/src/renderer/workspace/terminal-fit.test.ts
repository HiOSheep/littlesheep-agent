import { describe, expect, it } from 'vitest'
import { createDisplayFrameGate } from '../ui/display-frame'
import { createTerminalFitScheduler } from './terminal-fit'

describe('terminal fit scheduler', () => {
  it('does not schedule a second frame for an unchanged host size', () => {
    let size = { width: 400, height: 240 }
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

    size = { width: 401, height: 240 }
    scheduler.schedule()
    expect(scheduled).toBe(2)
    callbacks.shift()?.(32)
    expect(fit).toBe(2)
  })
})
