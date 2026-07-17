import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer, type LocalAppApiServer } from './local-app-api-server.js'

const directories: string[] = []
const servers: LocalAppApiServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('memory file Local App API', () => {
  it('exposes the document projection, permits only SOUL.md writes, and advertises PUT', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ls-memory-files-api-'))
    directories.push(dataDir)
    const workplaceDir = join(dataDir, 'workplace')
    await writeFile(join(dataDir, 'SOUL.md'), 'old soul', 'utf8')
    await writeFile(join(dataDir, 'AGENTS.md'), 'stable rules', 'utf8')
    const reloadBootstrap = vi.fn(async () => ({}))
    const memoryStatus = vi.fn(async () => ({
      backendKind: 'v3' as const,
      storageKind: 'atom-catalog' as const,
      retrievalSupported: true,
      catalog: {
        integrity: 'ok',
        atomCount: 9,
        embedding: { disabled: 0, pending: 0, ready: 9, stale: 0, failed: 0 },
        activation: { high: 2, medium: 3, low: 4 },
      },
    }))
    const semanticCacheActivationOverview = vi.fn(async () => ({ high: 1, medium: 2, low: 3 }))
    const runner = {
      state: { model: DEFAULT_CONFIG.agents.defaults.model },
      infra: {
        memoryService: { loadBootstrapFiles: reloadBootstrap },
        memoryRepository: { management: { status: memoryStatus } },
        sessionManager: { semanticCacheActivationOverview },
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
      updateRuntimeConfig: vi.fn(async (_next: Config) => undefined),
    })
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`

    const preflight = await fetch(`${origin}/memory/files/SOUL.md`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')

    const list = await fetch(`${origin}/memory/files`)
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      files: expect.arrayContaining([
        expect.objectContaining({ name: 'SOUL.md', editable: true }),
        expect.objectContaining({ name: 'AGENTS.md', editable: false }),
      ]),
      activation: {
        levels: { high: 3, medium: 5, low: 7 },
        sources: {
          durableMemory: { high: 2, medium: 3, low: 4 },
          semanticCache: { high: 1, medium: 2, low: 3 },
        },
        computedAt: expect.any(String),
      },
    })
    expect(memoryStatus).toHaveBeenCalledTimes(1)
    expect(semanticCacheActivationOverview).toHaveBeenCalledTimes(1)

    const denied = await fetch(`${origin}/memory/files/AGENTS.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'changed rules' }),
    })
    expect(denied.status).toBe(403)
    await expect(readFile(join(dataDir, 'AGENTS.md'), 'utf8')).resolves.toBe('stable rules')

    const saved = await fetch(`${origin}/memory/files/SOUL.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new soul' }),
    })
    expect(saved.status).toBe(200)
    await expect(saved.json()).resolves.toMatchObject({ name: 'SOUL.md', content: 'new soul' })
    await expect(readFile(join(dataDir, 'SOUL.md'), 'utf8')).resolves.toBe('new soul')
    expect(reloadBootstrap).toHaveBeenCalledWith(dataDir)
  })
})
