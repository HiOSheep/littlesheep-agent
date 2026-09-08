import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'

describe('cache quality Local App API', () => {
  it('returns the authorized scope report and fails closed without scope inputs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-cache-quality-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const report = vi.fn(async () => ({
      status: 'available' as const,
      report: {
        version: 1 as const,
        requestCount: 1,
        unreadableEntryCount: 0,
        partitions: [{ provider: 'openai', model: 'test/model', requestCount: 1 }],
        providerPrompt: {
          statusCounts: { hit: 0, miss: 1, partial: 0, unavailable: 0, unknown: 0 },
          tokenCount: 100,
          cachedTokenCount: 0,
          hitRatio: 0,
          reasonCounts: [],
        },
        lsContext: {
          statusCounts: { hit: 0, miss: 0, partial: 0, unavailable: 1, unknown: 0 },
          reasonCounts: [],
        },
        memoryEmbedding: {
          statusCounts: { hit: 0, miss: 0, partial: 0, unavailable: 1, unknown: 0 },
          reasonCounts: [],
        },
        invalidationReasons: [],
        releaseGate: {
          status: 'blocked' as const,
          reasons: ['real_provider_reconciliation_not_verified'],
        },
      },
    }))
    const runner = {
      state: { model: DEFAULT_CONFIG.agents.defaults.model },
      infra: {
        cacheObservationStore: { report },
        cacheObservationKey: 'cache-quality-api-key',
      },
    } as unknown as AgentRunner
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
      projectIndex: new ProjectIndex({ dataDir }),
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config: structuredClone(DEFAULT_CONFIG),
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
    })

    try {
      const query = new URLSearchParams({
        sessionId: 'session-a',
        workspace: workplaceDir,
        permission: 'research',
        since: '2026-09-09T00:00:00.000Z',
        until: '2026-09-09T01:00:00.000Z',
      })
      const response = await fetch(`http://127.0.0.1:${server.port}/runtime/cache-quality?${query}`)
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        status: 'available',
        report: { requestCount: 1, providerPrompt: { statusCounts: { miss: 1 } } },
      })
      expect(report).toHaveBeenCalledWith({
        sessionId: 'session-a',
        workspaceScope: workplaceDir,
        permissionPolicyId: 'research',
        key: 'cache-quality-api-key',
        since: Date.parse('2026-09-09T00:00:00.000Z'),
        until: Date.parse('2026-09-09T01:00:00.000Z'),
      })

      const missingScope = await fetch(`http://127.0.0.1:${server.port}/runtime/cache-quality?sessionId=session-a`)
      expect(missingScope.status).toBe(200)
      await expect(missingScope.json()).resolves.toEqual({
        status: 'unavailable',
        reason: 'cache_quality_scope_unavailable',
      })
      expect(report).toHaveBeenCalledTimes(1)

      const invalidWindow = await fetch(
        `http://127.0.0.1:${server.port}/runtime/cache-quality?sessionId=session-a&workspace=${encodeURIComponent(workplaceDir)}&permission=research&since=not-a-time`,
      )
      expect(invalidWindow.status).toBe(400)
      expect(report).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
