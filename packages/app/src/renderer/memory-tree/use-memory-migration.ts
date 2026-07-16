import { useEffect, useRef, useState } from 'react'
import {
  cancelMemoryV3Operation,
  cancelMemoryEmbeddingModelPreparation,
  getMemoryEmbeddingModelStatus,
  getMemoryV3MigrationPreflight,
  prepareMemoryEmbeddingModel,
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

  useEffect(() => {
    if (!active || preflight?.embeddingModel?.state !== 'preparing') return
    let cancelled = false
    const controller = new AbortController()
    const poll = async () => {
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (cancelled) return
        try {
          const status = await getMemoryEmbeddingModelStatus(controller.signal)
          if (cancelled) return
          setPreflight((current) => current ? { ...current, embeddingModel: status } : current)
          if (status.state !== 'preparing') return
        } catch (cause) {
          if (!controller.signal.aborted) setError(errorMessage(cause))
          return
        }
      }
    }
    void poll()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [active, preflight?.embeddingModel?.state])

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

  async function prepareEmbedding() {
    if (busyAction) return
    setBusyAction('embedding-prepare')
    setError(null)
    try {
      const status = await prepareMemoryEmbeddingModel()
      if (mountedRef.current) {
        setPreflight((current) => current ? { ...current, embeddingModel: status } : current)
      }
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause))
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function cancelEmbedding() {
    if (busyAction) return
    setBusyAction('embedding-cancel')
    setError(null)
    try {
      const status = await cancelMemoryEmbeddingModelPreparation()
      if (mountedRef.current) {
        setPreflight((current) => current ? { ...current, embeddingModel: status } : current)
      }
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause))
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  return {
    preflight,
    loading,
    busyAction,
    error,
    refresh,
    request,
    cancel,
    restart,
    prepareEmbedding,
    cancelEmbedding,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
