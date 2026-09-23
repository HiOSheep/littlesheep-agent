// The retry episode rules: bounded, single-flight, and honest about exhaustion.

import { describe, expect, it, vi } from 'vitest'
import { createExecutionRetryController, MAX_EXECUTION_RETRY_ATTEMPTS } from './execution-retry.js'

function createHarness(options: { failures?: number } = {}) {
  const failures = options.failures ?? 0
  let calls = 0
  const begin = vi.fn()
  const fail = vi.fn()
  const controller = createExecutionRetryController({
    onBegin: begin,
    onFailure: fail,
    attempt: async () => {
      calls += 1
      if (calls <= failures) throw new Error(`failure ${calls}`)
    },
  })
  return { controller, begin, fail, calls: () => calls }
}

describe('execution retry controller', () => {
  it('bounds consecutive failures and stops offering retries', async () => {
    const { controller, begin, fail, calls } = createHarness({ failures: Number.MAX_SAFE_INTEGER })

    for (let attempt = 1; attempt <= MAX_EXECUTION_RETRY_ATTEMPTS; attempt += 1) {
      const outcome = await controller.retry()
      expect(outcome.accepted).toBe(true)
      expect(outcome.attemptsUsed).toBe(attempt)
      expect(outcome.reason).toBe(`failure ${attempt}`)
      expect(fail).toHaveBeenLastCalledWith(`failure ${attempt}`, attempt < MAX_EXECUTION_RETRY_ATTEMPTS)
    }

    const refused = await controller.retry()
    expect(refused).toEqual({
      accepted: false,
      attemptsUsed: MAX_EXECUTION_RETRY_ATTEMPTS,
      attemptsRemaining: 0,
      refusedBecause: 'exhausted',
    })
    expect(calls()).toBe(MAX_EXECUTION_RETRY_ATTEMPTS)
    expect(begin).toHaveBeenCalledTimes(MAX_EXECUTION_RETRY_ATTEMPTS)
  })

  it('marks the failure retryable while attempts remain', async () => {
    const { controller, fail } = createHarness({ failures: 1 })

    const first = await controller.retry()
    expect(first.attemptsRemaining).toBe(MAX_EXECUTION_RETRY_ATTEMPTS - 1)
    expect(fail).toHaveBeenLastCalledWith('failure 1', true)

    const second = await controller.retry()
    expect(second.accepted).toBe(true)
    expect(second.reason).toBeUndefined()
  })

  it('resets the budget after a success so a later failure gets its own attempts', async () => {
    const flaky = { failures: 2 }
    const begin = vi.fn()
    const fail = vi.fn()
    let calls = 0
    const controller = createExecutionRetryController({
      onBegin: begin,
      onFailure: fail,
      attempt: async () => {
        calls += 1
        if (calls <= flaky.failures) throw new Error(`failure ${calls}`)
      },
    })

    expect((await controller.retry()).attemptsUsed).toBe(1)
    expect((await controller.retry()).attemptsUsed).toBe(2)
    const recovered = await controller.retry()
    expect(recovered.accepted).toBe(true)
    expect(recovered.attemptsUsed).toBe(0)
    expect(controller.attemptsRemaining()).toBe(MAX_EXECUTION_RETRY_ATTEMPTS)
  })

  it('runs one attempt at a time and refuses a concurrent click', async () => {
    let release: (() => void) | undefined
    const controller = createExecutionRetryController({
      onBegin: vi.fn(),
      onFailure: vi.fn(),
      attempt: () => new Promise<void>((resolve) => {
        release = resolve
      }),
    })

    const first = controller.retry()
    const concurrent = await controller.retry()
    expect(concurrent.accepted).toBe(false)
    expect(concurrent.refusedBecause).toBe('in-flight')

    release?.()
    await expect(first).resolves.toMatchObject({ accepted: true, attemptsUsed: 0 })
  })

  it('reports a failure that is not an Error without losing the text', async () => {
    const fail = vi.fn()
    const controller = createExecutionRetryController({
      onBegin: vi.fn(),
      onFailure: fail,
      attempt: async () => {
        throw 'plain string failure'
      },
    })

    const outcome = await controller.retry()
    expect(outcome.reason).toBe('plain string failure')
    expect(fail).toHaveBeenCalledWith('plain string failure', true)
  })
})
