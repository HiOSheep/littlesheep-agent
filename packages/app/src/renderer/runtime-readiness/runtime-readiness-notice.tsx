// Thin startup status strip.
//
// It reports the Runtime's own readiness fact while execution is unavailable.
// It is not a progress bar: there is no percentage and no estimated time, only
// the stage the Main process is actually in and the reason it reported.
//
// A retryable failure also offers the bounded retry Main owns. The renderer never
// invents the bound: it counts what Main answered and stops offering the control
// once the budget is spent.

import { useState } from 'react'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'
import { executionRetryUiState } from './execution-retry-state'

function requestExecutionRetry(): ReturnType<NonNullable<Window['littlesheep']['retryExecution']>> | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.littlesheep
  if (!bridge?.retryExecution) return undefined
  return bridge.retryExecution()
}

export function RuntimeReadinessNotice({
  readiness,
  reason,
}: {
  readiness: RuntimeReadiness | undefined
  reason: string | null
}) {
  const [pending, setPending] = useState(false)
  const [attemptsUsed, setAttemptsUsed] = useState(0)
  if (!reason) return null
  const failed = readiness?.state === 'failed'
  const retry = executionRetryUiState({ readiness, pending, attemptsUsed })

  async function retryExecution(): Promise<void> {
    if (!retry.canRetry) return
    setPending(true)
    try {
      const outcome = await requestExecutionRetry()
      if (typeof outcome?.attemptsUsed === 'number') setAttemptsUsed(outcome.attemptsUsed)
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className={`runtime-readiness-notice${failed ? ' failed' : ''}`}
      role="status"
      aria-live={failed ? 'assertive' : 'polite'}
    >
      <span>{failed ? `运行能力启动失败：${reason}` : reason}</span>
      {(retry.canRetry || retry.pending) && (
        <button
          type="button"
          className="runtime-readiness-retry"
          onClick={() => void retryExecution()}
          disabled={!retry.canRetry}
        >
          {retry.label}
        </button>
      )}
    </div>
  )
}
