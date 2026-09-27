import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '@littlesheep/runner'
import { RunRouter } from './run-routes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RunRouter durable recovery', () => {
  /**
   * Wait for the pass to have reached its end.
   *
   * `waitForRecovery()` deliberately resolves without waiting for a session-less
   * caller, so it cannot be used to assert what the pass did. A named session is
   * the gate the run routes use, so this waits through exactly that.
   */
  async function settled(router: RunRouter): Promise<void> {
    await router.waitForRecovery('settled-session')
  }

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
    // The modern queue pass is what gates admission, and it is already settled:
    // the historical event scan is still blocked on `scan`.
    await settled(router)
    expect(recoverDurableRun).not.toHaveBeenCalled()
    releaseScan?.()
    await vi.waitFor(() => expect(recoverDurableRun).toHaveBeenCalledWith('legacy-session', 'legacy-run'))
    router.stop()
  })

  it('retries recovery when an inherited inbox claim lease expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
    const listRecoverableRuns = vi.fn().mockResolvedValue([])
    const listActiveClaimedRuns = vi.fn().mockResolvedValue([])
    const nextClaimLeaseExpiry = vi.fn()
      .mockResolvedValueOnce('2026-09-10T00:00:01.000Z')
      .mockResolvedValue(undefined)
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
        // The event-backed compatibility pass must not recover this run: it has a
        // lease, which is exactly the "do not overrun a live owner" rule.
        durableRunLeaseStore: {
          read: vi.fn().mockResolvedValue({ status: 'active' }),
          listActiveRuns: vi.fn().mockResolvedValue([]),
          listRecoverableRuns: vi.fn().mockResolvedValue([]),
          nextLeaseExpiry: vi.fn().mockResolvedValue(undefined),
        },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    // The initial pass finds no recoverable run but records the live claim's
    // expiry, so the wake-up is armed rather than polled.
    await vi.advanceTimersByTimeAsync(0)
    expect(recoverDurableRun).not.toHaveBeenCalled()
    expect(nextClaimLeaseExpiry).toHaveBeenCalledTimes(1)

    // The claim lease expires; the wake-up re-runs the queue pass, which now
    // finds a recoverable run.
    listRecoverableRuns.mockResolvedValue([{ sessionId: 'session-a', runId: 'run-a' }])
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(recoverDurableRun).toHaveBeenCalledWith('session-a', 'run-a'))
    expect(recoverDurableRun).toHaveBeenCalledTimes(1)
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
    await vi.advanceTimersByTimeAsync(0)
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
    await settled(router)
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
    await settled(router)
    expect(recoverDurableRun).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('run recovery discovery failed'))
    router.stop()
  })

  it('admits a fresh conversation without waiting for recovery', async () => {
    let releaseRecovery: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { releaseRecovery = resolve })
    const recoverDurableRun = vi.fn(async () => {
      await blocked
      return { actions: [], projection: {} }
    })
    const runner = {
      infra: {
        durableEventStore: {
          listRuns: vi.fn().mockResolvedValue([{ sessionId: 'session-a', runId: 'run-a' }]),
        },
      },
      recoverDurableRun,
    } as unknown as AgentRunner

    const router = await RunRouter.create(runner)
    // No session id: this is the first turn of a conversation that cannot have a
    // previous run, so nothing is awaited even though the pass is still running.
    await expect(router.waitForRecovery()).resolves.toBeUndefined()
    expect(recoverDurableRun).toHaveBeenCalledWith('session-a', 'run-a')
    // A named session waits for the same pass.
    let namedSettled = false
    const named = router.waitForRecovery('session-a').then(() => { namedSettled = true })
    await Promise.resolve()
    expect(namedSettled).toBe(false)
    releaseRecovery?.()
    await named
    expect(namedSettled).toBe(true)
    router.stop()
  })
})
