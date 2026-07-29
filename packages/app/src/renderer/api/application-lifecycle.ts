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
import { localApiResponseError, localApiUrl } from './common'

export async function listActiveRuns(signal?: AbortSignal): Promise<RuntimeActiveRunSnapshot[]> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.activeRuns), { signal })
  if (!response.ok) throw await localApiResponseError(response)
  const payload = await response.json() as { runs: RuntimeActiveRunSnapshot[] }
  return payload.runs
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
