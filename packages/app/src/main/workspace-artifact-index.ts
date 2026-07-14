// @littlesheep/app — workspace-artifact-index.ts
// Persistent artifact registry for files produced or modified in the workspace.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, basename, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import type {
  WorkspaceArtifactAction,
  WorkspaceArtifactRecord,
  WorkspaceArtifactSource,
} from '../shared/workspace-contracts.js'
import { rebaseBoundPath, sameBoundPath } from './path-rebinding.js'

export type {
  WorkspaceArtifactAction,
  WorkspaceArtifactRecord,
  WorkspaceArtifactSource,
} from '../shared/workspace-contracts.js'

export interface WorkspaceArtifactInput {
  path: string
  action: WorkspaceArtifactAction
  source: WorkspaceArtifactSource
  workspacePath: string
  sessionId?: string
  projectId?: string
  runId?: string
  toolName?: string
  createdAt?: string
}

export class WorkspaceArtifactIndex {
  private readonly filePath: string
  private readonly maxRecords: number

  constructor(opts: { dataDir: string; maxRecords?: number }) {
    this.filePath = resolve(opts.dataDir, 'workspace', 'artifacts.json')
    this.maxRecords = opts.maxRecords ?? 1000
  }

  async list(filter: { workspacePath?: string; sessionId?: string; limit?: number } = {}): Promise<WorkspaceArtifactRecord[]> {
    const records = await this.readAll()
    const workspacePath = filter.workspacePath ? normalizePath(filter.workspacePath) : ''
    const sessionId = filter.sessionId?.trim()
    const limit = Math.max(1, Math.min(300, Math.round(filter.limit ?? 50)))

    return records
      .filter((record) => {
        if (workspacePath && normalizePath(record.workspacePath) !== workspacePath) return false
        if (!sessionId) return true
        return record.sessionId === sessionId || !record.sessionId
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit)
  }

  async append(input: WorkspaceArtifactInput): Promise<WorkspaceArtifactRecord> {
    const [record] = await this.appendMany([input])
    return record!
  }

  async appendMany(inputs: WorkspaceArtifactInput[]): Promise<WorkspaceArtifactRecord[]> {
    const now = new Date().toISOString()
    const records = await this.readAll()
    const nextRecords = inputs
      .map((input): WorkspaceArtifactRecord | null => {
        const path = input.path.trim()
        const workspacePath = input.workspacePath.trim()
        if (!path || !workspacePath) return null
        const normalizedPath = normalizePath(path)
        return {
          id: randomUUID(),
          path: normalizedPath,
          name: basename(normalizedPath) || normalizedPath,
          action: input.action,
          source: input.source,
          workspacePath: normalizePath(workspacePath),
          sessionId: input.sessionId?.trim() || undefined,
          projectId: input.projectId?.trim() || undefined,
          runId: input.runId?.trim() || undefined,
          toolName: input.toolName?.trim() || undefined,
          createdAt: input.createdAt ?? now,
        }
      })
      .filter((record): record is WorkspaceArtifactRecord => Boolean(record))

    if (nextRecords.length === 0) return []
    records.push(...nextRecords)
    records.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    await this.persist(records.slice(0, this.maxRecords))
    return nextRecords
  }

  async rebindProject(
    projectId: string,
    sessionIds: Iterable<string>,
    fromPath: string,
    toPath: string,
  ): Promise<number> {
    const projectSessions = new Set(sessionIds)
    const records = await this.readAll()
    let changed = 0
    const next = records.map((record) => {
      const belongsToProject = record.projectId === projectId
        || Boolean(record.sessionId && projectSessions.has(record.sessionId))
      if (!belongsToProject) return record
      const workspacePath = sameBoundPath(record.workspacePath, fromPath)
        ? normalizePath(toPath)
        : record.workspacePath
      const path = rebaseBoundPath(record.path, fromPath, toPath)
      if (record.projectId === projectId && workspacePath === record.workspacePath && path === record.path) return record
      changed += 1
      return { ...record, projectId, workspacePath, path, name: basename(path) || path }
    })
    if (changed > 0) await this.persist(next)
    return changed
  }

  private async readAll(): Promise<WorkspaceArtifactRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as { records?: unknown[] }
      if (!Array.isArray(data.records)) return []
      return data.records.filter(isWorkspaceArtifactRecord)
    } catch {
      return []
    }
  }

  private async persist(records: WorkspaceArtifactRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify({ records }, null, 2))
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '')
}

function isWorkspaceArtifactRecord(value: unknown): value is WorkspaceArtifactRecord {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.path === 'string' &&
    typeof item.name === 'string' &&
    (item.action === 'created' || item.action === 'modified' || item.action === 'attached') &&
    (item.source === 'agent' || item.source === 'user') &&
    typeof item.workspacePath === 'string' &&
    typeof item.createdAt === 'string' &&
    (typeof item.sessionId === 'string' || item.sessionId === undefined) &&
    (typeof item.projectId === 'string' || item.projectId === undefined) &&
    (typeof item.runId === 'string' || item.runId === undefined) &&
    (typeof item.toolName === 'string' || item.toolName === undefined)
  )
}
