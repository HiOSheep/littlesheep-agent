import { mkdtempSync, rmSync } from 'node:fs'
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

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.()
})

describe('desktop Electron acceptance Local App API', () => {
  it('is absent without an acceptance controller', async () => {
    const fixture = await createFixture()
    const response = await fetch(`${fixture.baseUrl}/application/acceptance`, {
      headers: { Authorization: 'Bearer acceptance-token' },
    })
    expect(response.status).toBe(404)
  })

  it('requires the startup token and exposes bounded lifecycle actions', async () => {
    const snapshot = {
      windowExists: true,
      windowVisible: true,
      windowMinimized: false,
      trayAvailable: true,
      closePolicy: 'always-background' as const,
      activeRunCount: 1,
      sampledAt: '2026-08-03T06:30:00.000Z',
      process: {
        rssBytes: 100,
        heapUsedBytes: 40,
        externalBytes: 10,
        arrayBuffersBytes: 5,
        activeHandleCount: 6,
        activeRequestCount: 1,
      },
      electron: {
        processCount: 3,
        workingSetBytes: 300,
        peakWorkingSetBytes: 360,
        privateBytes: 240,
      },
      runtime: {
        currentRunnerActiveRunCount: 1,
        aggregatedActiveRunCount: 1,
        retiredRunnerCount: 0,
        activitySourceCount: 1,
        activityListenerCount: 1,
      },
    }
    const close = vi.fn(() => {
      snapshot.windowVisible = false
      return true
    })
    const show = vi.fn(() => { snapshot.windowVisible = true })
    const quit = vi.fn()
    const fixture = await createFixture({
      desktopAcceptance: {
        token: 'acceptance-token',
        snapshot: () => ({ ...snapshot }),
        close,
        show,
        quit,
      },
    })

    expect((await fetch(`${fixture.baseUrl}/application/acceptance`)).status).toBe(401)
    const headers = {
      Authorization: 'Bearer acceptance-token',
      'Content-Type': 'application/json',
    }
    const initial = await fetch(`${fixture.baseUrl}/application/acceptance`, { headers })
    await expect(initial.json()).resolves.toMatchObject({
      snapshot: {
        windowVisible: true,
        process: { rssBytes: 100, heapUsedBytes: 40, activeHandleCount: 6, activeRequestCount: 1 },
        electron: { processCount: 3, workingSetBytes: 300 },
        runtime: { currentRunnerActiveRunCount: 1, activityListenerCount: 1 },
      },
    })

    const closed = await fetch(`${fixture.baseUrl}/application/acceptance`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'close' }),
    })
    await expect(closed.json()).resolves.toMatchObject({ accepted: true, snapshot: { windowVisible: false } })
    expect(close).toHaveBeenCalledTimes(1)

    const shown = await fetch(`${fixture.baseUrl}/application/acceptance`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'show' }),
    })
    await expect(shown.json()).resolves.toMatchObject({ accepted: true, snapshot: { windowVisible: true } })
    expect(show).toHaveBeenCalledTimes(1)

    const quitting = await fetch(`${fixture.baseUrl}/application/acceptance`, {
      method: 'POST', headers, body: JSON.stringify({ action: 'quit' }),
    })
    expect(quitting.status).toBe(202)
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
  })
})

async function createFixture(
  overrides: Partial<Parameters<typeof startLocalAppApiServer>[1]> = {},
): Promise<{ baseUrl: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-desktop-acceptance-api-'))
  const workplaceDir = join(dataDir, 'workplace')
  const runner = {
    model: 'acceptance/model',
    state: { model: 'model' },
    infra: { memoryService: { rebindProjectPath: vi.fn() } },
    runCheckpoints: { recoverInterruptedResumes: vi.fn(async () => 0) },
  } as unknown as AgentRunner
  const server: LocalAppApiServer = await startLocalAppApiServer(runner, {
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
    ...overrides,
  })
  cleanup.push(async () => {
    await server.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { baseUrl: `http://127.0.0.1:${server.port}` }
}
