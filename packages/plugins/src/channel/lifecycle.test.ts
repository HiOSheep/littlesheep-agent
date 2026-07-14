import { describe, expect, it, vi } from 'vitest'
import { abortableDelay } from './lifecycle.js'

describe('abortableDelay', () => {
  it('removes its abort listener after a normal delay', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = abortableDelay(25, controller.signal)

      await vi.advanceTimersByTimeAsync(25)
      await pending

      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the timer and removes its listener when aborted', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = abortableDelay(25_000, controller.signal)

      controller.abort()
      await pending
      await vi.advanceTimersByTimeAsync(25_000)

      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }
  })
})
