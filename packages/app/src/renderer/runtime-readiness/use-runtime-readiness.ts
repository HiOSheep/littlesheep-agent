// Renderer view of the Main-process execution readiness.
//
// The window is interactive before the Runner exists, so the shell needs the
// real stage and reason instead of an empty sidebar that looks like missing
// data. The snapshot and subscription live in `runtime-readiness-state.ts` so
// non-React consumers observe exactly the same fact.

import { useEffect, useState } from 'react'
import {
  subscribeRuntimeReadiness,
  type RuntimeReadiness,
} from './runtime-readiness-state'

export interface RuntimeReadinessView {
  /** Undefined until the first snapshot arrives. */
  readiness: RuntimeReadiness | undefined
  /** True only when the Runtime reports execution is possible. */
  executable: boolean
  /** A user-visible reason while the Runtime is unavailable. */
  reason: string | null
}

export function useRuntimeReadiness(): RuntimeReadinessView {
  const [readiness, setReadiness] = useState<RuntimeReadiness | undefined>(undefined)

  useEffect(() => subscribeRuntimeReadiness(setReadiness), [])

  const executable = readiness?.state === 'ready'
  const reason = readiness && readiness.state !== 'ready'
    ? readiness.reason ?? '正在准备运行环境'
    : null
  return { readiness, executable, reason }
}
