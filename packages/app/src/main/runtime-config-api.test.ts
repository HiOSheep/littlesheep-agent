import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'

describe('runtime config Local App API', () => {
  it('returns, validates, persists, and reuses the context compression threshold', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-runtime-config-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const config = structuredClone(DEFAULT_CONFIG)
    const updates: Config[] = []
    const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
      projectIndex: new ProjectIndex({ dataDir }),
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config,
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async (next: Config) => {
        updates.push(next)
      }),
    })

    try {
      const initial = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      expect(initial.status).toBe(200)
      await expect(initial.json()).resolves.toMatchObject({ contextCompressionThresholdRatio: 0.8 })

      const changed = await fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextCompressionThresholdRatio: 0.9 }),
      })
      expect(changed.status).toBe(200)
      await expect(changed.json()).resolves.toMatchObject({ contextCompressionThresholdRatio: 0.9 })
      expect(updates.at(-1)?.agents.defaults.contextCompressionThresholdRatio).toBe(0.9)

      const after = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      await expect(after.json()).resolves.toMatchObject({ contextCompressionThresholdRatio: 0.9 })

      for (const invalid of [0.49, 0.96, '0.8', null]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/runtime`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contextCompressionThresholdRatio: invalid }),
        })
        expect(response.status).toBe(400)
      }
      expect(updates).toHaveLength(1)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
