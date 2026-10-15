// Stable Local App API contracts shared by the main and renderer processes.

import type { SessionScope } from './session-scope'
import type { PermissionPresetId } from '@littlesheep/types'

export const SESSION_TITLE_MAX_LENGTH = 60

export function normalizeSessionTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  lastMessageAt: number
  mode: PermissionPresetId
  permissionVersion: 2
  scope: SessionScope
  projectId?: string
  workspacePath?: string
}

export interface ProjectMeta {
  id: string
  name: string
  path: string
  createdAt: string
  lastActiveAt: string
  identityVersion?: 2
  previousPaths?: string[]
  pathUpdatedAt?: string
}

export interface ArchivedSessionMeta extends SessionMeta {
  archivedAt: number
}

export interface ArchivedProjectMeta extends ProjectMeta {
  archivedAt: number
}

export interface ArchivePayload {
  projects: ArchivedProjectMeta[]
  sessions: ArchivedSessionMeta[]
}
