import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
    getNode: vi.fn(async (_nodeId: string) => ({ id: 'node-1', branch: 'project', status: 'active' })),
    manageNode: vi.fn(async (_nodeId: string, _action: string, _reason?: string) => ({
      node: { id: 'node-1', branch: 'project', status: 'archived' },
      audit: { id: 'audit-1', nodeId: 'node-1', action: 'archive' },
    })),
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
      nodes: Array<{ id: string; project?: { id: string }; hitCount: number; recentHits: Array<{ runId: string }> }>
      totals: { indexedMemories: number; archivedMemories: number }
      resources: Array<{ id: string; tier: number; sourcePath?: string; managementHistory: Array<{ action: string }> }>
      projects: Array<{ id: string; projection?: { status: string; gitIgnorePattern: string } }>
      migration: { id: string } | null
    }

    expect(payload.nodes[0]).toMatchObject({
      id: 'node-1',
      project: { id: 'project-1' },
      hitCount: 1,
      recentHits: [{ runId: 'run-2' }],
    })
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
      selectMemoryResourceSource: vi.fn(async () => 'D:/repo/docs/architecture-principles.md'),
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
        'D:/repo/docs/architecture-principles.md',
        '用户从记忆树管理页面重新定位了资源。',
      )
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
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
