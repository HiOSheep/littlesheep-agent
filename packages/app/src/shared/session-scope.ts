export type SessionScope = 'standalone' | 'project'

export interface SessionOwnership {
  scope: SessionScope
  projectId?: string
}

export function isSessionScope(value: unknown): value is SessionScope {
  return value === 'standalone' || value === 'project'
}

export function isStandaloneSession(session: SessionOwnership): boolean {
  return session.scope === 'standalone'
}

export function sessionBelongsToProject(session: SessionOwnership, projectId: string): boolean {
  return session.scope === 'project' && session.projectId === projectId
}

export function standaloneSessions<T extends SessionOwnership>(sessions: T[]): T[] {
  return sessions.filter(isStandaloneSession)
}

export function projectSessions<T extends SessionOwnership>(sessions: T[], projectId: string): T[] {
  return sessions.filter((session) => sessionBelongsToProject(session, projectId))
}
