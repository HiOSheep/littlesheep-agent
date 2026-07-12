import { describe, expect, it } from 'vitest'
import { projectSessions, standaloneSessions } from './session-scope.js'

describe('session ownership filters', () => {
  it('keeps project and standalone conversations disjoint even in the same workspace', () => {
    const sharedWorkspace = 'D:\\work\\alpha'
    const sessions = [
      { id: 'standalone', scope: 'standalone' as const, workspacePath: sharedWorkspace },
      { id: 'project', scope: 'project' as const, projectId: 'alpha', workspacePath: sharedWorkspace },
    ]

    expect(standaloneSessions(sessions).map((session) => session.id)).toEqual(['standalone'])
    expect(projectSessions(sessions, 'alpha').map((session) => session.id)).toEqual(['project'])
  })
})
