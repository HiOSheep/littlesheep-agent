import { describe, expect, it, vi } from 'vitest'
import {
  bindFetchCompatiblePort,
  isFetchBlockedPort,
  type LoopbackPortBinder,
} from './fetch-compatible-port.js'

function binderReturning(...ports: number[]): LoopbackPortBinder & {
  bind: ReturnType<typeof vi.fn<(requestedPort: number) => Promise<number>>>
  release: ReturnType<typeof vi.fn<() => Promise<void>>>
} {
  return {
    bind: vi.fn(async (_requestedPort: number) => {
      const port = ports.shift()
      if (port === undefined) throw new Error('missing test port')
      return port
    }),
    release: vi.fn(async () => undefined),
  }
}

describe('bindFetchCompatiblePort', () => {
  it('rebinds an OS-assigned port blocked by Fetch', async () => {
    const binder = binderReturning(6000, 49_152)

    await expect(bindFetchCompatiblePort(0, binder)).resolves.toBe(49_152)
    expect(binder.bind).toHaveBeenCalledTimes(2)
    expect(binder.bind).toHaveBeenNthCalledWith(1, 0)
    expect(binder.bind).toHaveBeenNthCalledWith(2, 0)
    expect(binder.release).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite an explicitly requested port', async () => {
    const binder = binderReturning(6000)

    await expect(bindFetchCompatiblePort(6000, binder)).resolves.toBe(6000)
    expect(binder.bind).toHaveBeenCalledOnce()
    expect(binder.release).not.toHaveBeenCalled()
  })

  it('closes every blocked binding before the attempt limit fails', async () => {
    const binder = binderReturning(6000, 6667, 10080)

    await expect(bindFetchCompatiblePort(0, binder, 3)).rejects.toThrow(
      'could not bind a Fetch-compatible loopback port after 3 attempts',
    )
    expect(binder.bind).toHaveBeenCalledTimes(3)
    expect(binder.release).toHaveBeenCalledTimes(3)
  })
})

describe('isFetchBlockedPort', () => {
  it('matches the Fetch port-blocking policy used by Local App API clients', () => {
    expect(isFetchBlockedPort(6000)).toBe(true)
    expect(isFetchBlockedPort(10080)).toBe(true)
    expect(isFetchBlockedPort(49_152)).toBe(false)
  })
})
