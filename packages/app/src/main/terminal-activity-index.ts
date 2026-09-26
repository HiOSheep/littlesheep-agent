// @littlesheep/app — terminal-activity-index.ts
// Persistent UI activity log for user-run workspace terminal commands.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import type { TerminalActivityRecord } from '../shared/workspace-contracts.js'
import { rebaseBoundPath, sameBoundPath } from './path-rebinding.js'

export type { TerminalActivityRecord } from '../shared/workspace-contracts.js'

export interface TerminalActivityInput {
  command: string
  cwd: string
  workspacePath: string
  sessionId?: string
  /** The Shell the command ran in, when it came from a resolved terminal profile. */
  shell?: string
  startedAt?: string
  endedAt?: string
  durationMs: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  truncated: boolean
  stdout?: string
  stderr?: string
}

export class TerminalActivityIndex {
  private readonly filePath: string
  private readonly maxRecords: number

  constructor(opts: { dataDir: string; maxRecords?: number }) {
    this.filePath = join(opts.dataDir, 'workspace', 'terminal-activity.json')
    this.maxRecords = opts.maxRecords ?? 500
  }

  async list(filter: { workspacePath?: string; sessionId?: string; limit?: number } = {}): Promise<TerminalActivityRecord[]> {
    const records = await this.readAll()
    const workspacePath = filter.workspacePath ? normalizePath(filter.workspacePath) : ''
    const sessionId = filter.sessionId?.trim()
    const limit = Math.max(1, Math.min(200, Math.round(filter.limit ?? 30)))

    return records
      .filter((record) => {
        if (workspacePath && normalizePath(record.workspacePath) !== workspacePath) return false
        if (!sessionId) return true
        return record.sessionId === sessionId || !record.sessionId
      })
      .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt))
      .slice(0, limit)
  }

  async append(input: TerminalActivityInput): Promise<TerminalActivityRecord> {
    const now = new Date().toISOString()
    const record: TerminalActivityRecord = {
      id: randomUUID(),
      command: input.command,
      cwd: normalizePath(input.cwd),
      workspacePath: normalizePath(input.workspacePath),
      sessionId: input.sessionId?.trim() || undefined,
      shell: input.shell?.trim() || undefined,
      startedAt: input.startedAt ?? now,
      endedAt: input.endedAt ?? now,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      exitCode: input.exitCode,
      signal: input.signal,
      timedOut: input.timedOut,
      truncated: input.truncated,
      stdoutPreview: compactPreview(input.stdout ?? ''),
      stderrPreview: compactPreview(input.stderr ?? ''),
    }

    const records = await this.readAll()
    records.push(record)
    records.sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt))
    await this.persist(records.slice(0, this.maxRecords))
    return record
  }

  async rebindProject(
    sessionIds: Iterable<string>,
    fromPath: string,
    toPath: string,
  ): Promise<number> {
    const projectSessions = new Set(sessionIds)
    if (projectSessions.size === 0) return 0
    const records = await this.readAll()
    let changed = 0
    const next = records.map((record) => {
      if (!record.sessionId || !projectSessions.has(record.sessionId)) return record
      const workspacePath = sameBoundPath(record.workspacePath, fromPath)
        ? normalizePath(toPath)
        : record.workspacePath
      const cwd = rebaseBoundPath(record.cwd, fromPath, toPath)
      if (workspacePath === record.workspacePath && cwd === record.cwd) return record
      changed += 1
      return { ...record, workspacePath, cwd }
    })
    if (changed > 0) await this.persist(next)
    return changed
  }

  private async readAll(): Promise<TerminalActivityRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as { records?: unknown[] }
      if (!Array.isArray(data.records)) return []
      return data.records.filter(isTerminalActivityRecord)
    } catch {
      return []
    }
  }

  private async persist(records: TerminalActivityRecord[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify({ records }, null, 2))
  }
}

function compactPreview(value: string): string {
  return stripTerminalControlSequences(value)
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, 1600)
}

function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[=>()#][0-9A-Za-z]?/g, '')
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '')
}

function isTerminalActivityRecord(value: unknown): value is TerminalActivityRecord {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.command === 'string' &&
    typeof item.cwd === 'string' &&
    typeof item.workspacePath === 'string' &&
    typeof item.startedAt === 'string' &&
    typeof item.endedAt === 'string' &&
    typeof item.durationMs === 'number' &&
    (typeof item.exitCode === 'number' || item.exitCode === null) &&
    (typeof item.signal === 'string' || item.signal === null) &&
    typeof item.timedOut === 'boolean' &&
    typeof item.truncated === 'boolean' &&
    typeof item.stdoutPreview === 'string' &&
    typeof item.stderrPreview === 'string' &&
    (typeof item.sessionId === 'string' || item.sessionId === undefined) &&
    (typeof item.shell === 'string' || item.shell === undefined)
  )
}
