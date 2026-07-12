// @littlesheep/app — session-index.ts
// Lightweight sessions.json index for the UI sidebar.
// The authoritative session data stays in SessionManager's JSONL files;
// this index is a UI-facing cache of display metadata (title, timestamps, mode).

import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { isSessionScope, type SessionScope } from '../shared/session-scope.js'

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  lastMessageAt: number
  mode: string
  scope: SessionScope
  projectId?: string
  workspacePath?: string
}

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

  private async persist(sessions: SessionMeta[]): Promise<void> {
    const dir = join(this.filePath, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(this.filePath, JSON.stringify({ sessions }, null, 2), 'utf-8')
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
  const workspacePath = typeof item.workspacePath === 'string' && item.workspacePath.trim()
    ? item.workspacePath.trim()
    : undefined
  const inferredScope: SessionScope = projectId && (!workspacePath || !samePath(workspacePath, workplaceDir))
    ? 'project'
    : 'standalone'
  const requestedScope = isSessionScope(item.scope) ? item.scope : inferredScope
  const scope: SessionScope = requestedScope === 'project' && projectId ? 'project' : 'standalone'

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
    return stored.scope !== session.scope || stored.projectId !== session.projectId
  })
}

function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}
