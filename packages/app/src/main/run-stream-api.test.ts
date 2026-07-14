import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'
import { LOCAL_APP_API_ROUTES } from '../shared/local-app-api-routes.js'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'

describe('run stream Local App API', () => {
  it('preserves the SSE start, activity, delta and result contract', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-stream-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = workplaceDir
    const sessionId = asSessionId('stream-session')
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0], onDelta: (delta: string) => void) => {
      input.onToolEvent?.({
        type: 'step_start',
        stepId: 'step-1',
        title: '执行步骤',
      })
      onDelta('完成')
      return {
        runId: 'stream-run',
        sessionId,
        status: 'ok' as const,
        reply: '完成',
        messages: [],
        trace: [],
        durationMs: 4,
      }
    })
    const runner = {
      state: { model: config.agents.defaults.model },
      runStream,
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
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '执行测试' }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const body = await response.text()
      expect(body).toContain('event: start')
      expect(body).toContain('event: step_start')
      expect(body).toContain('event: delta')
      expect(body).toContain('"delta":"完成"')
      expect(body).toContain('event: result')
      expect(body).toContain('"runId":"stream-run"')
      expect(runStream).toHaveBeenCalledOnce()
      expect(await new SessionIndex({ dataDir, workplaceDir }).list()).toEqual([
        expect.objectContaining({ id: sessionId, scope: 'standalone', workspacePath: workplaceDir }),
      ])
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
