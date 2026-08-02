// Session, project and archive API client.

import type { HistoryMessageRecord } from '../../shared/history-activity'
import type { RuntimeState } from '../../shared/runtime-api-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import type {
  ArchivePayload,
  ProjectMeta,
  SessionMeta,
} from '../../shared/session-project-contracts'
import { localApiStatusError, localApiUrl } from './common'

export async function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.sessions))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ sessions: SessionMeta[] }>
}

export async function listProjects(): Promise<{ projects: ProjectMeta[] }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projects))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ projects: ProjectMeta[] }>
}

export async function createProjectFolder(parentPath: string, name: string): Promise<{ path: string; project: ProjectMeta }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projectCreateFolder), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ path: string; project: ProjectMeta }>
}

export async function registerProject(path: string): Promise<{ project: ProjectMeta }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.projectRegister), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ project: ProjectMeta }>
}

export async function rebindProject(
  id: string,
  path: string,
): Promise<{ project: ProjectMeta; sessions: SessionMeta[]; recovered: boolean; runtime: RuntimeState }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.projects, id, '/rebind')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{
    project: ProjectMeta
    sessions: SessionMeta[]
    recovered: boolean
    runtime: RuntimeState
  }>
}

export async function deleteProject(id: string, opts: { hard?: boolean } = {}): Promise<void> {
  const suffix = opts.hard ? '?hard=1' : ''
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.projects, id, suffix)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteSession(id: string, opts: { hard?: boolean } = {}): Promise<void> {
  const suffix = opts.hard ? '?hard=1' : ''
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id, suffix)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function renameSession(id: string, title: string): Promise<{ session: SessionMeta }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id)), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<{ session: SessionMeta }>
}

export async function listArchive(): Promise<ArchivePayload> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.archive))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<ArchivePayload>
}

export async function restoreArchivedSession(id: string): Promise<{ session: SessionMeta; project?: ProjectMeta }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveSessions, id, '/restore')), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ session: SessionMeta; project?: ProjectMeta }>
}

export async function restoreArchivedProject(id: string): Promise<{ project: ProjectMeta; sessions: SessionMeta[] }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveProjects, id, '/restore')), { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ project: ProjectMeta; sessions: SessionMeta[] }>
}

export async function deleteArchivedSession(id: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveSessions, id)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export async function deleteArchivedProject(id: string): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.archiveProjects, id)), { method: 'DELETE' })
  if (!res.ok) throw localApiStatusError(res.status)
}

export interface SessionMessagePage {
  messages: HistoryMessageRecord[]
  hasMore: boolean
  beforeId?: string
}

export async function getSessionMessagePage(
  id: string,
  options: { limit?: number; beforeId?: string } = {},
): Promise<SessionMessagePage> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.beforeId) params.set('before', options.beforeId)
  const suffix = params.toString() ? `/messages?${params.toString()}` : '/messages'
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id, suffix)))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<SessionMessagePage>
}

export async function getSessionMessages(id: string): Promise<HistoryMessageRecord[]> {
  return (await getSessionMessagePage(id)).messages
}
