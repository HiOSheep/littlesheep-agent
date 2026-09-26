// Workspace selection, file browsing, layout and artifact clients.

import type {
  WorkspaceArtifactRecord,
  WorkspaceLayoutSnapshot,
} from '../../shared/workspace-contracts'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes'
import { localApiFetch, localApiResponseError, localApiStatusError } from './common'

export async function selectWorkspace(): Promise<string | null> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.workspaceSelect, { method: 'POST' })
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { path: string | null }
  return data.path
}

export interface WorkspaceEntry {
  name: string
  path: string
  relativePath: string
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
}

export interface WorkspaceDirectory {
  root: string
  path: string
  relativePath: string
  entries: WorkspaceEntry[]
  truncated: boolean
  hiddenCount: number
}

export type WorkspacePreview =
  | {
    kind: 'text'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    language: string
    content: string
  }
  | {
    kind: 'markdown'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    content: string
  }
  | {
    kind: 'html'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    content: string
  }
  | {
    kind: 'image' | 'pdf' | 'unsupported'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    reason?: string
  }
  | {
    kind: 'office'
    path: string
    name: string
    relativePath: string
    size: number
    modifiedAt?: number
    officeKind: 'document' | 'spreadsheet' | 'presentation'
    sections: Array<{
      title: string
      paragraphs?: string[]
      rows?: string[][]
    }>
    truncated: boolean
    note?: string
  }

function workspaceQuery(root: string, path?: string): string {
  const params = new URLSearchParams({ root })
  if (path) params.set('path', path)
  return params.toString()
}

export async function listWorkspaceDirectory(root: string, path?: string, filter = ''): Promise<WorkspaceDirectory> {
  const params = new URLSearchParams(workspaceQuery(root, path))
  if (filter) params.set('filter', filter)
  const res = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspaceList}?${params.toString()}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<WorkspaceDirectory>
}

export async function previewWorkspaceFile(root: string, path: string): Promise<WorkspacePreview> {
  const res = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspacePreview}?${workspaceQuery(root, path)}`)
  // `localApiResponseError` keeps the status *and* the server's sentence: the pane needs
  // both to tell "this file changed on disk" (409, reload first) from "try again later".
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<WorkspacePreview>
}

export interface WorkspaceFileStat {
  path: string
  relativePath: string
  exists: boolean
  modifiedAt: number | null
  size: number | null
}

/**
 * Metadata-only check for the open file (UX-25 item 3): the pane uses it to notice an
 * external change or a deletion before a save has to fail with 409.
 */
export async function statWorkspaceFile(root: string, path: string): Promise<WorkspaceFileStat> {
  const res = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspaceFileStat}?${workspaceQuery(root, path)}`)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<WorkspaceFileStat>
}

export async function saveWorkspaceFile(
  root: string,
  path: string,
  content: string,
  expectedModifiedAt?: number,
  sessionId?: string,
): Promise<WorkspacePreview> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.workspaceSave, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path, content, expectedModifiedAt, sessionId }),
  })
  // `localApiResponseError` keeps the status *and* the server's sentence: the pane needs
  // both to tell "this file changed on disk" (409, reload first) from "try again later".
  if (!res.ok) throw await localApiResponseError(res)
  return res.json() as Promise<WorkspacePreview>
}

export async function readWorkspaceLayoutSnapshot(sessionId?: string): Promise<WorkspaceLayoutSnapshot | null> {
  const params = new URLSearchParams()
  if (sessionId) params.set('sessionId', sessionId)
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const res = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspaceLayout}${query}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { snapshot: WorkspaceLayoutSnapshot | null }
  return data.snapshot
}

export async function saveWorkspaceLayoutSnapshot(
  snapshot: Omit<WorkspaceLayoutSnapshot, 'version' | 'updatedAt'>,
): Promise<WorkspaceLayoutSnapshot> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.workspaceLayout, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { snapshot: WorkspaceLayoutSnapshot }
  return data.snapshot
}

export async function listWorkspaceArtifacts(
  root: string,
  sessionId?: string,
  limit = 50,
): Promise<WorkspaceArtifactRecord[]> {
  const params = new URLSearchParams({ root, limit: String(limit) })
  if (sessionId) params.set('sessionId', sessionId)
  const res = await localApiFetch(`${LOCAL_APP_API_ROUTES.workspaceArtifacts}?${params.toString()}`)
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  const data = await res.json() as { records: WorkspaceArtifactRecord[] }
  return data.records
}

export async function openWorkspacePath(root: string, path: string): Promise<void> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.workspaceOpen, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function openExternalHref(href: string): Promise<void> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.externalOpen, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ href }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}

export async function openWorkspacePathInVSCode(root: string, path?: string): Promise<void> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.workspaceOpenVscode, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, path: path ?? root }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
}
