import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'
import { buildMemoryTreePayload, manageRuntimeMemoryNode } from './memory-tree-control.js'

function runnerWith(overrides: Record<string, unknown> = {}): AgentRunner {
  const repository = {
    getNode: vi.fn(async () => ({ id: 'node-1', branch: 'project', status: 'active' })),
    manageNode: vi.fn(async () => ({
      node: { id: 'node-1', branch: 'project', status: 'archived' },
      audit: { id: 'audit-1', nodeId: 'node-1', action: 'archive' },
    })),
    snapshot: vi.fn(async () => ({
      version: 1,
      updatedAt: '2026-07-11T10:00:00.000Z',
      nodes: {
        'node-1': {
          id: 'node-1',
          branch: 'project',
          parentNodeId: 'project:root',
          childIds: [],
          scope: 'workspace',
          scopeKey: 'D:/repo',
          tier: 2,
          summary: 'Use pnpm for this repository',
          content: 'Run pnpm build and pnpm test from the workspace root.',
          retrievalKeys: ['pnpm', 'build'],
          importance: 0.8,
          confidence: 0.9,
          reason: 'Observed in a verified project run.',
          sourceRunIds: ['run-1'],
          sourceStages: ['evolve'],
          sourceRefs: ['execution-logs/run-1.json'],
          status: 'active',
          createdAt: '2026-07-11T09:00:00.000Z',
          updatedAt: '2026-07-11T09:00:00.000Z',
        },
      },
      recoveryQueue: [],
      writeAudit: [{
        id: 'write-1', intentId: 'intent-1', sourceRunId: 'run-1', branch: 'project',
        at: '2026-07-11T09:00:00.000Z', decision: 'created', nodeId: 'node-1', reason: 'created',
      }],
      managementAudit: [],
      migrations: {
        'legacy-user-data-v1': {
          id: 'legacy-user-data-v1', completedAt: '2026-07-11T08:00:00.000Z', sourceCount: 1,
          created: 1, merged: 0, reinforced: 0, rejected: 0,
        },
      },
    })),
  }
  const memoryTree = {
    invalidateBranch: vi.fn(async () => undefined),
    list: vi.fn(() => [{
      id: 'project',
      kind: 'project',
      displayName: 'Project Memory',
      purpose: 'Project-scoped architecture and decisions.',
      whenToUse: 'working in this project',
      searchHints: ['workspace'],
    }]),
    listLedgers: vi.fn(() => [{
      runId: 'run-2',
      sessionId: 'session-1',
      workspace: 'D:/repo',
      startedAt: '2026-07-11T10:00:00.000Z',
      endedAt: '2026-07-11T10:01:00.000Z',
      totalTokenBudget: 1000,
      tokensUsed: 40,
      expandedBranches: ['project'],
      dedupKeys: ['node-1'],
      records: [{
        id: 'hit-1', action: 'expand', at: '2026-07-11T10:00:30.000Z', branchId: 'project',
        query: 'build command', status: 'ok', fragmentIds: ['node-1'], sourceCount: 1,
        dedupedCount: 0, tokensUsed: 20, tokenBudget: 100,
      }],
    }]),
  }
  return {
    infra: {
      memoryRepository: repository,
      memoryTree,
      memoryStore: {
        readLongTerm: vi.fn(async () => { throw new Error('migrated source should not be read') }),
        listDailyDates: vi.fn(async () => { throw new Error('migrated source should not be read') }),
      },
      experienceStore: {
        list: vi.fn(async () => { throw new Error('migrated source should not be read') }),
      },
      ...overrides,
    },
  } as unknown as AgentRunner
}

describe('memory-tree control plane', () => {
  it('maps runtime nodes, project ownership and real ledger hits into one payload', async () => {
    const projectIndex = {
      list: vi.fn(async () => [{
        id: 'project-1', name: 'Repo', path: 'D:\\repo',
        createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-11T10:00:00.000Z',
      }]),
    } as unknown as ProjectIndex
    const payload = await buildMemoryTreePayload(runnerWith(), projectIndex, DEFAULT_CONFIG) as {
      nodes: Array<{ id: string; project?: { id: string }; hitCount: number; recentHits: Array<{ runId: string }> }>
      totals: { indexedMemories: number; archivedMemories: number }
      migration: { id: string } | null
    }

    expect(payload.nodes[0]).toMatchObject({
      id: 'node-1',
      project: { id: 'project-1' },
      hitCount: 1,
      recentHits: [{ runId: 'run-2' }],
    })
    expect(payload.totals).toMatchObject({ indexedMemories: 1, archivedMemories: 0 })
    expect(payload.migration?.id).toBe('legacy-user-data-v1')
  })

  it('invalidates the changed runtime branch and reports invalid transitions', async () => {
    const runner = runnerWith()
    await expect(manageRuntimeMemoryNode(runner, 'node-1', 'archive')).resolves.toMatchObject({
      status: 'changed',
      node: { status: 'archived' },
    })
    expect(runner.infra.memoryTree.invalidateBranch).toHaveBeenCalledWith('project')

    vi.mocked(runner.infra.memoryRepository.manageNode).mockRejectedValueOnce(new Error('invalid transition'))
    await expect(manageRuntimeMemoryNode(runner, 'node-1', 'restore')).resolves.toEqual({
      status: 'invalid',
      error: 'invalid transition',
    })
  })

  it('exposes the management action through the loopback Local App API', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-control-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const runner = runnerWith()
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
      projectIndex: new ProjectIndex({ dataDir }),
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config: DEFAULT_CONFIG,
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/memory/tree/nodes/node-1/manage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        node: { id: 'node-1', status: 'archived' },
        audit: { action: 'archive' },
      })

      const invalid = await fetch(`http://127.0.0.1:${server.port}/memory/tree/nodes/node-1/manage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rewrite' }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
