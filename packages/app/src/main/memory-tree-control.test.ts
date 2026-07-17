import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { MemoryRepository, MemoryV2ToV3MigrationManager } from '@littlesheep/memory-tree'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'
import { buildMemoryTreeNodeDetail, buildMemoryTreePayload, manageRuntimeMemoryNode } from './memory-tree-control.js'

function runnerWith(overrides: Record<string, unknown> = {}): AgentRunner {
  const repository = {
    getNode: vi.fn(async (_nodeId: string) => ({
      id: 'node-1', branch: 'project', parentNodeId: 'project:root', childIds: [],
      scope: 'workspace', scopeKey: 'D:/repo', tier: 2,
      summary: 'Use pnpm for this repository',
      content: 'Run pnpm build and pnpm test from the workspace root.',
      retrievalKeys: ['pnpm', 'build'], importance: 0.8, confidence: 0.9,
      reason: 'Observed in a verified project run.', sourceRunIds: ['run-1'],
      sourceStages: ['evolve'], sourceRefs: ['execution-logs/run-1.json'],
      status: 'active', createdAt: '2026-07-11T09:00:00.000Z', updatedAt: '2026-07-11T09:00:00.000Z',
    })),
    manageNode: vi.fn(async (_nodeId: string, _action: string, _reason?: string) => ({
      node: { id: 'node-1', branch: 'project', status: 'archived' },
      audit: { id: 'audit-1', nodeId: 'node-1', action: 'archive' },
    })),
    management: {
      status: vi.fn(async () => ({ backendKind: 'v2', storageKind: 'legacy-index', retrievalSupported: false })),
      inspectNode: vi.fn(async (_nodeId: string, disclosureLevel: 'D2' | 'D3') => ({
        backendKind: 'v2', nodeId: 'node-1', disclosureLevel,
      })),
    },
    snapshot: vi.fn(async () => ({
      version: 2,
      registryVersion: 1,
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
      resourceManagementAudit: [{
        id: 'resource-audit-1',
        resourceId: 'file:agents',
        resourceKind: 'agent-instructions',
        registryGroup: 'bootstrap',
        action: 'restore',
        actor: 'system',
        at: '2026-07-11T08:30:00.000Z',
        reason: 'Source became available again.',
        fromStatus: 'missing',
        toStatus: 'active',
      }],
      migrations: {
        'legacy-user-data-v1': {
          id: 'legacy-user-data-v1', completedAt: '2026-07-11T08:00:00.000Z', sourceCount: 1,
          created: 1, merged: 0, reinforced: 0, rejected: 0,
        },
      },
      resources: {},
      schemaMigrations: [],
    })),
  }
  const memoryTree = {
    invalidateBranch: vi.fn(async (_branch: string) => undefined),
    list: vi.fn(() => [{
      id: 'project',
      kind: 'project',
      displayName: 'Project Memory',
      purpose: 'Project-scoped architecture and decisions.',
      whenToUse: 'working in this project',
      searchHints: ['workspace'],
    }]),
    listLedgers: vi.fn((_limit = 80) => [{
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
  const memoryService = {
    getNode: repository.getNode,
    listConversationSources: vi.fn(async () => []),
    manageNode: vi.fn(async (...args: Parameters<typeof repository.manageNode>) => {
      const result = await repository.manageNode(...args)
      if (result) await memoryTree.invalidateBranch('project')
      return result
    }),
    manageResource: vi.fn(async (resourceId: string, action: string) => ({
      resource: { id: resourceId, status: action === 'disable' ? 'disabled' : 'active' },
      audit: { id: 'resource-audit-2', resourceId, action },
      changed: true,
      removed: action === 'remove',
    })),
    rebindResourceSource: vi.fn(async (resourceId: string, sourcePath: string) => ({
      resource: { id: resourceId, status: 'active', source: { kind: 'file', path: sourcePath } },
      audit: { id: 'resource-audit-3', resourceId, action: 'rebind' },
      changed: true,
      removed: false,
    })),
    getManagementSnapshot: vi.fn(async () => ({
      document: await repository.snapshot(),
      branches: memoryTree.list(),
      ledgers: memoryTree.listLedgers(),
      resources: [{
        version: 1,
        id: 'file:agents',
        kind: 'agent-instructions',
        title: 'AGENTS.md',
        description: 'Runtime operating rules.',
        tier: 0,
        scope: 'global',
        authority: 'authoritative',
        privacy: 'private',
        source: { kind: 'file', path: 'C:/user-data/AGENTS.md' },
        indexKeys: ['agents', 'rules'],
        status: 'active',
        registryGroup: 'bootstrap',
        registeredAt: '2026-07-11T08:00:00.000Z',
        updatedAt: '2026-07-11T08:00:00.000Z',
      }],
    })),
    listProjectMemoryProjectionStates: vi.fn(async (projects: Array<{ id: string; name: string; path: string }>) => (
      projects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        enabled: false,
        projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
        status: 'disabled',
        gitRepository: true,
        gitIgnored: false,
        gitIgnorePattern: '/.littlesheep/',
      }))
    )),
    getProjectMemoryProjectionState: vi.fn(async (project: { id: string; name: string; path: string }) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      enabled: false,
      projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
      status: 'disabled',
      gitRepository: true,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
    })),
    enableProjectMemoryProjection: vi.fn(async (project: { id: string; name: string; path: string }) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      enabled: true,
      projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
      status: 'ready',
      gitRepository: true,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
      entryCount: 2,
    })),
    syncProjectMemoryProjection: vi.fn(async (project: { id: string; name: string; path: string }) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      enabled: true,
      projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
      status: 'ready',
      gitRepository: true,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
      entryCount: 2,
    })),
    disableProjectMemoryProjection: vi.fn(async (project: { id: string; name: string; path: string }) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      enabled: false,
      projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
      status: 'disabled',
      gitRepository: true,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
    })),
    exportShareableProjectMemory: vi.fn(async (_project: unknown, outputPath: string) => ({
      outputPath,
      entryCount: 1,
      omittedEntryCount: 1,
      contentHash: 'hash',
      generatedAt: '2026-07-13T12:00:00.000Z',
    })),
    rebindProjectPath: vi.fn(async (_previous: unknown, project: { id: string; name: string; path: string }) => ({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      enabled: false,
      projectionPath: join(project.path, '.littlesheep', 'project-memory.private.json'),
      status: 'disabled',
      gitRepository: false,
      gitIgnored: false,
      gitIgnorePattern: '/.littlesheep/',
    })),
  }
  return {
    infra: {
      memoryRepository: repository,
      memoryTree,
      memoryService,
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
      nodes: Array<{ id: string; project?: { id: string }; hitCount: number }>
      totals: { indexedMemories: number; archivedMemories: number }
      resources: Array<{ id: string; tier: number; sourcePath?: string; managementHistory: Array<{ action: string }> }>
      projects: Array<{ id: string; projection?: { status: string; gitIgnorePattern: string } }>
      migration: { id: string } | null
      recentAccesses: Array<{ nodeId: string; runId: string }>
      repository: { backendKind: string }
    }

    expect(payload.nodes[0]).toMatchObject({
      id: 'node-1',
      project: { id: 'project-1' },
      hitCount: 1,
    })
    expect(payload.nodes[0]).not.toHaveProperty('content')
    expect(payload).not.toHaveProperty('longTermExcerpt')
    expect(JSON.stringify(payload)).not.toContain('Run pnpm build and pnpm test from the workspace root.')
    expect(payload.recentAccesses).toEqual([expect.objectContaining({ nodeId: 'node-1', runId: 'run-2' })])
    expect(payload.repository.backendKind).toBe('v2')
    expect(payload.totals).toMatchObject({ indexedMemories: 1, archivedMemories: 0 })
    expect(payload.resources).toEqual([expect.objectContaining({
      id: 'file:agents',
      tier: 0,
      sourcePath: 'C:/user-data/AGENTS.md',
      managementHistory: [expect.objectContaining({ action: 'restore' })],
    })])
    expect(payload.projects[0]?.projection).toMatchObject({ status: 'disabled', gitIgnorePattern: '/.littlesheep/' })
    expect(payload.migration?.id).toBe('legacy-user-data-v1')
  })

  it('invalidates the changed runtime branch and reports invalid transitions', async () => {
    const runner = runnerWith()
    await expect(manageRuntimeMemoryNode(runner, 'node-1', 'archive')).resolves.toMatchObject({
      status: 'changed',
      node: { status: 'archived' },
    })
    expect(runner.infra.memoryTree.invalidateBranch).toHaveBeenCalledWith('project')

    vi.mocked(runner.infra.memoryService.manageNode).mockRejectedValueOnce(new Error('invalid transition'))
    await expect(manageRuntimeMemoryNode(runner, 'node-1', 'restore')).resolves.toEqual({
      status: 'invalid',
      error: 'invalid transition',
    })
  })

  it('maps v3 D3 evidence, embedding state and history without creating a UI copy', async () => {
    const runner = runnerWith()
    vi.mocked(runner.infra.memoryRepository.management.inspectNode).mockResolvedValueOnce({
      backendKind: 'v3',
      nodeId: 'node-1',
      disclosureLevel: 'D3',
      atom: {
        version: 3,
        id: 'node-1',
        revision: 4,
        domain: 'project',
        branch: 'project',
        parentId: 'project:root',
        scope: 'workspace',
        scopeKey: 'D:/repo',
        tier: 2,
        statementKind: 'factual-claim',
        epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo', topics: ['build'] },
        assertedBy: { kind: 'tool', id: 'verify' },
        sourceRefs: ['conversation-source:run-1:user-message:message-1'],
        evidenceRefs: ['execution-logs/run-1.json'],
        entityRefs: [], relationRefs: [], title: 'Use pnpm', summary: 'Use pnpm for this repository',
        content: 'Run pnpm build and pnpm test from the workspace root.', retrievalKeys: ['pnpm'],
        importance: 0.8, confidence: 0.9, basePriority: 0.85,
        verifiedUsefulness: { useful: 2, notUseful: 0, conflicts: 0, stale: 0, lastOutcome: 'useful' },
        feedbackRevision: 2, lastUsefulAt: '2026-07-15T10:00:00.000Z', lastVerifiedAt: '2026-07-15T10:00:00.000Z',
        reason: 'Verified build evidence.', sourceRunIds: ['run-1'], sourceStages: ['evolve'], status: 'active',
        resolutionStatus: 'resolved', createdAt: '2026-07-11T09:00:00.000Z', updatedAt: '2026-07-15T10:00:00.000Z',
        contentHash: 'sha256:atom',
      },
      catalog: {
        atomId: 'node-1', filePath: 'atoms/project/node-1.json', revision: 4, domain: 'project', branch: 'project',
        parentId: 'project:root', scope: 'workspace', scopeKey: 'D:/repo', tier: 2,
        statementKind: 'factual-claim', epistemicStatus: 'verified', status: 'active', resolutionStatus: 'resolved',
        contentHash: 'sha256:atom', embeddingHash: 'sha256:embedding', vectorNamespace: 'memory-atom',
        embeddingStatus: 'ready', embeddingEngineId: 'local-bge',
        embeddingModelId: 'bge-m3', embeddingDimensions: 1024,
        activationScore: 0.82, activationUpdatedAt: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-11T09:00:00.000Z', updatedAt: '2026-07-15T10:00:00.000Z',
      },
      envelope: {
        atomId: 'node-1', atomRevision: 4, branch: 'project', scope: 'workspace', scopeKey: 'D:/repo', tier: 2,
        disclosureLevel: 'D3', statementKind: 'factual-claim', epistemicStatus: 'verified',
        authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo', topics: ['build'] },
        assertedBy: { kind: 'tool', id: 'verify' },
        sourceRefs: ['conversation-source:run-1:user-message:message-1'],
        evidenceRefs: ['execution-logs/run-1.json'],
        confidence: 0.9, importance: 0.8, taskRelevance: 0.95,
        verifiedUsefulness: { useful: 2, notUseful: 0, conflicts: 0, stale: 0, lastOutcome: 'useful' },
        routingRelevance: 0.75,
        relationshipRelevance: 0.8,
        activation: {
          version: 1, score: 0.82, quality: 0.9, frequency: 0.7, recency: 1,
          evidenceWeight: 2, protected: false, computedAt: '2026-07-15T10:00:00.000Z',
        },
        updatedAt: '2026-07-15T10:00:00.000Z', lastVerifiedAt: '2026-07-15T10:00:00.000Z',
        retrievalPath: 'hierarchy', matchReason: 'Selected by id.', conflict: false, expired: false, truncated: false,
      },
      history: {
        atomId: 'node-1', revision: 4, sourceRunIds: ['run-1'], sourceStages: ['evolve'], truncated: false,
        entries: [{ kind: 'event', id: 'event-1', at: '2026-07-15T10:00:00.000Z', summary: 'Verified build result.' }],
      },
    })

    const detail = await buildMemoryTreeNodeDetail(runner, 'node-1', 'D3')

    expect(detail).toMatchObject({
      backendKind: 'v3',
      disclosureLevel: 'D3',
      v3: {
        revision: 4,
        domain: 'project',
        epistemicStatus: 'verified',
        embedding: { status: 'ready', modelId: 'bge-m3', dimensions: 1024 },
        history: { entries: [{ kind: 'event', id: 'event-1' }] },
      },
    })
  })

  it('exposes the management action through the loopback Local App API', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-memory-control-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const migrationRepository = new MemoryRepository({ dataDir, backend: 'v2' })
    await migrationRepository.initialize()
    migrationRepository.close()
    const runner = runnerWith()
    let embeddingState: 'missing' | 'preparing' = 'missing'
    const embeddingModelManager = {
      status: vi.fn(async () => embeddingModelStatus(embeddingState)),
      start: vi.fn(async () => {
        embeddingState = 'preparing'
        return embeddingModelStatus(embeddingState)
      }),
      cancel: vi.fn(async () => {
        embeddingState = 'missing'
        return embeddingModelStatus(embeddingState)
      }),
      shutdown: vi.fn(async () => undefined),
    }
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
      selectMemoryResourceSource: vi.fn(async () => 'D:/repo/docs/principles/architecture-principles.md'),
      memoryV3MigrationManager: new MemoryV2ToV3MigrationManager({ dataDir }),
      memoryEmbeddingModelManager: embeddingModelManager,
    })
    try {
      const detail = await fetch(`http://127.0.0.1:${server.port}/memory/tree/nodes/node-1?disclosure=D3`)
      expect(detail.status).toBe(200)
      await expect(detail.json()).resolves.toMatchObject({
        nodeId: 'node-1',
        backendKind: 'v2',
        disclosureLevel: 'D3',
        content: 'Run pnpm build and pnpm test from the workspace root.',
        recentHits: [{ runId: 'run-2' }],
        writeHistory: [{ id: 'write-1' }],
      })

      const migration = await fetch(`http://127.0.0.1:${server.port}/memory/tree/migration`)
      expect(migration.status).toBe(200)
      await expect(migration.json()).resolves.toMatchObject({
        activeBackend: 'v2',
        canMigrate: true,
        source: { nodeCount: 0 },
        embeddingModel: { modelId: 'bge-small-zh-v1.5', state: 'missing', available: false },
      })

      const embeddingStatus = await fetch(`http://127.0.0.1:${server.port}/memory/tree/embedding-model`)
      expect(embeddingStatus.status).toBe(200)
      await expect(embeddingStatus.json()).resolves.toMatchObject({ state: 'missing' })
      const embeddingStarted = await fetch(`http://127.0.0.1:${server.port}/memory/tree/embedding-model`, { method: 'POST' })
      expect(embeddingStarted.status).toBe(202)
      await expect(embeddingStarted.json()).resolves.toMatchObject({ state: 'preparing' })
      const migrationWhilePreparing = await fetch(`http://127.0.0.1:${server.port}/memory/tree/migration`, { method: 'POST' })
      expect(migrationWhilePreparing.status).toBe(409)
      await expect(migrationWhilePreparing.json()).resolves.toMatchObject({
        error: expect.stringContaining('still running'),
      })
      const embeddingCancelled = await fetch(`http://127.0.0.1:${server.port}/memory/tree/embedding-model`, { method: 'DELETE' })
      expect(embeddingCancelled.status).toBe(200)
      await expect(embeddingCancelled.json()).resolves.toMatchObject({ state: 'missing' })

      const requestedMigration = await fetch(`http://127.0.0.1:${server.port}/memory/tree/migration`, { method: 'POST' })
      expect(requestedMigration.status).toBe(200)
      await expect(requestedMigration.json()).resolves.toMatchObject({
        activeBackend: 'v2',
        requiresRestart: true,
        pendingOperation: { kind: 'migration', phase: 'requested', attempts: 0 },
      })
      const cancelledMigration = await fetch(`http://127.0.0.1:${server.port}/memory/tree/migration`, { method: 'DELETE' })
      expect(cancelledMigration.status).toBe(200)
      await expect(cancelledMigration.json()).resolves.toMatchObject({ requiresRestart: false })

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

      const disabled = await fetch(`http://127.0.0.1:${server.port}/memory/tree/resources/${encodeURIComponent('file:agents')}/manage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disable' }),
      })
      expect(disabled.status).toBe(200)
      await expect(disabled.json()).resolves.toMatchObject({
        cancelled: false,
        resource: { id: 'file:agents', status: 'disabled' },
        audit: { action: 'disable' },
      })
      expect(runner.infra.memoryService.manageResource).toHaveBeenCalledWith(
        'file:agents',
        'disable',
        '用户在记忆树资源目录执行了“停用”操作。',
      )

      const rebound = await fetch(`http://127.0.0.1:${server.port}/memory/tree/resources/${encodeURIComponent('file:agents')}/manage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rebind' }),
      })
      expect(rebound.status).toBe(200)
      expect(runner.infra.memoryService.rebindResourceSource).toHaveBeenCalledWith(
        'file:agents',
        'D:/repo/docs/principles/architecture-principles.md',
        '用户从记忆树管理页面重新定位了资源。',
      )
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
    expect(embeddingModelManager.shutdown).toHaveBeenCalledOnce()
  })

  it('exposes project-memory projection actions only for registered projects', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-project-memory-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const projectDir = join(dataDir, 'repo')
    mkdirSync(projectDir, { recursive: true })
    const projectIndex = new ProjectIndex({ dataDir })
    const project = await projectIndex.ensure(projectDir)
    const runner = runnerWith()
    const exportPath = join(dataDir, 'exports', 'memory.md')
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
      projectIndex,
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config: DEFAULT_CONFIG,
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
      selectProjectMemoryExport: vi.fn(async () => exportPath),
    })
    try {
      const enabled = await fetch(`http://127.0.0.1:${server.port}/memory/projects/${encodeURIComponent(project.id)}/projection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'enable' }),
      })
      expect(enabled.status).toBe(200)
      await expect(enabled.json()).resolves.toMatchObject({ enabled: true, status: 'ready', entryCount: 2 })
      expect(runner.infra.memoryService.enableProjectMemoryProjection).toHaveBeenCalledWith(
        expect.objectContaining({ id: project.id, path: projectDir }),
        { overwriteExisting: false },
      )

      const exported = await fetch(`http://127.0.0.1:${server.port}/memory/projects/${encodeURIComponent(project.id)}/projection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export' }),
      })
      expect(exported.status).toBe(200)
      await expect(exported.json()).resolves.toMatchObject({
        cancelled: false,
        export: { outputPath: exportPath, entryCount: 1 },
      })

      const missing = await fetch(`http://127.0.0.1:${server.port}/memory/projects/missing/projection`)
      expect(missing.status).toBe(404)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rebinds a moved project through the Local App API without changing its identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-project-rebind-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const originalPath = join(dataDir, 'Original')
    const movedPath = join(dataDir, 'Moved')
    mkdirSync(originalPath, { recursive: true })
    mkdirSync(movedPath, { recursive: true })
    const projectIndex = new ProjectIndex({ dataDir })
    const project = await projectIndex.ensure(originalPath)
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    await sessionIndex.upsert('project-session', {
      title: 'Project session', createdAt: 1, lastMessageAt: 2, mode: 'research',
      scope: 'project', projectId: project.id, workspacePath: originalPath,
    })
    const runner = runnerWith()
    const updateRuntimeConfig = vi.fn(async () => undefined)
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = originalPath
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex,
      projectIndex,
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config,
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig,
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/projects/${encodeURIComponent(project.id)}/rebind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: movedPath }),
      })

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        project: { id: project.id, path: movedPath },
        sessions: [{ id: 'project-session', projectId: project.id, workspacePath: movedPath }],
        runtime: { workspace: movedPath },
      })
      expect(runner.infra.memoryService.rebindProjectPath).toHaveBeenCalledWith(
        expect.objectContaining({ id: project.id, path: originalPath }),
        expect.objectContaining({ id: project.id, path: movedPath }),
      )
      expect(updateRuntimeConfig).toHaveBeenCalledWith(expect.objectContaining({
        agents: { defaults: expect.objectContaining({ workspace: movedPath }) },
      }))
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

function embeddingModelStatus(state: 'missing' | 'preparing') {
  return {
    modelId: 'bge-small-zh-v1.5',
    state,
    available: false,
    requiredBytes: 24_450_000,
    verifiedBytes: 0,
    completedBytes: state === 'preparing' ? 1024 : 0,
    totalBytes: 24_450_000,
    missing: ['config.json', 'onnx/model_quantized.onnx'],
    invalid: [],
    currentFile: state === 'preparing' ? 'config.json' : undefined,
    updatedAt: '2026-07-16T04:00:00.000Z',
  }
}
