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
    const server = await startLocalAppApiServer({
    getRunner: () => runner,
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
    await server.setRunner(runner)

    try {
      const initial = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      expect(initial.status).toBe(200)
      await expect(initial.json()).resolves.toMatchObject({
        contextCompressionThresholdRatio: 0.8,
        closePolicy: 'background-while-active',
      })

      const changed = await fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextCompressionThresholdRatio: 0.9 }),
      })
      expect(changed.status).toBe(200)
      await expect(changed.json()).resolves.toMatchObject({ contextCompressionThresholdRatio: 0.9 })
      expect(updates.at(-1)?.agents.defaults.contextCompressionThresholdRatio).toBe(0.9)

      const closePolicy = await fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closePolicy: 'always-background' }),
      })
      expect(closePolicy.status).toBe(200)
      await expect(closePolicy.json()).resolves.toMatchObject({ closePolicy: 'always-background' })
      expect(updates.at(-1)?.desktop.closePolicy).toBe('always-background')

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
      const invalidClosePolicy = await fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closePolicy: 'coding' }),
      })
      expect(invalidClosePolicy.status).toBe(400)
      // Two accepted patches: the compression ratio and the close policy. The
      // durable-harness mode patches are gone with the single-driver collapse.
      expect(updates).toHaveLength(2)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent runtime patches against the latest persisted config', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-runtime-config-concurrent-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    const config = structuredClone(DEFAULT_CONFIG)
    const updates: Config[] = []
    let releaseFirst!: () => void
    let signalFirstStarted!: () => void
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve })
    const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
    const server = await startLocalAppApiServer({
    getRunner: () => runner,
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
        if (updates.length === 1) {
          signalFirstStarted()
          await firstRelease
        }
      }),
    })
    await server.setRunner(runner)

    try {
      const firstRequest = fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextCompressionThresholdRatio: 0.9 }),
      })
      await firstStarted
      const secondRequest = fetch(`http://127.0.0.1:${server.port}/runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ closePolicy: 'always-background' }),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseFirst()
      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest])
      expect(firstResponse.status).toBe(200)
      expect(secondResponse.status).toBe(200)
      await firstResponse.json()
      await secondResponse.json()

      const after = await fetch(`http://127.0.0.1:${server.port}/runtime`)
      await expect(after.json()).resolves.toMatchObject({
        contextCompressionThresholdRatio: 0.9,
        closePolicy: 'always-background',
      })
      expect(updates).toHaveLength(2)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
