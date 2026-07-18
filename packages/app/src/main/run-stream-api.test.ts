import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import {
  asSessionId,
  RUNTIME_EVENT_VERSION,
  type RuntimeEventAppendInput,
  type RuntimeEventIngressOutcome,
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

describe('run stream Local App API', () => {
  function makeRuntimeEvents(sessionId: ReturnType<typeof asSessionId>) {
    const append = vi.fn((runId: string, input: Omit<RuntimeEventAppendInput, 'runId'>): RuntimeEventIngressOutcome => ({
      kind: 'accepted',
      event: {
        version: RUNTIME_EVENT_VERSION,
        id: 'event-1',
        runId,
        sessionId,
        sequence: 1,
        type: input.type,
        source: input.source,
        status: 'queued',
        receivedAt: input.receivedAt ?? '2026-07-18T10:00:00.000Z',
        payload: input.payload,
        ...(input.dedupKey ? { dedupKey: input.dedupKey } : {}),
      },
    }))
    return {
      append,
      summary: vi.fn(() => null),
    }
  }

  async function createFixture(
    runStream: AgentRunner['runStream'],
    runtimeEvents: ReturnType<typeof makeRuntimeEvents>,
  ) {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-stream-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = workplaceDir
    const runner = {
      state: { model: config.agents.defaults.model },
      runStream,
      runtimeEvents,
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
    return { dataDir, workplaceDir, server }
  }

  it('preserves the SSE start, activity, delta and result contract', async () => {
    const sessionId = asSessionId('stream-session')
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0], onDelta: (delta: string) => void) => {
      input.onToolEvent?.({
        type: 'step_start',
        stepId: 'step-1',
        title: '执行步骤',
      })
      onDelta('完成')
      return {
        runId: input.runId!,
        sessionId,
        status: 'ok' as const,
        reply: '完成',
        messages: [],
        trace: [],
        durationMs: 4,
      }
    })
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const { dataDir, workplaceDir, server } = await createFixture(runStream, runtimeEvents)

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
      expect(body.indexOf('event: start')).toBeLessThan(body.indexOf('event: step_start'))
      expect(body).toContain('event: step_start')
      expect(body).toContain('event: delta')
      expect(body).toContain('"delta":"完成"')
      expect(body).toContain('event: result')
      expect(body).toMatch(/event: start\ndata: \{"ok":true,"runId":"[^"]+"\}/)
      expect(runStream).toHaveBeenCalledOnce()
      expect(await new SessionIndex({ dataDir, workplaceDir }).list()).toEqual([
        expect.objectContaining({ id: sessionId, scope: 'standalone', workspacePath: workplaceDir }),
      ])
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('accepts active control and task events, waits for queue registration, and preserves app source', async () => {
    const sessionId = asSessionId('control-session')
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const firstAppend = runtimeEvents.append
    firstAppend
      .mockImplementationOnce((runId, input) => ({
        kind: 'rejected',
        reason: 'run-not-active',
        message: `queue not registered yet: ${runId}`,
      }))
    let releaseRun!: () => void
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0]) => {
      await runGate
      return {
        runId: input.runId!,
        sessionId,
        status: 'aborted' as const,
        reply: '',
        error: 'interrupted at safe boundary',
        messages: [],
        trace: [],
        durationMs: 4,
      }
    })
    const { dataDir, server } = await createFixture(runStream, runtimeEvents)
    const base = `http://127.0.0.1:${server.port}`

    try {
      const streamResponse = await fetch(`${base}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '等待控制事件' }),
      })
      expect(streamResponse.status).toBe(200)
      const runId = runStream.mock.calls[0]?.[0].runId
      expect(runId).toEqual(expect.any(String))
      const eventPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, String(runId), '/events')

      const invalid = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'unsupported_event' }),
      })
      expect(invalid.status).toBe(400)
      expect(runtimeEvents.append).toHaveBeenCalledTimes(0)

      const malformed = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'null',
      })
      expect(malformed.status).toBe(400)

      const invalidTask = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user_message' }),
      })
      expect(invalidTask.status).toBe(400)
      expect(runtimeEvents.append).toHaveBeenCalledTimes(0)

      const unknown = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, 'missing-run', '/events')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'interrupt_requested' }),
      })
      expect(unknown.status).toBe(404)

      const control = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'interrupt_requested', reason: '用户停止' }),
      })
      expect(control.status).toBe(202)
      expect(runtimeEvents.append).toHaveBeenCalledTimes(2)
      expect(runtimeEvents.append).toHaveBeenLastCalledWith(String(runId), expect.objectContaining({
        type: 'interrupt_requested',
        source: 'app',
        payload: { reason: '用户停止' },
      }))
      expect(runtimeEvents.summary).toHaveBeenCalledWith(String(runId))

      const task = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'user_message',
          text: '请在交付前补充验证结果',
          taskBookPatch: { id: 'patch-1', operations: [] },
          dedupKey: 'user-update-1',
        }),
      })
      expect(task.status).toBe(202)
      expect(runtimeEvents.append).toHaveBeenCalledTimes(3)
      expect(runtimeEvents.append).toHaveBeenLastCalledWith(String(runId), expect.objectContaining({
        type: 'user_message',
        source: 'app',
        dedupKey: 'user-update-1',
        payload: {
          text: '请在交付前补充验证结果',
          taskBookPatch: { id: 'patch-1', operations: [] },
        },
      }))

      const setting = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'setting_changed',
          payload: { key: 'reasoning', value: 'high' },
        }),
      })
      expect(setting.status).toBe(202)
      expect(runtimeEvents.append).toHaveBeenCalledWith(String(runId), expect.objectContaining({
        type: 'setting_changed',
        source: 'app',
        payload: { key: 'reasoning', value: 'high' },
      }))

      releaseRun()
      const streamBody = await streamResponse.text()
      expect(streamBody).toContain('event: start')
      expect(streamBody).toContain('event: result')
      expect(streamBody).toContain('"status":"aborted"')
      expect(streamBody).toContain(`"runId":"${runId}"`)

      const after = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'resume_requested' }),
      })
      expect(after.status).toBe(404)
    } finally {
      releaseRun()
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
