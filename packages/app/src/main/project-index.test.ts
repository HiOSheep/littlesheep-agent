import { mkdtempSync, rmSync } from 'node:fs'
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
      expect(first.id).toBe(projectIdFromPath(workspace))
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
})
