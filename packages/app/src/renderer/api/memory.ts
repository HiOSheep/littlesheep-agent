// Skills and memory-tree control-plane client.

import type {
  MemoryOverview,
  MemoryResourceManagementAction,
  MemoryTreeManagementAction,
  MemoryTreeNodeDetail,
  MemoryTreeNodeManagementResponse,
  MemoryTreeOverview,
  MemoryTreeResourceManagementResponse,
  MemoryTreeDisclosureLevel,
  MemoryV3MigrationPreflightOverview,
  ProjectMemoryProjectionAction,
  ProjectMemoryProjectionExportResult,
  ProjectMemoryProjectionState,
} from '../../shared/memory-control-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import { localApiStatusError, localApiUrl } from './common'

export interface SkillMeta {
  name: string
  description: string
}

export interface SkillDetail {
  name: string
  description: string
  body: string
}

export async function listSkills(): Promise<SkillMeta[]> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.skills))
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { skills: SkillMeta[] }
  return data.skills
}

export async function readSkill(name: string): Promise<SkillDetail> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.skills, name)))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<SkillDetail>
}

export async function getMemoryOverview(): Promise<MemoryOverview> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.memory))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryOverview>
}

export async function getMemoryTreeOverview(): Promise<MemoryTreeOverview> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.memoryTree))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryTreeOverview>
}

export async function getMemoryTreeNodeDetail(
  nodeId: string,
  disclosure: MemoryTreeDisclosureLevel,
  signal?: AbortSignal,
): Promise<MemoryTreeNodeDetail> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryNodes, nodeId)
  const res = await fetch(localApiUrl(`${path}?disclosure=${disclosure}`), { signal })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryTreeNodeDetail>
}

export async function getMemoryV3MigrationPreflight(signal?: AbortSignal): Promise<MemoryV3MigrationPreflightOverview> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.memoryMigration), { signal })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryV3MigrationPreflightOverview>
}

export async function updateMemoryLearningPolicy(experienceWriteThreshold: number): Promise<{ experienceWriteThreshold: number }> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.memoryPolicy), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ experienceWriteThreshold }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<{ experienceWriteThreshold: number }>
}

export async function manageMemoryTreeNode(
  nodeId: string,
  action: MemoryTreeManagementAction,
): Promise<MemoryTreeNodeManagementResponse> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryNodes, nodeId, '/manage')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Local app API error: ${res.status}`)
  }
  return res.json() as Promise<MemoryTreeNodeManagementResponse>
}

export async function manageMemoryTreeResource(
  resourceId: string,
  action: MemoryResourceManagementAction,
  options: { sourcePath?: string } = {},
): Promise<MemoryTreeResourceManagementResponse> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryResources, resourceId, '/manage')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...options }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Local app API error: ${res.status}`)
  }
  return res.json() as Promise<MemoryTreeResourceManagementResponse>
}

export async function updateProjectMemoryProjection(
  projectId: string,
  action: ProjectMemoryProjectionAction,
): Promise<ProjectMemoryProjectionState | { cancelled: boolean; export?: ProjectMemoryProjectionExportResult }> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryProjects, projectId, '/projection')), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: `Local app API error: ${res.status}` }))
    throw new Error((data as { error: string }).error)
  }
  return res.json() as Promise<ProjectMemoryProjectionState | { cancelled: boolean; export?: ProjectMemoryProjectionExportResult }>
}
