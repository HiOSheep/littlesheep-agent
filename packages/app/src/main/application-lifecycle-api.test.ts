import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import {
  asSessionId,
  type RuntimeActiveRunAction,
  type RuntimeActiveRunActionOutcome,
  type RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../shared/local-app-api-routes.js'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'

function activeRun(): RuntimeActiveRunSnapshot {
  return {
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    origin: 'app',
    startedAt: '2026-07-29T01:00:00.000Z',
    updatedAt: '2026-07-29T01:00:01.000Z',
    phase: 'executing',
    controlStatus: 'running',
    totalSteps: 2,
    completedSteps: 1,
    activeSteps: [{ stepId: 'step-2', title: 'Verify' }],
    activeToolCount: 1,
  }
}

describe('application lifecycle Local App API', () => {
  it('lists bounded runtime state and validates pause, resume, and interrupt controls', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-application-lifecycle-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    const snapshot = activeRun()
    let activeRunListener: ((runs: RuntimeActiveRunSnapshot[]) => void) | null = null
    const releaseActiveRunListener = vi.fn()
    const controlActiveRun = vi.fn((
      runId: string,
      action: RuntimeActiveRunAction,
    ): RuntimeActiveRunActionOutcome => {
      if (runId === 'missing') {
        return { kind: 'rejected', action, reason: 'run-not-active', message: 'missing' }
      }
      if (action === 'resume') {
        return { kind: 'rejected', action, reason: 'queue-rejected', message: 'not paused' }
      }
      return {
        kind: 'accepted',
        action,
        run: {
          ...snapshot,
          controlStatus: action === 'interrupt' ? 'interrupt_requested' : 'pause_requested',
        },
      }
    })
    const runner = {
      state: { model: config.agents.defaults.model },
      runtimeEvents: {
        append: vi.fn(() => ({ kind: 'rejected', reason: 'run-not-active', message: 'inactive' })),
        summary: vi.fn(() => null),
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
      config,
      dataDir,
      workplaceDir,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
      listActiveRuns: () => [snapshot],
      subscribeActiveRuns: (listener) => {
        activeRunListener = listener
        listener([snapshot])
        return releaseActiveRunListener
      },
      controlActiveRun,
    })
    const base = `http://127.0.0.1:${server.port}`

    try {
      const list = await fetch(`${base}${LOCAL_APP_API_ROUTES.activeRuns}`)
      expect(list.status).toBe(200)
      await expect(list.json()).resolves.toMatchObject({
        runs: [{ runId: 'run-1', phase: 'executing', activeToolCount: 1 }],
      })

      const streamController = new AbortController()
      const stream = await fetch(`${base}${LOCAL_APP_API_ROUTES.activeRunsStream}`, {
        signal: streamController.signal,
      })
      expect(stream.status).toBe(200)
      const reader = stream.body!.getReader()
      const firstFrame = await reader.read()
      expect(new TextDecoder().decode(firstFrame.value)).toContain('event: active_runs')
      expect(activeRunListener).not.toBeNull()
      streamController.abort()
      await reader.read().catch(() => undefined)
      await vi.waitFor(() => expect(releaseActiveRunListener).toHaveBeenCalledOnce())

      const controlPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.activeRuns, 'run-1', '/control')
      const pause = await fetch(`${base}${controlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pause', reason: 'user requested pause' }),
      })
      expect(pause.status).toBe(202)
      await expect(pause.json()).resolves.toMatchObject({
        outcome: { kind: 'accepted', action: 'pause', run: { controlStatus: 'pause_requested' } },
      })
      expect(controlActiveRun).toHaveBeenCalledWith('run-1', 'pause', 'user requested pause')

      const resume = await fetch(`${base}${controlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      })
      expect(resume.status).toBe(409)
      await expect(resume.json()).resolves.toMatchObject({
        outcome: { kind: 'rejected', reason: 'queue-rejected' },
      })

      const missingPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.activeRuns, 'missing', '/control')
      const missing = await fetch(`${base}${missingPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'interrupt' }),
      })
      expect(missing.status).toBe(404)

      for (const body of [{ action: 'restart' }, { action: 'pause', reason: 42 }]) {
        const invalid = await fetch(`${base}${controlPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(invalid.status).toBe(400)
      }
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
