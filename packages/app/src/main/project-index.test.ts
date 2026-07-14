import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProjectIndex, projectIdFromPath } from './project-index.js'

describe('ProjectIndex', () => {
  it('registers a workspace once and updates lastActiveAt on reuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const workspace = join(dir, 'LittleSheep')
      const index = new ProjectIndex({ dataDir: dir })

      const first = await index.ensure(workspace, new Date('2026-07-08T10:00:00.000Z'))
      const second = await index.ensure(workspace, new Date('2026-07-08T11:00:00.000Z'))
      const projects = await index.list()

      expect(projects).toHaveLength(1)
      expect(first.id).toMatch(/^project-[0-9a-f-]{36}$/u)
      expect(first.id).not.toBe(projectIdFromPath(workspace))
      expect(first.identityVersion).toBe(2)
      expect(second.id).toBe(first.id)
      expect(second.name).toBe('LittleSheep')
      expect(second.lastActiveAt).toBe('2026-07-08T11:00:00.000Z')
      expect(projects[0]?.path).toBe(second.path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves insertion order when an existing project becomes active again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const alpha = join(dir, 'Alpha')
      const beta = join(dir, 'Beta')
      const index = new ProjectIndex({ dataDir: dir })

      const first = await index.ensure(alpha, new Date('2026-07-08T10:00:00.000Z'))
      const second = await index.ensure(beta, new Date('2026-07-08T11:00:00.000Z'))
      await index.ensure(alpha, new Date('2026-07-08T12:00:00.000Z'))
      const projects = await index.list()

      expect(projects.map((project) => project.id)).toEqual([first.id, second.id])
      expect(projects[0]?.lastActiveAt).toBe('2026-07-08T12:00:00.000Z')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes a project by id without touching other registered workspaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const firstWorkspace = join(dir, 'Alpha')
      const secondWorkspace = join(dir, 'Beta')
      const index = new ProjectIndex({ dataDir: dir })

      const first = await index.ensure(firstWorkspace)
      const second = await index.ensure(secondWorkspace)
      const removed = await index.remove(first.id)
      const projects = await index.list()

      expect(removed?.id).toBe(first.id)
      expect(projects).toHaveLength(1)
      expect(projects[0]?.id).toBe(second.id)
      await expect(index.remove(first.id)).resolves.toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the default workplace registration by path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const workplace = join(dir, 'workplace')
      const project = join(dir, 'Project')
      const index = new ProjectIndex({ dataDir: dir })
      const workplaceProject = await index.ensure(workplace)
      const realProject = await index.ensure(project)

      await expect(index.removeByPath(workplace)).resolves.toMatchObject({ id: workplaceProject.id })
      expect((await index.list()).map((item) => item.id)).toEqual([realProject.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes current and retired default workspace shells without touching real projects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const workplace = join(dir, '.littlesheep', 'workplace')
      const retiredWorkspace = join(dir, '.legacy-app', 'workspace')
      const explicitHiddenProject = join(dir, 'client', '.cache', 'workspace')
      const realProject = join(dir, 'Project')
      const index = new ProjectIndex({ dataDir: dir })
      const currentShell = await index.ensure(workplace)
      const retiredShell = await index.ensure(retiredWorkspace)
      const hiddenProject = await index.ensure(explicitHiddenProject)
      const project = await index.ensure(realProject)

      const removed = await index.removeManagedWorkspaceShells(workplace)

      expect(removed.map((item) => item.id)).toEqual([currentShell.id, retiredShell.id])
      expect((await index.list()).map((item) => item.id)).toEqual([hiddenProject.id, project.id])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updates recent activity without changing project order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const index = new ProjectIndex({ dataDir: dir })
      const first = await index.ensure(join(dir, 'Alpha'), new Date('2026-07-08T10:00:00.000Z'))
      const second = await index.ensure(join(dir, 'Beta'), new Date('2026-07-08T11:00:00.000Z'))

      await index.touch(first.id, new Date('2026-07-08T12:00:00.000Z'))
      const projects = await index.list()

      expect(projects.map((project) => project.id)).toEqual([first.id, second.id])
      expect(projects[0]?.lastActiveAt).toBe('2026-07-08T12:00:00.000Z')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the stable id while rebinding a moved project path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const index = new ProjectIndex({ dataDir: dir })
      const originalPath = join(dir, 'Original')
      const movedPath = join(dir, 'Moved')
      const project = await index.ensure(originalPath, new Date('2026-07-08T10:00:00.000Z'))

      const rebound = await index.rebind(project.id, movedPath, new Date('2026-07-08T12:00:00.000Z'))

      expect(rebound).toMatchObject({
        id: project.id,
        name: 'Moved',
        path: movedPath,
        identityVersion: 2,
        pathUpdatedAt: '2026-07-08T12:00:00.000Z',
      })
      expect(rebound?.previousPaths).toEqual([originalPath])
      expect((await index.list())).toEqual([rebound])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves a legacy path-derived id when upgrading its path binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-legacy-'))
    try {
      const originalPath = join(dir, 'Legacy')
      const movedPath = join(dir, 'Legacy Moved')
      const legacyId = projectIdFromPath(originalPath)
      mkdirSync(join(dir, 'projects'), { recursive: true })
      writeFileSync(join(dir, 'projects', 'index.json'), JSON.stringify({
        projects: [{
          id: legacyId,
          name: 'Legacy',
          path: originalPath,
          createdAt: '2026-07-01T00:00:00.000Z',
          lastActiveAt: '2026-07-01T00:00:00.000Z',
        }],
      }, null, 2), 'utf8')
      const index = new ProjectIndex({ dataDir: dir })

      const rebound = await index.rebind(legacyId, movedPath, new Date('2026-07-13T00:00:00.000Z'))

      expect(rebound).toMatchObject({
        id: legacyId,
        path: movedPath,
        identityVersion: 2,
        previousPaths: [originalPath],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects rebinding onto another active project path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-project-index-'))
    try {
      const index = new ProjectIndex({ dataDir: dir })
      const first = await index.ensure(join(dir, 'Alpha'))
      const second = await index.ensure(join(dir, 'Beta'))

      await expect(index.rebind(first.id, second.path)).rejects.toThrow(`project ${second.id}`)
      expect((await index.list()).find((project) => project.id === first.id)?.path).toBe(first.path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
