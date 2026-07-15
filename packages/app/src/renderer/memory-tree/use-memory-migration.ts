import { useEffect, useRef, useState } from 'react'
import {
  cancelMemoryV3Operation,
  getMemoryV3MigrationPreflight,
  requestMemoryV3Migration,
  requestMemoryV3Rollback,
  restartApplication,
  type MemoryV3MigrationPreflightOverview,
} from '../api'

export function useMemoryMigration({
  active,
  onRegistered,
}: {
  active: boolean
  onRegistered: () => void
}) {
  const [preflight, setPreflight] = useState<MemoryV3MigrationPreflightOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const onRegisteredRef = useRef(onRegistered)
  onRegisteredRef.current = onRegistered

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (active && !preflight && !loading) void refresh()
  }, [active])

  async function refresh() {
    if (busyAction) return
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const result = await getMemoryV3MigrationPreflight(controller.signal)
      if (mountedRef.current && !controller.signal.aborted) setPreflight(result)
    } catch (cause) {
      if (mountedRef.current && !controller.signal.aborted) setError(errorMessage(cause))
    } finally {
      if (requestRef.current === controller) requestRef.current = null
      if (mountedRef.current) setLoading(false)
    }
  }

  async function request(action: 'migrate' | 'rollback') {
    if (busyAction) return
    requestRef.current?.abort()
    requestRef.current = null
    setBusyAction(action)
    setError(null)
    try {
      const next = action === 'migrate'
        ? await requestMemoryV3Migration()
        : await requestMemoryV3Rollback()
      if (!mountedRef.current) return
      setPreflight(next)
      onRegisteredRef.current()
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause))
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function cancel() {
    if (busyAction) return
    requestRef.current?.abort()
    requestRef.current = null
    setBusyAction('cancel')
    setError(null)
    try {
      const next = await cancelMemoryV3Operation()
      if (mountedRef.current) setPreflight(next)
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause))
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function restart() {
    if (busyAction) return
    setBusyAction('restart')
    setError(null)
    try {
      await restartApplication()
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
      setBusyAction(null)
    }
  }

  return { preflight, loading, busyAction, error, refresh, request, cancel, restart }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
