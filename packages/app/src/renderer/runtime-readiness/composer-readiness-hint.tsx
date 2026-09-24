// Startup stage text, placed next to the send control.
//
// A normal start is short and does not deserve a bar across the window, but the
// user still needs to know why the send control is disabled and when it will
// work. So the Runtime's own stage sentence is stated inline, where the control
// it explains already sits, and it disappears the moment execution is ready.
//
// Only `starting` uses this surface. A failure is not a passing stage: it keeps
// the window-wide strip (`runtime-readiness-notice.tsx`) and its retry control,
// because a disabled send button alone would leave the reason invisible.

import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

export function ComposerReadinessHint({
  readiness,
  reason,
}: {
  readiness: RuntimeReadiness | undefined
  reason: string | null
}) {
  if (!reason || readiness?.state !== 'starting') return null
  return (
    <span className="composer-readiness-hint" role="status" aria-live="polite" title={reason}>
      {reason}
    </span>
  )
}
