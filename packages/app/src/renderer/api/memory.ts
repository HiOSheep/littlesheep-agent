// Skills and user-facing memory document client.

import type {
  MemoryFilesPayload,
  MemoryFileDetail,
  MemoryFileOverview,
  MemoryFileName,
} from '../../shared/memory-control-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import { localApiFetch, localApiStatusError } from './common'

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
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.skills)
  if (!res.ok) throw localApiStatusError(res.status)
  const data = await res.json() as { skills: SkillMeta[] }
  return data.skills
}

export async function readSkill(name: string): Promise<SkillDetail> {
  const res = await localApiFetch(localAppApiItemPath(LOCAL_APP_API_PREFIXES.skills, name))
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<SkillDetail>
}

export async function listMemoryFiles(): Promise<MemoryFileOverview[]> {
  return (await getMemoryFilesPayload()).files
}

export async function getMemoryFilesPayload(): Promise<MemoryFilesPayload> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.memoryFiles)
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryFilesPayload>
}

export async function readMemoryFile(name: MemoryFileName, signal?: AbortSignal): Promise<MemoryFileDetail> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryFiles, name)
  const res = await localApiFetch(path, { signal })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<MemoryFileDetail>
}

export async function writeMemoryFile(name: MemoryFileName, content: string): Promise<MemoryFileDetail> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.memoryFiles, name)
  const res = await localApiFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Local app API error: ${res.status}`)
  }
  return res.json() as Promise<MemoryFileDetail>
}
