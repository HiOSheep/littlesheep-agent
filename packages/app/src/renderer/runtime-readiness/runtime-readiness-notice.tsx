// Thin startup status strip.
//
// It reports the Runtime's own readiness fact while execution is unavailable.
// It is not a progress bar: there is no percentage and no estimated time, only
// the stage the Main process is actually in and the reason it reported.

import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

export function RuntimeReadinessNotice({
  readiness,
  reason,
}: {
  readiness: RuntimeReadiness | undefined
  reason: string | null
}) {
  if (!reason) return null
  const failed = readiness?.state === 'failed'
  return (
    <div
      className={`runtime-readiness-notice${failed ? ' failed' : ''}`}
      role="status"
      aria-live={failed ? 'assertive' : 'polite'}
    >
      {failed ? `运行能力启动失败：${reason}` : reason}
    </div>
  )
}
