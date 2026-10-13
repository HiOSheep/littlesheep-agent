import type { ContextInspection } from '../../shared/context-inspector-contracts'
import { LOCAL_APP_API_PREFIXES, SESSION_CONTEXT_SUFFIX, localAppApiItemPath } from '../../shared/local-app-api-routes'
import { localApiFetch, localApiResponseError } from './common'

export async function fetchContextInspection(sessionId: string, signal?: AbortSignal): Promise<ContextInspection> {
  const response = await localApiFetch(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, sessionId, SESSION_CONTEXT_SUFFIX), { signal })
  if (!response.ok) throw await localApiResponseError(response)
  const data = await response.json() as ContextInspection
  if (data.version !== 1 || data.sessionId !== sessionId || !Array.isArray(data.requests)) {
    throw new Error('上下文快照与当前会话不匹配。')
  }
  return data
}
