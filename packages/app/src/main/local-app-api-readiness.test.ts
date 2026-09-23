// Readiness contract for the Local App API listener that starts before the
// Runner exists. The metadata routes must answer; Runner-backed routes must
// fail closed with 503 until the composition root publishes a Runner.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { LOCAL_APP_API_ROUTES } from '../shared/local-app-api-routes.js'
import { startLocalAppApiServer, type LocalAppApiServer } from './local-app-api-server.js'
import { SessionIndex } from './session-index.js'
import { ProjectIndex } from './project-index.js'
import { ArchiveIndex } from './archive-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function createServer(): Promise<{ server: LocalAppApiServer; runner: AgentRunner; base: string; publish: () => AgentRunner }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-readiness-api-'))
  const workplaceDir = join(dataDir, 'workplace')
  // The composition root owns publication: `getRunner()` reports nothing until
  // the Runner exists, exactly like the desktop bootstrap does.
  let published: AgentRunner | undefined
  const runner = {
    state: { model: 'readiness/model' },
    activeRuns: { list: () => [], subscribe: () => () => undefined },
    runCheckpoints: { recoverInterruptedResumes: vi.fn(async () => 0), list: vi.fn(async () => []) },
  } as unknown as AgentRunner
  const server = await startLocalAppApiServer({
    port: 0,
    sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
    projectIndex: new ProjectIndex({ dataDir }),
    archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
    terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
    workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
    workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
    config: structuredClone(DEFAULT_CONFIG) as Config,
    dataDir,
    workplaceDir,
    getRunner: () => published,
    getExecutionReadiness: () => ({
      state: 'starting',
      phase: 'execution',
      reason: '正在准备运行能力',
      apiVersion: 1,
      retryable: false,
      port: server.port,
    }),
    respondReadiness: (requestPath: string) => (
      requestPath === LOCAL_APP_API_ROUTES.readiness
        ? {
            payload: {
              state: 'starting',
              phase: 'execution',
              apiVersion: 1,
              retryable: false,
              port: 0,
            },
          }
        : undefined
    ),
    rebuildRunner: vi.fn(async () => undefined),
    updateRuntimeConfig: vi.fn(async () => undefined),
  })
  cleanup.push(async () => {
    await server.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    server,
    runner,
    base: `http://127.0.0.1:${server.port}`,
    publish: () => {
      published = runner
      return runner
    },
  }
}

describe('Local App API execution readiness', () => {
  it('answers the readiness route before the Runner is published', async () => {
    const { server, base } = await createServer()

    const readiness = await fetch(`${base}${LOCAL_APP_API_ROUTES.readiness}`)
    expect(readiness.status).toBe(200)
    await expect(readiness.json()).resolves.toMatchObject({
      state: 'starting',
      phase: 'execution',
      apiVersion: 1,
      port: server.port,
    })
  })

  it('keeps session metadata readable when the Runner never becomes available', async () => {
    const { server, base, publish } = await createServer()

    // The listener exists before the Runner does, so the sidebar must be able
    // to read this data root even when execution is unavailable.
    const sessions = await fetch(`${base}${LOCAL_APP_API_ROUTES.sessions}`)
    expect(sessions.status).toBe(200)
    await expect(sessions.json()).resolves.toEqual({ sessions: [] })

    const projects = await fetch(`${base}${LOCAL_APP_API_ROUTES.projects}`)
    expect(projects.status).toBe(200)

    const runtime = await fetch(`${base}${LOCAL_APP_API_ROUTES.runtime}`)
    expect(runtime.status).toBe(200)

    await server.setRunner(publish())

    const readySessions = await fetch(`${base}${LOCAL_APP_API_ROUTES.sessions}`)
    expect(readySessions.status).toBe(200)
  })

  it('fails Runner-backed routes closed with 503 until a Runner is published', async () => {
    const { server, base, publish } = await createServer()

    const state = await fetch(`${base}${LOCAL_APP_API_ROUTES.state}`)
    expect(state.status).toBe(503)
    await expect(state.json()).resolves.toMatchObject({
      error: 'The runtime is still starting; execution is not available yet.',
    })

    const run = await fetch(`${base}${LOCAL_APP_API_ROUTES.run}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(run.status).toBe(503)

    const checkpoints = await fetch(`${base}${LOCAL_APP_API_ROUTES.runCheckpoints}`)
    expect(checkpoints.status).toBe(503)

    await server.setRunner(publish())

    const readyState = await fetch(`${base}${LOCAL_APP_API_ROUTES.state}`)
    expect(readyState.status).toBe(200)
  })
})
