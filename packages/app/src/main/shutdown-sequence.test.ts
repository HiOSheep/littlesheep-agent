import { describe, expect, it, vi } from 'vitest'
import { runShutdownSequence } from './shutdown-sequence.js'

describe('runShutdownSequence', () => {
  it('runs cleanup steps in dependency order', async () => {
    const calls: string[] = []

    await runShutdownSequence([
      { name: 'server', run: () => { calls.push('server') } },
      { name: 'channels', run: () => { calls.push('channels') } },
      { name: 'runner', run: () => { calls.push('runner') } },
    ])

    expect(calls).toEqual(['server', 'channels', 'runner'])
  })

  it('continues after a cleanup step times out', async () => {
    const calls: string[] = []
    const warnings: string[] = []

    await runShutdownSequence([
      { name: 'stuck', run: () => new Promise<void>(() => undefined) },
      { name: 'next', run: () => { calls.push('next') } },
    ], {
      stepTimeoutMs: 10,
      onWarning: (message) => warnings.push(message),
    })

    expect(calls).toEqual(['next'])
    expect(warnings).toEqual([expect.stringContaining('stuck cleanup exceeded 10ms')])
  })

  it('reports failures and continues', async () => {
    const next = vi.fn()
    const warnings: string[] = []

    await runShutdownSequence([
      { name: 'broken', run: () => { throw new Error('boom') } },
      { name: 'next', run: next },
    ], { onWarning: (message) => warnings.push(message) })

    expect(next).toHaveBeenCalledOnce()
    expect(warnings).toEqual(['broken cleanup failed: boom'])
  })
})
