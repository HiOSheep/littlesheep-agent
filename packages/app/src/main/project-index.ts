// @littlesheep/app — project-index.ts
// UI-owned project registry. It writes ~/.littlesheep/projects/index.json,
// which is also read by @littlesheep/memory-tree's ProjectMemoryBranch.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

export interface ProjectMeta {
  id: string
  name: string
  path: string
  createdAt: string
  lastActiveAt: string
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
    const projectPath = normalizeProjectPath(path)
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
      id: projectIdFromPath(projectPath),
      name: projectNameFromPath(projectPath),
      path: projectPath,
      createdAt: lastActiveAt,
      lastActiveAt,
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
    const projectPath = normalizeProjectPath(path)
    const existing = projects.find((project) => samePath(project.path, projectPath))
    if (!existing) return undefined
    await this.persist(projects.filter((project) => project.id !== existing.id))
    return existing
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

  async upsert(project: ProjectMeta): Promise<void> {
    const projects = await this.list()
    const existingIndex = projects.findIndex((item) => item.id === project.id || samePath(item.path, project.path))
    if (existingIndex >= 0) {
      projects[existingIndex] = project
    } else {
      projects.push(project)
    }
    await this.persist(projects)
  }

  private async persist(projects: ProjectMeta[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await writeFile(this.filePath, JSON.stringify({ projects }, null, 2), 'utf-8')
  }
}

export function projectIdFromPath(path: string): string {
  const normalized = normalizeProjectPath(path)
  const name = projectNameFromPath(normalized)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'project'
  const hash = createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

function projectNameFromPath(path: string): string {
  return basename(normalizeProjectPath(path)) || 'Project'
}

function normalizeProjectPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '')
}

function samePath(a: string, b: string): boolean {
  return normalizeProjectPath(a).toLowerCase() === normalizeProjectPath(b).toLowerCase()
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
    item.path.length > 0
  )
}
