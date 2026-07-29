// Startup checkpoint discovery, inspection, abandonment and streamed continuation.

import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import type {
  LocalAppRunCheckpointAbandonResponse,
  LocalAppRunCheckpointDetail,
  LocalAppRunCheckpointInspectResponse,
  LocalAppRunCheckpointListResponse,
  LocalAppRunCheckpointResumeRequest,
} from '../../shared/run-checkpoint-contracts'
import { localApiResponseError, localApiUrl } from './common'
import { consumeRunStream, type RunResult, type RunStreamHandlers } from './run'

export async function listRunCheckpoints(): Promise<LocalAppRunCheckpointListResponse> {
  const response = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runCheckpoints))
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<LocalAppRunCheckpointListResponse>
}

export async function inspectRunCheckpoint(checkpointId: string): Promise<LocalAppRunCheckpointDetail> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, checkpointId)
  const response = await fetch(localApiUrl(path))
  if (!response.ok) throw await localApiResponseError(response)
  const payload = await response.json() as LocalAppRunCheckpointInspectResponse
  return payload.checkpoint
}

export async function abandonRunCheckpoint(
  checkpointId: string,
  reason = 'user abandoned checkpoint from the desktop app',
): Promise<LocalAppRunCheckpointAbandonResponse> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, checkpointId, '/abandon')
  const response = await fetch(localApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  if (!response.ok) throw await localApiResponseError(response)
  return response.json() as Promise<LocalAppRunCheckpointAbandonResponse>
}

export async function resumeRunCheckpointStream(
  checkpointId: string,
  request: LocalAppRunCheckpointResumeRequest,
  handlers: RunStreamHandlers,
): Promise<RunResult> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, checkpointId, '/resume/stream')
  const response = await fetch(localApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: handlers.signal,
  })
  return consumeRunStream(response, handlers)
}
