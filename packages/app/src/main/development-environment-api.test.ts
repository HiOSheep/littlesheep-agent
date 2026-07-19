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

describe('development environment Local App API', () => {
  it('exposes status, validates version preferences, and keeps picker cancellation harmless', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-development-environment-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const config = structuredClone(DEFAULT_CONFIG)
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
      updateRuntimeConfig: vi.fn(async () => undefined),
      selectDevelopmentEnvironmentSource: vi.fn(async () => null),
    })

    try {
      const base = `http://127.0.0.1:${server.port}`
      const initial = await fetch(`${base}/development-environments`)
      expect(initial.status).toBe(200)
      const initialPayload = await initial.json() as {
        environments: Array<{ id: string; activeManagedVersion: string | null }>
      }
      expect(initialPayload.environments.some((item) => item.id === 'node')).toBe(true)

      const invalid = await fetch(`${base}/development-environments/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'python', version: '../outside' }),
      })
      expect(invalid.status).toBe(400)

      const saved = await fetch(`${base}/development-environments/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'python', version: '3.12' }),
      })
      expect(saved.status).toBe(200)
      await expect(saved.json()).resolves.toMatchObject({
        environments: expect.arrayContaining([
          expect.objectContaining({ id: 'python', requestedVersion: '3.12' }),
        ]),
      })

      const cancelledImport = await fetch(`${base}/development-environments/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: 'python', version: '3.12' }),
      })
      expect(cancelledImport.status).toBe(200)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
