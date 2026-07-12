import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArchiveIndex } from './archive-index.js'
import type { ProjectMeta } from './project-index.js'
import type { SessionMeta } from './session-index.js'

describe('ArchiveIndex', () => {
  it('archives and restores projects and their sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-archive-index-'))
    try {
      const archive = new ArchiveIndex({ dataDir: dir })
      const project: ProjectMeta = {
        id: 'alpha',
        name: 'Alpha',
        path: join(dir, 'Alpha'),
        createdAt: '2026-07-08T10:00:00.000Z',
        lastActiveAt: '2026-07-08T11:00:00.000Z',
      }
      const session: SessionMeta = {
        id: 's1',
        title: 'Plan',
        createdAt: 1,
        lastMessageAt: 2,
        mode: 'info',
        scope: 'project',
        projectId: project.id,
        workspacePath: project.path,
      }

      await archive.archiveProject(project, 10)
      await archive.archiveSession(session, 11)

      const listed = await archive.list()
      expect(listed.projects[0]?.id).toBe(project.id)
      expect(listed.sessions[0]?.id).toBe(session.id)

      const restoredProject = await archive.restoreProject(project.id)
      const restoredSessions = await archive.restoreSessionsForProject(project)
      expect(restoredProject?.id).toBe(project.id)
      expect(restoredSessions.map((item) => item.id)).toEqual([session.id])
      expect(await archive.list()).toEqual({ projects: [], sessions: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not move a standalone session that uses the same workspace as a project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-archive-index-'))
    try {
      const archive = new ArchiveIndex({ dataDir: dir })
      const project: ProjectMeta = {
        id: 'alpha',
        name: 'Alpha',
        path: join(dir, 'Alpha'),
        createdAt: '2026-07-08T10:00:00.000Z',
        lastActiveAt: '2026-07-08T11:00:00.000Z',
      }
      const projectSession: SessionMeta = {
        id: 'project-session',
        title: 'Project chat',
        createdAt: 1,
        lastMessageAt: 2,
        mode: 'research',
        scope: 'project',
        projectId: project.id,
        workspacePath: project.path,
      }
      const standaloneSession: SessionMeta = {
        id: 'standalone-session',
        title: 'Standalone chat',
        createdAt: 3,
        lastMessageAt: 4,
        mode: 'research',
        scope: 'standalone',
        workspacePath: project.path,
      }

      await archive.archiveSession(projectSession)
      await archive.archiveSession(standaloneSession)

      const restored = await archive.restoreSessionsForProject(project)
      expect(restored.map((session) => session.id)).toEqual([projectSession.id])
      expect((await archive.list()).sessions.map((session) => session.id)).toEqual([standaloneSession.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes a legacy workplace project shell while retaining its conversations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-archive-index-'))
    const workplace = join(dir, 'workplace')
    try {
      const archive = new ArchiveIndex({ dataDir: dir, workplaceDir: workplace })
      const project: ProjectMeta = {
        id: 'legacy-workplace',
        name: 'workplace',
        path: workplace,
        createdAt: '2026-07-08T10:00:00.000Z',
        lastActiveAt: '2026-07-08T11:00:00.000Z',
      }
      await archive.archiveProject(project)
      await archive.archiveSession({
        id: 'legacy-chat',
        title: 'Legacy chat',
        createdAt: 1,
        lastMessageAt: 2,
        mode: 'research',
        scope: 'standalone',
        workspacePath: workplace,
      })

      await expect(archive.removeProjectByPath(workplace)).resolves.toMatchObject({ id: project.id })
      const remaining = await archive.list()
      expect(remaining.projects).toEqual([])
      expect(remaining.sessions.map((session) => session.id)).toEqual(['legacy-chat'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
