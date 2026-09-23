// Renderer view of the Main-process execution readiness.
//
// The window is interactive before the Runner exists, so the shell needs the
// real stage and reason instead of an empty sidebar that looks like missing
// data. The snapshot is queried once and then kept current by subscription, so
// a transition that happened before this component mounted is never lost.

import { useEffect, useState } from 'react'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

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

  useEffect(() => {
    let active = true
    const bridge = window.littlesheep
    // Subscribe first, then repair with a query: a transition that lands between
    // the two is delivered by the listener, and one that already happened is
    // returned by the query.
    const unsubscribe = bridge?.onRuntimeReadiness?.((next) => {
      if (active) setReadiness(next)
    })
    void bridge?.getRuntimeReadiness?.()
      .then((snapshot) => {
        if (active && snapshot) setReadiness(snapshot)
      })
      .catch(() => undefined)
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  const executable = readiness?.state === 'ready'
  const reason = readiness && readiness.state !== 'ready'
    ? readiness.reason ?? '正在准备运行环境'
    : null
  return { readiness, executable, reason }
}
