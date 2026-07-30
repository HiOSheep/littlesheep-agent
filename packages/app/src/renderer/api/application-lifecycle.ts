import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunActionOutcome,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import { localApiResponseError, localApiUrl, parseSseFrame } from './common'

export async function listActiveRuns(signal?: AbortSignal): Promise<RuntimeActiveRunSnapshot[]> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.activeRuns), { signal })
  if (!response.ok) throw await localApiResponseError(response)
  const payload = await response.json() as { runs: RuntimeActiveRunSnapshot[] }
  return payload.runs
}

export async function subscribeActiveRuns(
  signal: AbortSignal,
  onRuns: (runs: RuntimeActiveRunSnapshot[]) => void,
): Promise<void> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.activeRunsStream), { signal })
  if (!response.ok) throw await localApiResponseError(response)
  if (!response.body) throw new Error('Active run stream has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const event = parseSseFrame(frame)
        if (!event) continue
        if (event.name === 'error') {
          throw new Error(String((event.data as { error?: string }).error ?? 'active run stream failed'))
        }
        if (event.name !== 'active_runs') continue
        const runs = (event.data as { runs?: unknown }).runs
        if (!Array.isArray(runs)) throw new Error('Active run stream returned invalid state')
        onRuns(runs as RuntimeActiveRunSnapshot[])
      }
      if (done) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function controlActiveRun(
  runId: string,
  action: RuntimeActiveRunAction,
  reason?: string,
): Promise<RuntimeActiveRunActionOutcome> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.activeRuns, runId, '/control')
  const response = await fetch(localApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
  })
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw await localApiResponseError(response)
  }
  const payload = await response.json() as { outcome: RuntimeActiveRunActionOutcome }
  return payload.outcome
}
