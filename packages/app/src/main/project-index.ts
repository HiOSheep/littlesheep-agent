// @littlesheep/app — project-index.ts
// UI-owned project registry. It writes ~/.littlesheep/projects/index.json,
// which is also read by @littlesheep/memory-tree's ProjectMemoryBranch.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import { isRetiredApplicationWorkspace } from './runtime-config.js'
import {
  appendBoundPathHistory,
  normalizeBoundPath,
  sameBoundPath,
} from './path-rebinding.js'

export interface ProjectMeta {
  id: string
  name: string
  path: string
  createdAt: string
  lastActiveAt: string
  /** Present for path-independent project identities created or rebound by current LS versions. */
  identityVersion?: 2
  /** Bounded audit trail used to repair stale path references after a move or rename. */
  previousPaths?: string[]
  pathUpdatedAt?: string
}

export class ProjectPathConflictError extends Error {
  constructor(
    readonly path: string,
    readonly existingProjectId: string,
  ) {
    super(`Project path is already bound to project ${existingProjectId}: ${path}`)
    this.name = 'ProjectPathConflictError'
  }
}

export class ProjectIndex {
  private readonly filePath: string

  constructor(opts: { dataDir: string }) {
    this.filePath = join(opts.dataDir, 'projects', 'index.json')
  }

  async list(): Promise<ProjectMeta[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as { projects?: unknown[] }
      if (!Array.isArray(data.projects)) return []
      return data.projects.filter(isProjectMeta)
    } catch {
      return []
    }
  }

  async ensure(path: string, now = new Date()): Promise<ProjectMeta> {
    const projectPath = normalizeBoundPath(path)
    const projects = await this.list()
    const existingIndex = projects.findIndex((project) => samePath(project.path, projectPath))
    const lastActiveAt = now.toISOString()

    if (existingIndex >= 0) {
      const existing = projects[existingIndex]!
      const updated = {
        ...existing,
        name: existing.name || projectNameFromPath(projectPath),
        path: projectPath,
        lastActiveAt,
      }
      projects[existingIndex] = updated
      await this.persist(projects)
      return updated
    }

    const project: ProjectMeta = {
      id: createStableProjectId(),
      name: projectNameFromPath(projectPath),
      path: projectPath,
      createdAt: lastActiveAt,
      lastActiveAt,
      identityVersion: 2,
      previousPaths: [],
      pathUpdatedAt: lastActiveAt,
    }
    projects.push(project)
    await this.persist(projects)
    return project
  }

  async remove(id: string): Promise<ProjectMeta | undefined> {
    const projects = await this.list()
    const existing = projects.find((project) => project.id === id)
    if (!existing) return undefined
    await this.persist(projects.filter((project) => project.id !== id))
    return existing
  }

  async removeByPath(path: string): Promise<ProjectMeta | undefined> {
    const projects = await this.list()
    const projectPath = normalizeBoundPath(path)
    const existing = projects.find((project) => samePath(project.path, projectPath))
    if (!existing) return undefined
    await this.persist(projects.filter((project) => project.id !== existing.id))
    return existing
  }

  async removeManagedWorkspaceShells(workplaceDir: string): Promise<ProjectMeta[]> {
    const projects = await this.list()
    const removed = projects.filter((project) =>
      samePath(project.path, workplaceDir) || isRetiredApplicationWorkspace(project.path, workplaceDir))
    if (removed.length === 0) return []
    const removedIds = new Set(removed.map((project) => project.id))
    await this.persist(projects.filter((project) => !removedIds.has(project.id)))
    return removed
  }

  async touch(id: string, now = new Date()): Promise<ProjectMeta | undefined> {
    const projects = await this.list()
    const existingIndex = projects.findIndex((project) => project.id === id)
    if (existingIndex < 0) return undefined
    const updated = { ...projects[existingIndex]!, lastActiveAt: now.toISOString() }
    projects[existingIndex] = updated
    await this.persist(projects)
    return updated
  }

  async rebind(id: string, path: string, now = new Date()): Promise<ProjectMeta | undefined> {
    const projects = await this.list()
    const existingIndex = projects.findIndex((project) => project.id === id)
    if (existingIndex < 0) return undefined
    const projectPath = normalizeBoundPath(path)
    const conflict = projects.find((project) => project.id !== id && samePath(project.path, projectPath))
    if (conflict) throw new ProjectPathConflictError(projectPath, conflict.id)

    const existing = projects[existingIndex]!
    if (samePath(existing.path, projectPath)) return existing
    const updated = reboundProjectMeta(existing, projectPath, now)
    projects[existingIndex] = updated
    await this.persist(projects)
    return updated
  }

  async upsert(project: ProjectMeta): Promise<void> {
    const projects = await this.list()
    const pathConflict = projects.find((item) => item.id !== project.id && samePath(item.path, project.path))
    if (pathConflict) throw new ProjectPathConflictError(project.path, pathConflict.id)
    const existingIndex = projects.findIndex((item) => item.id === project.id)
    if (existingIndex >= 0) {
      projects[existingIndex] = project
    } else {
      projects.push(project)
    }
    await this.persist(projects)
  }

  private async persist(projects: ProjectMeta[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify({ projects }, null, 2))
  }
}

export function createStableProjectId(): string {
  return `project-${randomUUID()}`
}

export function reboundProjectMeta(project: ProjectMeta, path: string, now = new Date()): ProjectMeta {
  const projectPath = normalizeBoundPath(path)
  if (samePath(project.path, projectPath)) return project
  const changedAt = now.toISOString()
  const previousDefaultName = projectNameFromPath(project.path)
  return {
    ...project,
    name: !project.name || project.name === previousDefaultName
      ? projectNameFromPath(projectPath)
      : project.name,
    path: projectPath,
    lastActiveAt: changedAt,
    identityVersion: 2,
    previousPaths: appendBoundPathHistory(project.previousPaths, project.path),
    pathUpdatedAt: changedAt,
  }
}

export function projectIdFromPath(path: string): string {
  const normalized = normalizeBoundPath(path)
  const name = projectNameFromPath(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'project'
  const hash = createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

function projectNameFromPath(path: string): string {
  return basename(normalizeBoundPath(path)) || 'Project'
}

function samePath(a: string, b: string): boolean {
  return sameBoundPath(a, b)
}

function isProjectMeta(value: unknown): value is ProjectMeta {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.path === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.lastActiveAt === 'string' &&
    item.id.length > 0 &&
    item.path.length > 0 &&
    (item.identityVersion === undefined || item.identityVersion === 2) &&
    (item.previousPaths === undefined || (
      Array.isArray(item.previousPaths) && item.previousPaths.every((path) => typeof path === 'string')
    )) &&
    (item.pathUpdatedAt === undefined || typeof item.pathUpdatedAt === 'string')
  )
}
