// Which retry affordance a failed readiness state may show.

import { describe, expect, it } from 'vitest'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'
import { executionRetryUiState, MAX_EXECUTION_RETRY_ATTEMPTS } from './execution-retry-state'

function readiness(state: RuntimeReadiness['state'], retryable = true): RuntimeReadiness {
  return { apiVersion: 1, state, phase: 'execution', reason: 'runner: no provider', retryable }
}

describe('execution retry affordance', () => {
  it('offers the control only for a retryable failure', () => {
    expect(executionRetryUiState({ readiness: readiness('failed'), pending: false, attemptsUsed: 0 }).canRetry).toBe(true)
    expect(executionRetryUiState({ readiness: readiness('failed', false), pending: false, attemptsUsed: 0 }).canRetry).toBe(false)
    expect(executionRetryUiState({ readiness: readiness('starting'), pending: false, attemptsUsed: 0 }).canRetry).toBe(false)
    expect(executionRetryUiState({ readiness: readiness('ready'), pending: false, attemptsUsed: 0 }).canRetry).toBe(false)
    expect(executionRetryUiState({ readiness: undefined, pending: false, attemptsUsed: 0 }).canRetry).toBe(false)
  })

  it('stops offering once the attempts Main granted are spent', () => {
    const spent = executionRetryUiState({
      readiness: readiness('failed'),
      pending: false,
      attemptsUsed: MAX_EXECUTION_RETRY_ATTEMPTS,
    })
    expect(spent.canRetry).toBe(false)
    expect(spent.attemptsRemaining).toBe(0)

    const last = executionRetryUiState({
      readiness: readiness('failed'),
      pending: false,
      attemptsUsed: MAX_EXECUTION_RETRY_ATTEMPTS - 1,
    })
    expect(last.canRetry).toBe(true)
    expect(last.attemptsRemaining).toBe(1)
  })

  it('reports progress instead of inviting a second click while a retry runs', () => {
    const pending = executionRetryUiState({ readiness: readiness('failed'), pending: true, attemptsUsed: 1 })
    expect(pending.canRetry).toBe(false)
    expect(pending.pending).toBe(true)
    expect(pending.label).toBe('正在重试…')
  })

  it('ignores a negative attempt count instead of offering extra attempts', () => {
    const state = executionRetryUiState({ readiness: readiness('failed'), pending: false, attemptsUsed: -5 })
    expect(state.attemptsUsed).toBe(0)
    expect(state.attemptsRemaining).toBe(MAX_EXECUTION_RETRY_ATTEMPTS)
  })
})
