import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '@littlesheep/runner'
import { RunRouter } from './run-routes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RunRouter durable recovery', () => {
  it('does not hold modern startup behind a historical event scan', async () => {
    let releaseScan: (() => void) | undefined
    const scan = new Promise<Array<{ sessionId: string; runId: string }>>((resolve) => {
      releaseScan = () => resolve([{ sessionId: 'legacy-session', runId: 'legacy-run' }])
    })
    const recoverDurableRun = vi.fn().mockResolvedValue({ actions: [], projection: {} })
    const runner = {
      infra: {
        durableEventStore: { listRuns: vi.fn(() => scan) },
        durableInboxStore: {
          listActiveClaimedRuns: vi.fn().mockResolvedValue([]),
          listRecoverableRuns: vi.fn().mockResolvedValue([]),
          nextClaimLeaseExpiry: vi.fn().mockResolvedValue(undefined),
        },
        durableRunLeaseStore: {
          read: vi.fn().mockResolvedValue(null),
          listActiveRuns: vi.fn().mockResolvedValue([]),
          listRecoverableRuns: vi.fn().mockResolvedValue([]),
          nextLeaseExpiry: vi.fn().mockResolvedValue(undefined),
        },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    expect(recoverDurableRun).not.toHaveBeenCalled()
    releaseScan?.()
    await vi.waitFor(() => expect(recoverDurableRun).toHaveBeenCalledWith('legacy-session', 'legacy-run'))
    router.stop()
  })

  it('retries recovery when an inherited inbox claim lease expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
    const listRecoverableRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        sessionId: 'session-a',
        runId: 'run-a',
      }])
    const listActiveClaimedRuns = vi.fn()
      .mockResolvedValueOnce([{ sessionId: 'session-a', runId: 'run-a' }])
      .mockResolvedValueOnce([])
    const nextClaimLeaseExpiry = vi.fn()
      .mockResolvedValueOnce('2026-09-10T00:00:01.000Z')
      .mockResolvedValueOnce(undefined)
    const recoverDurableRun = vi.fn().mockResolvedValue({
      sessionId: 'session-a',
      runId: 'run-a',
      actions: [],
      projection: {},
    })
    const runner = {
      infra: {
        durableEventStore: { listRuns: vi.fn().mockResolvedValue([{ sessionId: 'session-a', runId: 'run-a' }]) },
        durableInboxStore: { listRecoverableRuns, listActiveClaimedRuns, nextClaimLeaseExpiry },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    expect(recoverDurableRun).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(recoverDurableRun).toHaveBeenCalledTimes(1)
    expect(nextClaimLeaseExpiry).toHaveBeenCalledTimes(2)
    router.stop()
  })

  it('does not recover an event-backed run until its durable run lease expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
    const activeRuns = vi.fn()
      .mockResolvedValueOnce([{ sessionId: 'session-a', runId: 'run-a' }])
      .mockResolvedValueOnce([])
    const recoverableRuns = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sessionId: 'session-a', runId: 'run-a' }])
    const nextLeaseExpiry = vi.fn()
      .mockResolvedValueOnce('2026-09-10T00:00:01.000Z')
      .mockResolvedValueOnce(undefined)
    const recoverDurableRun = vi.fn().mockResolvedValue({ actions: [], projection: {} })
    const runner = {
      infra: {
        durableEventStore: { listRuns: vi.fn().mockResolvedValue([{ sessionId: 'session-a', runId: 'run-a' }]) },
        durableRunLeaseStore: {
          read: vi.fn().mockResolvedValue({ status: 'active' }),
          listActiveRuns: activeRuns,
          listRecoverableRuns: recoverableRuns,
          nextLeaseExpiry,
        },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    expect(recoverDurableRun).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(recoverDurableRun).toHaveBeenCalledTimes(1)
    router.stop()
  })

  it('keeps recovering other runs when one durable run cannot be rebuilt', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const recoverDurableRun = vi.fn(async (_sessionId: string, runId: string) => {
      if (runId === 'run-corrupt') throw new Error('event store corrupt')
      return { sessionId: 'session-a', runId, actions: [], projection: {} }
    })
    const runner = {
      infra: {
        durableEventStore: {
          listRuns: vi.fn().mockResolvedValue([
            { sessionId: 'session-a', runId: 'run-first' },
            { sessionId: 'session-a', runId: 'run-corrupt' },
            { sessionId: 'session-a', runId: 'run-last' },
          ]),
        },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    expect(recoverDurableRun.mock.calls.map((call) => call[1])).toEqual([
      'run-corrupt',
      'run-first',
      'run-last',
    ])
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('recovery failed for run-corrupt'))
    router.stop()
  })

  it('keeps startup alive when durable run discovery itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const recoverDurableRun = vi.fn()
    const runner = {
      infra: {
        durableEventStore: { listRuns: vi.fn().mockRejectedValue(new Error('event index unreadable')) },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    expect(recoverDurableRun).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('run recovery discovery failed'))
    router.stop()
  })
})
