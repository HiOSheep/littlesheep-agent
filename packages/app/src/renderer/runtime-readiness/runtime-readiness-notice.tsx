// Startup failure strip.
//
// It carries exactly one case: the Runtime reported that execution cannot start.
// A normal start states its stage next to the send control instead
// (`composer-readiness-hint`), so ordinary startup does not put a bar across the
// window; a failure keeps the full-width surface because it must stay visible
// while the user reads the reason and decides whether to retry. It is not a
// progress bar: there is no percentage and no estimated time, only the reason
// Main reported.
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
  // Only a real failure earns the window-wide surface. `reason` is also set while
  // the Runtime is still starting, and that case belongs to the composer hint.
  if (!reason || readiness?.state !== 'failed') return null
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
      className="runtime-readiness-notice failed"
      role="status"
      aria-live="assertive"
    >
      <span>{`运行能力启动失败：${reason}`}</span>
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
