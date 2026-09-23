// Shared renderer API transport helpers. Domain clients only depend on these
// helpers and the canonical route/contract modules.
//
// The window mounts before the Local App API exists, so this module never
// snapshots the loopback port at import time. `localApiFetch` waits for the
// preload to report the port, which means a request that starts during startup
// is still answered by the same listener instead of failing against port 0.

import type { WindowDragPoint } from '../../shared/window-drag-contracts'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'
import type { RendererTimingStage } from '../../shared/runtime-readiness-ipc'

declare global {
  interface Window {
    littlesheep: {
      /** Legacy fixed base URL. Kept for tests and for preloads that predate readiness. */
      apiBase?: string
      localApiBase?: () => Promise<string>
      getRuntimeReadiness?: () => Promise<RuntimeReadiness | undefined>
      onRuntimeReadiness?: (listener: (state: RuntimeReadiness) => void) => () => void
      reportRendererTiming?: (stage: RendererTimingStage, durationMs: number) => void
      getPathForFile?: (file: unknown) => string
      onBrowserOpenNewTab?: (listener: (event: { url: string; disposition?: string }) => void) => () => void
      onApplicationStateFlush?: (listener: () => void) => () => void
      startWindowDrag?: (point: WindowDragPoint) => void
      moveWindowDrag?: (point: WindowDragPoint) => void
      endWindowDrag?: () => void
    }
  }
}

const LOCAL_API_FALLBACK_BASE = 'http://127.0.0.1:0'

/**
 * Resolve the Local App API base URL once per renderer lifetime.
 *
 * Precedence: the readiness bridge (current contract) then the legacy static
 * `apiBase` field, which test harnesses and older preloads still provide.
 */
let resolvedBase: string | undefined
export function localApiBase(): Promise<string> {
  if (resolvedBase !== undefined) return Promise.resolve(resolvedBase)
  const bridge = window.littlesheep
  if (bridge?.localApiBase) {
    return bridge.localApiBase().then((base) => {
      resolvedBase = base
      return base
    })
  }
  resolvedBase = bridge?.apiBase ?? LOCAL_API_FALLBACK_BASE
  return Promise.resolve(resolvedBase)
}

/** Synchronous base URL for callers that already know the API is ready. */
export function localApiUrlSync(path: string): string {
  const base = resolvedBase ?? window.littlesheep?.apiBase ?? LOCAL_API_FALLBACK_BASE
  return `${base}${path}`
}

/**
 * Fetch a Local App API path, waiting for the listener when startup is still in
 * progress. Callers keep their existing error handling; a Runtime that never
 * becomes available rejects with the bridge's real reason.
 */
export async function localApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${await localApiBase()}${path}`, init)
}

/** Compatibility helper for pure-URL callers (websocket-free paths only). */
export function localApiUrl(path: string): string {
  return localApiUrlSync(path)
}

export interface LocalApiError extends Error {
  status: number
}

export function localApiStatusError(status: number, message = `Local app API error: ${status}`): LocalApiError {
  const error = new Error(message) as LocalApiError
  error.status = status
  return error
}

export async function localApiResponseError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => null) as { error?: string } | null
  return localApiStatusError(res.status, data?.error ?? `Local app API error: ${res.status}`)
}

export function parseSseFrame(frame: string): { name: string; data: unknown } | null {
  let name = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      name = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return { name, data: JSON.parse(dataLines.join('\n')) }
}
