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
        mode: 'read-only',
        permissionVersion: 2,
        permissionMigration: { version: 1, from: 'research' },
        scope: 'standalone',
        workspacePath: workplace,
      }])

      const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as { sessions: unknown[] }
      expect(stored.sessions).toEqual(sessions)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('moves retired application sessions onto the LittleSheep workplace before restore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-session-index-'))
    const workplace = join(dir, '.littlesheep', 'workplace')
    const retiredWorkspace = join(dir, '.legacy-app', 'workspace')
    try {
      writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
        sessions: [{
          id: 'retired-project-chat',
          title: 'Retired project shell chat',
          createdAt: 1,
          lastMessageAt: 2,
          mode: 'research',
          scope: 'project',
          projectId: 'retired-workspace-project',
          workspacePath: retiredWorkspace,
        }],
      }))

      const sessions = await new SessionIndex({ dataDir: dir, workplaceDir: workplace }).list()
      expect(sessions).toEqual([{
        id: 'retired-project-chat',
        title: 'Retired project shell chat',
        createdAt: 1,
        lastMessageAt: 2,
        mode: 'read-only',
        permissionVersion: 2,
        permissionMigration: { version: 1, from: 'research' },
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

  it('downgrades ambiguous historical full-access to read-only and requires explicit migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-session-index-'))
    try {
      writeFileSync(join(dir, 'sessions.json'), JSON.stringify({
        sessions: [{
          id: 'legacy-full',
          title: 'Legacy full access',
          createdAt: 1,
          lastMessageAt: 2,
          mode: 'full-access',
        }],
      }))

      const index = new SessionIndex({ dataDir: dir })
      await expect(index.list()).resolves.toMatchObject([{
        id: 'legacy-full', mode: 'read-only', permissionVersion: 2,
        permissionMigration: { version: 1, from: 'full-access' },
      }])
      const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as { sessions: Array<{ mode: string; permissionMigration?: unknown }> }
      expect(stored.sessions[0]?.mode).toBe('read-only')
      expect(stored.sessions[0]?.permissionMigration).toEqual({ version: 1, from: 'full-access' })
      await expect(new SessionIndex({ dataDir: dir }).list()).resolves.toMatchObject([{
        id: 'legacy-full', mode: 'read-only', permissionMigration: { version: 1, from: 'full-access' },
      }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent partial updates without dropping fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-session-index-concurrent-'))
    try {
      const index = new SessionIndex({ dataDir: dir })
      await index.upsert('session-1', {
        title: 'Original',
        createdAt: 1,
        lastMessageAt: 1,
        mode: 'workspace-write',
        permissionVersion: 2,
        scope: 'standalone',
      })

      await Promise.all([
        index.upsert('session-1', { title: 'Renamed' }),
        index.upsert('session-1', { mode: 'full-access', permissionVersion: 2, permissionMigration: undefined }),
      ])

      await expect(index.list()).resolves.toMatchObject([{
        id: 'session-1',
        title: 'Renamed',
        mode: 'full-access',
      }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
