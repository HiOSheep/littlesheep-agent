import { describe, expect, it } from 'vitest'
import { createDisplayFrameGate } from './display-frame'

describe('display frame gate', () => {
  it('coalesces unchanged invalidations until the display frame runs', () => {
    let nextHandle = 1
    const callbacks = new Map<number, (timestamp: number) => void>()
    const cancelled: number[] = []
    const gate = createDisplayFrameGate(
      (callback) => {
        const handle = nextHandle++
        callbacks.set(handle, callback)
        return handle
      },
      (handle) => {
        cancelled.push(handle)
        callbacks.delete(handle)
      },
    )
    const seen: number[] = []

    gate.request((timestamp) => seen.push(timestamp))
    gate.request((timestamp) => seen.push(timestamp + 1))
    expect(callbacks).toHaveLength(1)
    expect(gate.pending).toBe(true)

    const firstCallback = callbacks.get(1)
    callbacks.delete(1)
    firstCallback?.(16)
    expect(seen).toEqual([16])
    expect(gate.pending).toBe(false)

    gate.request((timestamp) => seen.push(timestamp + 2))
    expect(callbacks).toHaveLength(1)
    const secondCallback = callbacks.get(2)
    callbacks.delete(2)
    secondCallback?.(32)
    expect(seen).toEqual([16, 34])
  })

  it('cancels a pending frame and releases the handle', () => {
    let callback: ((timestamp: number) => void) | undefined
    const gate = createDisplayFrameGate(
      (next) => {
        callback = next
        return 7
      },
      (handle) => expect(handle).toBe(7),
    )

    gate.request(() => undefined)
    gate.cancel()
    gate.cancel()
    expect(gate.pending).toBe(false)
    callback?.(16)
    expect(gate.pending).toBe(false)
  })
})
