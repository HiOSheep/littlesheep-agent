// Retry affordance state for a failed execution start.
//
// Pure on purpose: the notice renders it, the tests pin it, and the rules about
// when a retry may be offered live here rather than in JSX conditions.

import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

/** Mirrors Main's bound; the renderer never widens it, it only stops offering. */
export const MAX_EXECUTION_RETRY_ATTEMPTS = 3

export interface ExecutionRetryUiState {
  /** The retry control is offered. */
  canRetry: boolean
  /** A retry is running right now. */
  pending: boolean
  label: string
  /** Attempts already spent in this window, as reported by Main. */
  attemptsUsed: number
  attemptsRemaining: number
}

export interface ExecutionRetryUiInput {
  readiness: RuntimeReadiness | undefined
  pending: boolean
  attemptsUsed: number
  maxAttempts?: number
}

/**
 * Only a *retryable* failure offers the control: an exhausted budget or a
 * non-retryable failure would make the button a promise the app cannot keep.
 * While a retry runs, the control reports progress instead of inviting a second
 * click - Main also refuses concurrent retries, and both must agree.
 */
export function executionRetryUiState(input: ExecutionRetryUiInput): ExecutionRetryUiState {
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_EXECUTION_RETRY_ATTEMPTS)
  const attemptsUsed = Math.max(0, input.attemptsUsed)
  const attemptsRemaining = Math.max(0, maxAttempts - attemptsUsed)
  const failed = input.readiness?.state === 'failed'
  const retryable = failed && input.readiness?.retryable === true && attemptsRemaining > 0
  return {
    canRetry: retryable && !input.pending,
    pending: input.pending,
    label: input.pending ? '正在重试…' : '重试启动运行能力',
    attemptsUsed,
    attemptsRemaining,
  }
}
