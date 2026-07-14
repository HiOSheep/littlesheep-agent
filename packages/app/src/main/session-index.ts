// @littlesheep/app — session-index.ts
// Lightweight sessions.json index for the UI sidebar.
// The authoritative session data stays in SessionManager's JSONL files;
// this index is a UI-facing cache of display metadata (title, timestamps, mode).

import { join } from 'node:path'
import { readFile, mkdir } from 'node:fs/promises'
import { atomicWrite } from '@littlesheep/memory-core'
import { isSessionScope, type SessionScope } from '../shared/session-scope.js'
import type { SessionMeta } from '../shared/session-project-contracts.js'
import { isRetiredApplicationWorkspace } from './runtime-config.js'
import { normalizeBoundPath } from './path-rebinding.js'

export type { SessionMeta } from '../shared/session-project-contracts.js'

export class SessionIndex {
  private readonly filePath: string
  private readonly workplaceDir: string

  constructor(opts: { dataDir: string; workplaceDir?: string }) {
    this.filePath = join(opts.dataDir, 'sessions.json')
    this.workplaceDir = opts.workplaceDir ?? join(opts.dataDir, 'workplace')
  }

  async list(): Promise<SessionMeta[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as { sessions?: unknown[] }
      if (!Array.isArray(data.sessions)) return []
      const sessions = data.sessions
        .map((session) => normalizeSessionMeta(session, this.workplaceDir))
        .filter((session): session is SessionMeta => !!session)
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      if (sessionsNeedMigration(data.sessions, sessions)) {
        try {
          await this.persist(sessions)
        } catch {
          // A transient migration write failure must not hide readable sessions from the UI.
        }
      }
      return sessions
    } catch {
      return []
    }
  }

  /** Upsert by id. For new sessions, missing fields get defaults. */
  async upsert(id: string, updates: Partial<Omit<SessionMeta, 'id'>>): Promise<void> {
    const sessions = await this.list()
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx]!, ...updates }
    } else {
      sessions.push({
        id,
        title: updates.title ?? 'New session',
        createdAt: updates.createdAt ?? Date.now(),
        lastMessageAt: updates.lastMessageAt ?? Date.now(),
        mode: updates.mode ?? 'research',
        scope: updates.scope ?? 'standalone',
        projectId: updates.scope === 'project' ? updates.projectId : undefined,
        workspacePath: updates.workspacePath,
      })
    }
    const normalized = sessions
      .map((session) => normalizeSessionMeta(session, this.workplaceDir))
      .filter((session): session is SessionMeta => !!session)
    await this.persist(normalized)
  }

  async remove(id: string): Promise<SessionMeta | undefined> {
    const sessions = await this.list()
    const existing = sessions.find((s) => s.id === id)
    await this.persist(sessions.filter((s) => s.id !== id))
    return existing
  }

  async rebindProject(projectId: string, workspacePath: string): Promise<SessionMeta[]> {
    const normalizedPath = normalizeBoundPath(workspacePath)
    const sessions = await this.list()
    const affected: SessionMeta[] = []
    let changed = false
    const next = sessions.map((session) => {
      if (session.scope !== 'project' || session.projectId !== projectId) return session
      const updated = { ...session, workspacePath: normalizedPath }
      affected.push(updated)
      if (session.workspacePath !== normalizedPath) changed = true
      return updated
    })
    if (changed) await this.persist(next)
    return affected
  }

  private async persist(sessions: SessionMeta[]): Promise<void> {
    const dir = join(this.filePath, '..')
    await mkdir(dir, { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify({ sessions }, null, 2))
  }
}

export function normalizeSessionMeta(value: unknown, workplaceDir: string): SessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  if (
    typeof item.id !== 'string' || !item.id ||
    typeof item.title !== 'string' ||
    typeof item.createdAt !== 'number' ||
    typeof item.lastMessageAt !== 'number' ||
    typeof item.mode !== 'string'
  ) return null

  const projectId = typeof item.projectId === 'string' && item.projectId.trim()
    ? item.projectId.trim()
    : undefined
  const storedWorkspacePath = typeof item.workspacePath === 'string' && item.workspacePath.trim()
    ? item.workspacePath.trim()
    : undefined
  const legacyDefaultWorkspace = storedWorkspacePath
    ? isRetiredApplicationWorkspace(storedWorkspacePath, workplaceDir)
    : false
  const workspacePath = legacyDefaultWorkspace ? workplaceDir : storedWorkspacePath
  const inferredScope: SessionScope = projectId && (!workspacePath || !samePath(workspacePath, workplaceDir))
    ? 'project'
    : 'standalone'
  const requestedScope = isSessionScope(item.scope) ? item.scope : inferredScope
  const scope: SessionScope = !legacyDefaultWorkspace && requestedScope === 'project' && projectId
    ? 'project'
    : 'standalone'

  return {
    id: item.id,
    title: item.title,
    createdAt: item.createdAt,
    lastMessageAt: item.lastMessageAt,
    mode: item.mode,
    scope,
    projectId: scope === 'project' ? projectId : undefined,
    workspacePath,
  }
}

function sessionsNeedMigration(raw: unknown[], normalized: SessionMeta[]): boolean {
  if (raw.length !== normalized.length) return true
  return normalized.some((session, index) => {
    const item = raw[index]
    if (typeof item !== 'object' || item === null) return true
    const stored = item as Record<string, unknown>
    return stored.scope !== session.scope ||
      stored.projectId !== session.projectId ||
      stored.workspacePath !== session.workspacePath
  })
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}
