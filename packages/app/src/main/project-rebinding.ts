import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import { ArchiveIndex } from './archive-index.js'
import { normalizeBoundPath, sameBoundPath } from './path-rebinding.js'
import {
  ProjectIndex,
  ProjectPathConflictError,
  reboundProjectMeta,
  type ProjectMeta,
} from './project-index.js'
import { SessionIndex, type SessionMeta } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

const JOURNAL_VERSION = 1 as const

const REBIND_STEPS = [
  'sessions',
  'archive',
  'artifacts',
  'terminal',
  'layout',
  'memory',
  'runtime',
  'project',
] as const

export type ProjectRebindStep = typeof REBIND_STEPS[number]

interface ProjectRebindJournal {
  version: 1
  operationId: string
  projectBefore: ProjectMeta
  projectAfter: ProjectMeta
  startedAt: string
  updatedAt: string
  completedSteps: ProjectRebindStep[]
}

export interface ProjectRebindResult {
  project: ProjectMeta
  sessions: SessionMeta[]
  recovered: boolean
}

export interface ProjectRebindingServiceOptions {
  dataDir: string
  projectIndex: ProjectIndex
  sessionIndex: SessionIndex
  archiveIndex: ArchiveIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  terminalActivityIndex: TerminalActivityIndex
  workspaceLayoutIndex: WorkspaceLayoutIndex
  rebindMemory: (previous: ProjectMeta, project: ProjectMeta) => Promise<unknown>
  rebindRuntimeWorkspace: (fromPath: string, toPath: string) => Promise<void>
  faultInjector?: (step: ProjectRebindStep, phase: 'after-apply' | 'after-journal') => void | Promise<void>
}

export class ProjectRebindingService {
  private readonly journalPath: string
  private operationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: ProjectRebindingServiceOptions) {
    this.journalPath = join(options.dataDir, 'projects', 'rebind-operation.json')
  }

  async rebind(projectId: string, path: string, now = new Date()): Promise<ProjectRebindResult> {
    return this.serialize(async () => {
      await this.recoverPendingUnlocked()
      const projects = await this.options.projectIndex.list()
      const project = projects.find((entry) => entry.id === projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      const targetPath = normalizeBoundPath(path)
      const activeConflict = projects.find((entry) => entry.id !== projectId && sameBoundPath(entry.path, targetPath))
      if (activeConflict) throw new ProjectPathConflictError(targetPath, activeConflict.id)
      const archivedConflict = (await this.options.archiveIndex.list()).projects
        .find((entry) => entry.id !== projectId && sameBoundPath(entry.path, targetPath))
      if (archivedConflict) throw new ProjectPathConflictError(targetPath, archivedConflict.id)
      if (sameBoundPath(project.path, targetPath)) {
        return { project, sessions: await this.projectSessions(project.id, false), recovered: false }
      }

      const projectAfter = reboundProjectMeta(project, targetPath, now)
      const journal: ProjectRebindJournal = {
        version: JOURNAL_VERSION,
        operationId: randomUUID(),
        projectBefore: project,
        projectAfter,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        completedSteps: [],
      }
      await this.persistJournal(journal)
      return this.execute(journal, false)
    })
  }

  async recoverPending(): Promise<ProjectRebindResult | undefined> {
    return this.serialize(() => this.recoverPendingUnlocked())
  }

  private async recoverPendingUnlocked(): Promise<ProjectRebindResult | undefined> {
    const journal = await this.readJournal()
    if (!journal) return undefined
    const current = (await this.options.projectIndex.list()).find((project) => project.id === journal.projectBefore.id)
    if (!current) throw new Error(`Cannot recover project rebind; project is missing: ${journal.projectBefore.id}`)
    if (!sameBoundPath(current.path, journal.projectBefore.path)
      && !sameBoundPath(current.path, journal.projectAfter.path)) {
      throw new Error(`Cannot recover project rebind; project path changed independently: ${current.path}`)
    }
    return this.execute(journal, true)
  }

  private async execute(journal: ProjectRebindJournal, recovered: boolean): Promise<ProjectRebindResult> {
    const completed = new Set(journal.completedSteps)
    for (const step of REBIND_STEPS) {
      if (completed.has(step)) continue
      await this.applyStep(step, journal)
      await this.options.faultInjector?.(step, 'after-apply')
      completed.add(step)
      journal.completedSteps = REBIND_STEPS.filter((candidate) => completed.has(candidate))
      journal.updatedAt = new Date().toISOString()
      await this.persistJournal(journal)
      await this.options.faultInjector?.(step, 'after-journal')
    }
    await rm(this.journalPath, { force: true })
    const project = (await this.options.projectIndex.list()).find((entry) => entry.id === journal.projectAfter.id)
    if (!project || !sameBoundPath(project.path, journal.projectAfter.path)) {
      throw new Error(`Project rebind did not commit the target path: ${journal.projectAfter.path}`)
    }
    return { project, sessions: await this.projectSessions(project.id, false), recovered }
  }

  private async applyStep(step: ProjectRebindStep, journal: ProjectRebindJournal): Promise<void> {
    const { projectBefore, projectAfter } = journal
    if (step === 'sessions') {
      await this.options.sessionIndex.rebindProject(projectAfter.id, projectAfter.path)
      return
    }
    if (step === 'archive') {
      await this.options.archiveIndex.rebindProject(projectAfter, projectAfter.path)
      return
    }
    const sessionIds = (await this.projectSessions(projectAfter.id, true)).map((session) => session.id)
    if (step === 'artifacts') {
      await this.options.workspaceArtifactIndex.rebindProject(
        projectAfter.id,
        sessionIds,
        projectBefore.path,
        projectAfter.path,
      )
      return
    }
    if (step === 'terminal') {
      await this.options.terminalActivityIndex.rebindProject(sessionIds, projectBefore.path, projectAfter.path)
      return
    }
    if (step === 'layout') {
      await this.options.workspaceLayoutIndex.rebindWorkspace(projectBefore.path, projectAfter.path)
      return
    }
    if (step === 'memory') {
      await this.options.rebindMemory(projectBefore, projectAfter)
      return
    }
    if (step === 'runtime') {
      await this.options.rebindRuntimeWorkspace(projectBefore.path, projectAfter.path)
      return
    }
    const rebound = await this.options.projectIndex.rebind(
      projectAfter.id,
      projectAfter.path,
      new Date(projectAfter.pathUpdatedAt ?? journal.updatedAt),
    )
    if (!rebound) throw new Error(`Project disappeared during rebind: ${projectAfter.id}`)
  }

  private async projectSessions(projectId: string, includeArchived: boolean): Promise<SessionMeta[]> {
    const [active, archive] = await Promise.all([
      this.options.sessionIndex.list(),
      this.options.archiveIndex.list(),
    ])
    return [...active, ...(includeArchived ? archive.sessions : [])].filter((session) => (
      session.scope === 'project' && session.projectId === projectId
    ))
  }

  private async readJournal(): Promise<ProjectRebindJournal | undefined> {
    if (!existsSync(this.journalPath)) return undefined
    const parsed = JSON.parse(await readFile(this.journalPath, 'utf8')) as unknown
    if (!isProjectRebindJournal(parsed)) {
      throw new Error(`Project rebind journal is invalid: ${this.journalPath}`)
    }
    return parsed
  }

  private async persistJournal(journal: ProjectRebindJournal): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true })
    await atomicWrite(this.journalPath, JSON.stringify(journal, null, 2))
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.catch(() => undefined)
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    this.operationTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function isProjectRebindJournal(value: unknown): value is ProjectRebindJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.version === JOURNAL_VERSION
    && typeof item.operationId === 'string'
    && isJournalProject(item.projectBefore)
    && isJournalProject(item.projectAfter)
    && item.projectBefore.id === item.projectAfter.id
    && typeof item.startedAt === 'string'
    && typeof item.updatedAt === 'string'
    && Array.isArray(item.completedSteps)
    && item.completedSteps.every((step) => REBIND_STEPS.includes(step as ProjectRebindStep))
}

function isJournalProject(value: unknown): value is ProjectMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string'
    && typeof item.path === 'string' && item.path.length > 0
    && typeof item.createdAt === 'string'
    && typeof item.lastActiveAt === 'string'
    && (item.identityVersion === undefined || item.identityVersion === 2)
    && (item.previousPaths === undefined || (
      Array.isArray(item.previousPaths) && item.previousPaths.every((path) => typeof path === 'string')
    ))
    && (item.pathUpdatedAt === undefined || typeof item.pathUpdatedAt === 'string')
}
