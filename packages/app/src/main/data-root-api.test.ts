import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { ArchiveIndex } from './archive-index.js'
import { DataRootMigrationManager } from './data-root-migration.js'
import { startLocalAppApiServer } from './local-app-api-server.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ls-data-root-api-'))
  process.env.LITTLESHEEP_DATA_LOCATOR = join(root, 'location.json')
  delete process.env.LITTLESHEEP_DATA_DIR
})

afterEach(() => {
  delete process.env.LITTLESHEEP_DATA_LOCATOR
  delete process.env.LITTLESHEEP_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('data-root Local App API', () => {
  it('exposes status, target selection, request, cancellation, and restart scheduling', async () => {
    const sourceDir = join(root, 'source')
    const targetDir = join(root, 'target')
    mkdirSync(sourceDir, { recursive: true })
    const manager = new DataRootMigrationManager({
      branding: { ...DEFAULT_BRANDING, dataDir: sourceDir },
    })
    const restartApplication = vi.fn()
    const runner = { state: { model: DEFAULT_CONFIG.agents.defaults.model } } as unknown as AgentRunner
    const server = await startLocalAppApiServer(runner, {
      port: 0,
      sessionIndex: new SessionIndex({ dataDir: sourceDir, workplaceDir: join(sourceDir, 'workplace') }),
      projectIndex: new ProjectIndex({ dataDir: sourceDir }),
      archiveIndex: new ArchiveIndex({ dataDir: sourceDir, workplaceDir: join(sourceDir, 'workplace') }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir: sourceDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir: sourceDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir: sourceDir }),
      config: structuredClone(DEFAULT_CONFIG),
      dataDir: sourceDir,
      workplaceDir: join(sourceDir, 'workplace'),
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
      dataRootManager: manager,
      selectDataRootTarget: vi.fn(async () => targetDir),
      restartApplication,
    })

    try {
      const base = `http://127.0.0.1:${server.port}`
      const initial = await fetch(`${base}/data-root`)
      await expect(initial.json()).resolves.toMatchObject({ currentDataDir: sourceDir, managed: true })

      const selected = await fetch(`${base}/data-root/select`, { method: 'POST' })
      await expect(selected.json()).resolves.toEqual({ path: targetDir })

      const requested = await fetch(`${base}/data-root/migration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir }),
      })
      expect(requested.status).toBe(200)
      await expect(requested.json()).resolves.toMatchObject({
        requiresRestart: true,
        pendingMigration: { targetDir, phase: 'requested' },
      })

      const cancelled = await fetch(`${base}/data-root/migration`, { method: 'DELETE' })
      await expect(cancelled.json()).resolves.toMatchObject({ requiresRestart: false })

      const restart = await fetch(`${base}/application/restart`, { method: 'POST' })
      expect(restart.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(restartApplication).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })
})
