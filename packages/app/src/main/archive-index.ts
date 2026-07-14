// @littlesheep/app — archive-index.ts
// UI archive registry. Archived items are hidden from the main sidebar but
// remain manageable from the settings archive page.

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import type { ProjectMeta } from './project-index.js'
import { normalizeSessionMeta, type SessionMeta } from './session-index.js'
import { isRetiredApplicationWorkspace } from './runtime-config.js'
import { sessionBelongsToProject } from '../shared/session-scope.js'
import { normalizeBoundPath, sameBoundPath } from './path-rebinding.js'

export interface ArchivedProjectMeta extends ProjectMeta {
  archivedAt: number
}

export interface ArchivedSessionMeta extends SessionMeta {
  archivedAt: number
}

export interface ArchivePayload {
  projects: ArchivedProjectMeta[]
  sessions: ArchivedSessionMeta[]
}

const EMPTY_ARCHIVE: ArchivePayload = { projects: [], sessions: [] }

export class ArchiveIndex {
  private readonly filePath: string
  private readonly workplaceDir: string

  constructor(opts: { dataDir: string; workplaceDir?: string }) {
    this.filePath = join(opts.dataDir, 'archive', 'index.json')
    this.workplaceDir = opts.workplaceDir ?? join(opts.dataDir, 'workplace')
  }

  async list(): Promise<ArchivePayload> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as { projects?: unknown[]; sessions?: unknown[] }
      return {
        projects: Array.isArray(data.projects)
          ? data.projects.filter(isArchivedProjectMeta).sort((a, b) => b.archivedAt - a.archivedAt)
          : [],
        sessions: Array.isArray(data.sessions)
          ? data.sessions
            .map((session) => normalizeArchivedSessionMeta(session, this.workplaceDir))
            .filter((session): session is ArchivedSessionMeta => !!session)
            .sort((a, b) => b.archivedAt - a.archivedAt)
          : [],
      }
    } catch {
      return { ...EMPTY_ARCHIVE }
    }
  }

  async archiveProject(project: ProjectMeta, archivedAt = Date.now()): Promise<void> {
    const archive = await this.list()
    archive.projects = upsertById(archive.projects, { ...project, archivedAt })
    await this.persist(archive)
  }

  async archiveSession(session: SessionMeta, archivedAt = Date.now()): Promise<void> {
    const archive = await this.list()
    archive.sessions = upsertById(archive.sessions, { ...session, archivedAt })
    await this.persist(archive)
  }

  async findProjectByPath(path: string): Promise<ArchivedProjectMeta | undefined> {
    const normalizedPath = normalizeBoundPath(path)
    return (await this.list()).projects.find((project) => sameBoundPath(project.path, normalizedPath))
  }

  async rebindProject(project: ProjectMeta, workspacePath: string): Promise<ArchivedSessionMeta[]> {
    const normalizedPath = normalizeBoundPath(workspacePath)
    const archive = await this.list()
    let changed = false
    archive.projects = archive.projects.map((item) => {
      if (item.id !== project.id) return item
      changed = true
      return { ...item, ...project, path: normalizedPath, archivedAt: item.archivedAt }
    })
    const affected: ArchivedSessionMeta[] = []
    archive.sessions = archive.sessions.map((session) => {
      if (!sessionBelongsToProject(session, project.id)) return session
      const updated = { ...session, workspacePath: normalizedPath }
      affected.push(updated)
      if (session.workspacePath !== normalizedPath) changed = true
      return updated
    })
    if (changed) await this.persist(archive)
    return affected
  }

  async restoreProject(id: string): Promise<ArchivedProjectMeta | undefined> {
    const archive = await this.list()
    const project = archive.projects.find((item) => item.id === id)
    if (!project) return undefined
    archive.projects = archive.projects.filter((item) => item.id !== id)
    await this.persist(archive)
    return project
  }

  async restoreSession(id: string): Promise<ArchivedSessionMeta | undefined> {
    const archive = await this.list()
    const session = archive.sessions.find((item) => item.id === id)
    if (!session) return undefined
    archive.sessions = archive.sessions.filter((item) => item.id !== id)
    await this.persist(archive)
    return session
  }

  async removeProject(id: string): Promise<ArchivedProjectMeta | undefined> {
    return this.restoreProject(id)
  }

  async removeProjectByPath(path: string): Promise<ArchivedProjectMeta | undefined> {
    const archive = await this.list()
    const project = archive.projects.find((item) => samePath(item.path, path))
    if (!project) return undefined
    archive.projects = archive.projects.filter((item) => item.id !== project.id)
    await this.persist(archive)
    return project
  }

  async migrateManagedWorkspaceMetadata(): Promise<ArchivedProjectMeta[]> {
    const archive = await this.list()
    const removed = archive.projects.filter((project) =>
      samePath(project.path, this.workplaceDir) || isRetiredApplicationWorkspace(project.path, this.workplaceDir))
    const removedIds = new Set(removed.map((project) => project.id))
    archive.projects = archive.projects.filter((project) => !removedIds.has(project.id))

    // list() already normalizes legacy session ownership and workspace paths.
    // Persist once so a later restore cannot reintroduce the retired default.
    await this.persist(archive)
    return removed
  }

  async removeSession(id: string): Promise<ArchivedSessionMeta | undefined> {
    return this.restoreSession(id)
  }

  async restoreSessionsForProject(project: ProjectMeta): Promise<ArchivedSessionMeta[]> {
    const archive = await this.list()
    const sessions = archive.sessions.filter((session) => belongsToProject(session, project))
    if (sessions.length === 0) return []
    const ids = new Set(sessions.map((session) => session.id))
    archive.sessions = archive.sessions.filter((session) => !ids.has(session.id))
    await this.persist(archive)
    return sessions
  }

  async removeSessionsForProject(project: ProjectMeta): Promise<ArchivedSessionMeta[]> {
    return this.restoreSessionsForProject(project)
  }

  private async persist(archive: ArchivePayload): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify(archive, null, 2))
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const next = items.filter((existing) => existing.id !== item.id)
  next.push(item)
  return next
}

function belongsToProject(session: SessionMeta, project: ProjectMeta): boolean {
  return sessionBelongsToProject(session, project.id)
}

function samePath(a: string, b: string): boolean {
  return sameBoundPath(a, b)
}

function isArchivedProjectMeta(value: unknown): value is ArchivedProjectMeta {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.path === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.lastActiveAt === 'string' &&
    typeof item.archivedAt === 'number' &&
    (item.identityVersion === undefined || item.identityVersion === 2) &&
    (item.previousPaths === undefined || (
      Array.isArray(item.previousPaths) && item.previousPaths.every((path) => typeof path === 'string')
    )) &&
    (item.pathUpdatedAt === undefined || typeof item.pathUpdatedAt === 'string')
  )
}

function normalizeArchivedSessionMeta(value: unknown, workplaceDir: string): ArchivedSessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (typeof item.archivedAt !== 'number') return null
  const session = normalizeSessionMeta(item, workplaceDir)
  return session ? { ...session, archivedAt: item.archivedAt } : null
}
