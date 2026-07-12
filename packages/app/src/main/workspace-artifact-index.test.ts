import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'

describe('WorkspaceArtifactIndex', () => {
  it('persists and filters workspace artifacts by workspace and session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-artifacts-'))
    try {
      const index = new WorkspaceArtifactIndex({ dataDir: dir })
      const workspaceA = join(dir, 'project-a')
      const workspaceB = join(dir, 'project-b')

      await index.appendMany([
        {
          path: join(workspaceA, 'one.ts'),
          action: 'created',
          source: 'agent',
          workspacePath: workspaceA,
          sessionId: 's1',
          projectId: 'p1',
          runId: 'r1',
          toolName: 'write',
          createdAt: '2026-07-09T10:00:00.000Z',
        },
        {
          path: join(workspaceA, 'two.ts'),
          action: 'modified',
          source: 'user',
          workspacePath: workspaceA,
          createdAt: '2026-07-09T11:00:00.000Z',
        },
        {
          path: join(workspaceB, 'other.ts'),
          action: 'created',
          source: 'agent',
          workspacePath: workspaceB,
          sessionId: 's2',
          createdAt: '2026-07-09T12:00:00.000Z',
        },
      ])

      const reloaded = new WorkspaceArtifactIndex({ dataDir: dir })
      const records = await reloaded.list({ workspacePath: workspaceA, sessionId: 's1' })

      expect(records).toHaveLength(2)
      expect(records.map((record) => record.name)).toEqual(['two.ts', 'one.ts'])
      expect(records[0]?.source).toBe('user')
      expect(records[1]?.runId).toBe('r1')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
