import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionIndex } from './session-index.js'

describe('SessionIndex ownership', () => {
  it('migrates legacy workplace sessions to standalone without deleting history metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-session-index-'))
    const workplace = join(dir, 'workplace')
    try {
      writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
        sessions: [{
          id: 'legacy',
          title: 'Legacy chat',
          createdAt: 1,
          lastMessageAt: 2,
          mode: 'research',
          projectId: 'workplace-project',
          workspacePath: workplace,
        }],
      }))

      const sessions = await new SessionIndex({ dataDir: dir, workplaceDir: workplace }).list()
      expect(sessions).toEqual([{
        id: 'legacy',
        title: 'Legacy chat',
        createdAt: 1,
        lastMessageAt: 2,
        mode: 'research',
        scope: 'standalone',
        workspacePath: workplace,
      }])

      const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as { sessions: unknown[] }
      expect(stored.sessions).toEqual(sessions)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists standalone and project ownership independently of workspace path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-session-index-'))
    const sharedWorkspace = join(dir, 'Project')
    try {
      const index = new SessionIndex({ dataDir: dir })
      await index.upsert('standalone', {
        title: 'Standalone',
        scope: 'standalone',
        workspacePath: sharedWorkspace,
      })
      await index.upsert('project', {
        title: 'Project',
        scope: 'project',
        projectId: 'project-1',
        workspacePath: sharedWorkspace,
      })

      const sessions = await index.list()
      expect(sessions.find((session) => session.id === 'standalone')).toMatchObject({
        scope: 'standalone',
        projectId: undefined,
        workspacePath: sharedWorkspace,
      })
      expect(sessions.find((session) => session.id === 'project')).toMatchObject({
        scope: 'project',
        projectId: 'project-1',
        workspacePath: sharedWorkspace,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
