// @littlesheep/app — archive-index.ts
// UI archive registry. Archived items are hidden from the main sidebar but
// remain manageable from the settings archive page.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectMeta } from './project-index.js'
import { normalizeSessionMeta, type SessionMeta } from './session-index.js'
import { sessionBelongsToProject } from '../shared/session-scope.js'

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
    await writeFile(this.filePath, JSON.stringify(archive, null, 2), 'utf-8')
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
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
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
    typeof item.archivedAt === 'number'
  )
}

function normalizeArchivedSessionMeta(value: unknown, workplaceDir: string): ArchivedSessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (typeof item.archivedAt !== 'number') return null
  const session = normalizeSessionMeta(item, workplaceDir)
  return session ? { ...session, archivedAt: item.archivedAt } : null
}
