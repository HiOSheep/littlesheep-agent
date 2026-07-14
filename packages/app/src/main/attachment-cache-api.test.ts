import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

describe('managed attachment Local App API', () => {
  it('imports pasted content into the data-root cache instead of the default workplace', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-attachment-api-'))
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
      updateRuntimeConfig: vi.fn(async (_next: Config) => undefined),
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/attachments/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'clipboard.txt',
          dataUrl: `data:text/plain;base64,${Buffer.from('clipboard').toString('base64')}`,
        }),
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as {
        file: { path: string; cacheId?: string; ownership?: string; contentHash?: string }
      }
      expect(payload.file).toMatchObject({ ownership: 'cache' })
      expect(payload.file.cacheId).toMatch(/^[0-9a-f-]{36}$/u)
      expect(payload.file.contentHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(payload.file.path.startsWith(join(dataDir, 'attachment-cache', 'files'))).toBe(true)
      expect(existsSync(payload.file.path)).toBe(true)
      expect(existsSync(join(workplaceDir, 'attachments'))).toBe(false)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
