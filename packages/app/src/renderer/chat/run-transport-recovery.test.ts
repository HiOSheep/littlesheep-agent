import { describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../api/run'
import { recoverCompletedRunAfterStreamLoss } from './run-transport-recovery'

describe('local run stream recovery', () => {
  it('uses the completed run with the same identity after the observer disconnects', async () => {
    const result = {
      runId: 'run-1', sessionId: 'session-1', status: 'ok', reply: '完整回答', durationMs: 1,
    } satisfies RunResult
    const replay = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(result)
    vi.useFakeTimers()
    try {
      const recovery = recoverCompletedRunAfterStreamLoss('run-1', new AbortController().signal, replay, 5_000)
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(recovery).resolves.toEqual(result)
      expect(replay).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting when the user cancels the run', async () => {
    const controller = new AbortController()
    const replay = vi.fn().mockResolvedValue(null)
    const recovery = recoverCompletedRunAfterStreamLoss('run-1', controller.signal, replay)
    controller.abort()
    await expect(recovery).rejects.toMatchObject({ name: 'AbortError' })
  })
})
