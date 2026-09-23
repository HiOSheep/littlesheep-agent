import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { createRunner, type AgentRunner, type CreateRunnerOptions } from '@littlesheep/runner'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  asSessionId,
  RUNTIME_EVENT_VERSION,
  textMessage,
  type ClarificationRequest,
  type RunCheckpoint,
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

type LlmClient = NonNullable<CreateRunnerOptions['llm']>
type ChatRequest = Parameters<LlmClient['chat']>[0]
type ChatResponse = Awaited<ReturnType<LlmClient['chat']>>
type StreamChunk = Parameters<Parameters<LlmClient['chatStream']>[1]>[0]

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' }
}

function queuedLlm(responses: ChatResponse[]): LlmClient {
  const next = (): ChatResponse => {
    const response = responses.shift()
    if (!response) throw new Error('unexpected LLM request')
    return response
  }
  return {
    chat: vi.fn(async (_request: ChatRequest) => next()),
    chatStream: vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const response = next()
      if (response.content) onDelta({ type: 'delta', delta: response.content })
      onDelta({ type: 'done', finishReason: response.finishReason })
      return response
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
}

function waitingApiCheckpoint(input: {
  id: string
  sessionId: ReturnType<typeof asSessionId>
  inboundMessageId: string
  request: ClarificationRequest
  workspace: string
  attachmentCount?: number
}): RunCheckpoint {
  return {
    version: 1,
    id: input.id,
    runId: `${input.id}-source-run`,
    sessionId: input.sessionId,
    status: 'waiting_user',
    currentStage: 'finalize',
    taskBookRevision: 0,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects: [],
    loopBudget: {
      attemptsUsed: 0,
      maxAttempts: 12,
      elapsedMs: 0,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
    resumeState: {
      version: 1,
      inboundMessageId: input.inboundMessageId,
      cwd: input.workspace,
      workspaceContext: { boundaryKind: 'agent_workplace' },
      model: 'test/model',
      origin: 'app',
      permissionPolicyId: 'research',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: [],
      attachmentCount: input.attachmentCount ?? 0,
      continuation: {
        version: 1,
        requestId: input.request.id,
        sourceStage: input.request.sourceStage,
      },
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 0,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: [],
    },
    createdAt: new Date().toISOString(),
    reason: 'waiting for a continuation answer',
  }
}

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
    runnerOverrides: Partial<AgentRunner> = {},
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
      ...runnerOverrides,
    } as unknown as AgentRunner
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
      updateRuntimeConfig: vi.fn(async () => undefined),
    })
    await server.setRunner(runner)
    return { dataDir, workplaceDir, server }
  }

  async function createRealContinuationFixture() {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-stream-control-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const previousDataDir = process.env.LITTLESHEEP_DATA_DIR
    process.env.LITTLESHEEP_DATA_DIR = dataDir
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = workplaceDir
    const llm = queuedLlm([])
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    const session = await runner.sessionManager.create('test/model')
    const original = textMessage('user', 'Translate the original PDF and deliver a PDF.', {
      sessionId: session.id,
    })
    const clarificationRequest: ClarificationRequest = {
      id: 'api-control-request',
      kind: 'recovery_decision',
      sourceStage: 'recover',
      createdAt: new Date().toISOString(),
      originalRequest: 'Translate the original PDF and deliver a PDF.',
      blockingReason: 'A resource or permission was unavailable.',
      questions: [{
        id: 'question-1',
        field: 'resource',
        prompt: 'Provide the missing resource, then ask me to retry.',
        required: true,
      }],
    }
    await runner.sessionManager.append(session.id, [
      original,
      textMessage('assistant', clarificationRequest.questions[0]!.prompt, {
        sessionId: session.id,
        clarificationRequest,
      }),
    ])
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
      updateRuntimeConfig: vi.fn(async () => undefined),
    })
    await server.setRunner(runner)
    return {
      dataDir,
      workplaceDir,
      llm,
      original,
      clarificationRequest,
      runner,
      server,
      session,
      async cleanup() {
        await server.stop()
        await runner.shutdown()
        if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR
        else process.env.LITTLESHEEP_DATA_DIR = previousDataDir
        rmSync(dataDir, { recursive: true, force: true })
      },
    }
  }

  it('preserves the SSE start, activity, delta and result contract', async () => {
    const sessionId = asSessionId('stream-session')
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0], onDelta: (delta: string) => void) => {
      input.onToolEvent?.({
        type: 'reasoning',
        phaseId: 'classify:2',
        stage: 'classify',
        reasoningStatus: 'running',
        summary: '正在判断本轮处理路径',
      })
      input.onToolEvent?.({
        type: 'step_start',
        stepId: 'step-1',
        title: '执行步骤',
      })
      onDelta('完成')
      input.onAssistantReplace?.('done!')
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
        body: JSON.stringify({
          text: '执行测试',
          sessionId,
          requestKey: 'conversation-turn-1',
          permissionMode: 'full',
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const body = await response.text()
      expect(body).toContain('event: start')
      expect(body.indexOf('event: start')).toBeLessThan(body.indexOf('event: reasoning'))
      expect(body.indexOf('event: reasoning')).toBeLessThan(body.indexOf('event: step_start'))
      expect(body).toContain('event: reasoning')
      expect(body).toContain('"phaseId":"classify:2"')
      expect(body).toContain('event: step_start')
      expect(body).toContain('event: delta')
      expect(body).toContain('"delta":"完成"')
      expect(body).toContain('event: replace')
      expect(body).toContain('"text":"done!"')
      expect(body).toContain('event: result')
      expect(body).toMatch(/event: start\ndata: \{"ok":true,"runId":"[^"]+"\}/)
      expect(runStream).toHaveBeenCalledOnce()
      expect(runStream).toHaveBeenCalledWith(expect.objectContaining({
        sessionId,
        requestKey: 'conversation-turn-1',
        permissionPolicyId: 'full',
        restoreCheckpointResources: expect.any(Function),
      }), expect.any(Function))
      expect(await new SessionIndex({ dataDir, workplaceDir }).list()).toEqual([
        expect.objectContaining({ id: sessionId, scope: 'standalone', workspacePath: workplaceDir }),
      ])
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('publishes the durable settled reply instead of the provisional stream result in next mode', async () => {
    const sessionId = asSessionId('next-settled-session')
    const runStream = vi.fn(async (
      input: Parameters<AgentRunner['runStream']>[0],
      onDelta: (delta: string) => void,
    ) => {
      onDelta('provisional model text')
      return {
        runId: input.runId!,
        sessionId,
        status: 'ok' as const,
        reply: 'temporary result text',
        messages: [],
        trace: [],
        durationMs: 1,
      }
    })
    const replayDurableFinalReply = vi.fn(async (_session: ReturnType<typeof asSessionId>, runId: string) => ({
      kind: 'settled' as const,
      sessionId: String(sessionId),
      runId,
      cursor: 8,
      settlementId: 'durable-settlement-1',
      reply: 'durable settled text',
      replyFingerprint: 'durable-fingerprint-1',
      modelRequestId: 'durable-model-request-1',
    }))
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const { dataDir, server } = await createFixture(runStream, runtimeEvents, {
      durableHarnessMode: 'next',
      replayDurableFinalReply,
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'next settled', sessionId, requestKey: 'next-settled-turn' }),
      })
      const body = await response.text()
      const resultFrame = body.split('event: result\n')[1] ?? ''

      expect(response.status).toBe(200)
      expect(replayDurableFinalReply).toHaveBeenCalledWith(sessionId, expect.any(String))
      expect(resultFrame).toContain('"reply":"durable settled text"')
      expect(resultFrame).toContain('"status":"ok"')
      expect(resultFrame).not.toContain('"reply":"temporary result text"')
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('clears provisional stream text and returns Runtime status when next replay is not settled', async () => {
    const sessionId = asSessionId('next-unavailable-session')
    const runStream = vi.fn(async (
      input: Parameters<AgentRunner['runStream']>[0],
      onDelta: (delta: string) => void,
    ) => {
      onDelta('unconfirmed stream text')
      return {
        runId: input.runId!,
        sessionId,
        status: 'ok' as const,
        reply: 'unconfirmed result text',
        messages: [],
        trace: [],
        durationMs: 1,
      }
    })
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const { dataDir, server } = await createFixture(runStream, runtimeEvents, {
      durableHarnessMode: 'next',
      replayDurableFinalReply: vi.fn(async (_session, runId) => ({
        kind: 'unavailable' as const,
        sessionId: String(sessionId),
        runId,
        cursor: 3,
        status: 'completed' as const,
        reason: 'not_settled' as const,
      })),
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'next unavailable', sessionId, requestKey: 'next-unavailable-turn' }),
      })
      const body = await response.text()
      const resultFrame = body.split('event: result\n')[1] ?? ''

      expect(response.status).toBe(200)
      expect(body).toContain('event: replace')
      expect(body).toContain('event: replace\ndata: {"text":""}')
      expect(resultFrame).toContain('"status":"error"')
      expect(resultFrame).toContain('"reply":""')
      expect(resultFrame).toContain('"runtimeStatus"')
      expect(resultFrame).not.toContain('"reply":"unconfirmed result text"')
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('uses the persisted session permission mode when the stream request omits it', async () => {
    const sessionId = asSessionId('persisted-permission-session')
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0]) => ({
      runId: input.runId!,
      sessionId,
      status: 'ok' as const,
      reply: '已完成',
      messages: [],
      trace: [],
      durationMs: 1,
    }))
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const { dataDir, workplaceDir, server } = await createFixture(runStream, runtimeEvents)
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    await sessionIndex.upsert(String(sessionId), {
      title: '权限同步回归',
      createdAt: 1,
      lastMessageAt: 1,
      mode: 'full',
      scope: 'standalone',
      workspacePath: workplaceDir,
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: '执行权限同步回归',
          sessionId,
          requestKey: 'persisted-permission-turn',
        }),
      })

      expect(response.status).toBe(200)
      await response.text()
      expect(runStream).toHaveBeenCalledWith(expect.objectContaining({
        sessionId,
        permissionPolicyId: 'full',
      }), expect.any(Function))
      expect(await sessionIndex.list()).toEqual([
        expect.objectContaining({ id: sessionId, mode: 'full' }),
      ])
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('uses the real Runner coordinator to bind an ordinary stream turn to the waiting task', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-stream-continuation-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const previousDataDir = process.env.LITTLESHEEP_DATA_DIR
    process.env.LITTLESHEEP_DATA_DIR = dataDir
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = workplaceDir
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: queuedLlm([
        textResponse('{"kind":"retry","reason":"permission changed"}'),
        textResponse('{"plan":[{"description":"continue the original PDF task","tools":[]}]}'),
        textResponse('Original PDF work continued.'),
        textResponse('The original PDF task is complete.'),
        textResponse('{"verdict":"pass","reason":"original goal completed"}'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ]),
      skillsDirs: [],
      containerRoot: dataDir,
    })
    let server: Awaited<ReturnType<typeof startLocalAppApiServer>> | undefined
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Translate the PDF and deliver a PDF.', { sessionId: session.id })
      const clarificationRequest = {
        id: 'api-pdf-request',
        kind: 'recovery_decision' as const,
        sourceStage: 'classify' as const,
        createdAt: new Date().toISOString(),
        originalRequest: 'Translate the PDF and deliver a PDF.',
        blockingReason: 'Permission was unavailable.',
        questions: [{
          id: 'question-1',
          field: 'permission',
          prompt: 'Enable permission, then ask me to retry.',
          required: true,
        }],
      }
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', clarificationRequest.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest,
        }),
      ])
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'api-waiting-checkpoint',
        runId: 'api-source-run',
        sessionId: session.id,
        status: 'waiting_user',
        currentStage: 'finalize',
        taskBookRevision: 0,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [],
        sideEffects: [],
        loopBudget: {
          attemptsUsed: 0,
          maxAttempts: 12,
          elapsedMs: 0,
          maxElapsedMs: 60_000,
          noProgressRounds: 0,
          maxNoProgressRounds: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: original.id,
          cwd: workplaceDir,
          workspaceContext: { boundaryKind: 'agent_workplace' },
          model: 'test/model',
          origin: 'app',
          permissionPolicyId: 'restricted',
          reasoning: 'auto',
          behaviorModeId: 'general',
          availableToolNames: [],
          attachmentCount: 0,
          continuation: {
            version: 1,
            requestId: clarificationRequest.id,
            sourceStage: clarificationRequest.sourceStage,
          },
          appliedTaskBookPatchIds: [],
          deferredRuntimeEvents: [],
          recoveryAttempts: 0,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
        },
        createdAt: new Date().toISOString(),
        reason: 'waiting for permission',
      }
      await runner.infra.runCheckpointStore!.write(checkpoint)
      server = await startLocalAppApiServer({
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
        updateRuntimeConfig: vi.fn(async () => undefined),
      })
      await server.setRunner(runner)

      const requestBody = JSON.stringify({
        text: 'Permission is enabled. Try the original task again.',
        sessionId: session.id,
        requestKey: 'api-continuation-turn',
        permissionMode: 'full',
      })
      const [response, retriedResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        }),
        fetch(`http://127.0.0.1:${server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
        }),
      ])
      const [stream, retriedStream] = await Promise.all([response.text(), retriedResponse.text()])

      expect(response.status).toBe(200)
      expect(retriedResponse.status).toBe(200)
      expect(stream).toContain('event: result')
      expect(retriedStream).toContain('event: result')
      const runId = stream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]
      const retriedRunId = retriedStream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]
      expect(runId).toMatch(/^conversation-run-[a-f0-9]{64}$/u)
      expect(retriedRunId).toBe(runId)
      expect(stream).toContain('"resolution":"bound"')
      expect(stream).toContain('"checkpointId":"api-waiting-checkpoint"')
      expect(stream).not.toContain('multiple waiting tasks')
      const messages = await runner.sessionManager.read(session.id)
      expect(messages.filter((message) => message.clarificationResponse?.requestId === clarificationRequest.id))
        .toHaveLength(1)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        requestKey: 'api-continuation-turn',
        continuationDisposition: 'retry',
      })
    } finally {
      await server?.stop()
      await runner.shutdown()
      if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR
      else process.env.LITTLESHEEP_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('streams a structured failure when an ordinary turn sees multiple waiting heads', async () => {
    const fixture = await createRealContinuationFixture()
    const requestKey = 'api-multiple-head-turn'
    try {
      for (const id of ['api-multiple-head-a', 'api-multiple-head-b']) {
        await fixture.runner.infra.runCheckpointStore!.write(waitingApiCheckpoint({
          id,
          sessionId: fixture.session.id,
          inboundMessageId: fixture.original.id,
          request: fixture.clarificationRequest,
          workspace: fixture.workplaceDir,
        }))
      }

      const response = await fetch(`http://127.0.0.1:${fixture.server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Continue the original PDF task.',
          sessionId: fixture.session.id,
          requestKey,
          permissionMode: 'full',
        }),
      })
      const stream = await response.text()
      const runId = stream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]

      expect(response.status).toBe(200)
      expect(runId).toMatch(/^conversation-run-[a-f0-9]{64}$/u)
      expect(stream).toContain('event: error')
      expect(stream).toContain('multiple waiting tasks require explicit selection')
      expect(stream).not.toContain('event: result')
      expect(fixture.llm.chat).not.toHaveBeenCalled()
      expect(fixture.llm.chatStream).not.toHaveBeenCalled()
      await expect(fixture.runner.replay(runId!)).resolves.toMatchObject({
        status: 'error',
        conversationContinuation: {
          resolution: 'conflict',
          candidateCheckpointIds: ['api-multiple-head-a', 'api-multiple-head-b'],
          failure: { code: 'multiple_waiting_heads', recoverable: true },
        },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('streams a recoverable resource failure for a legacy attachment checkpoint', async () => {
    const fixture = await createRealContinuationFixture()
    const requestKey = 'api-legacy-attachment-turn'
    const checkpoint = waitingApiCheckpoint({
      id: 'api-legacy-attachment-checkpoint',
      sessionId: fixture.session.id,
      inboundMessageId: fixture.original.id,
      request: fixture.clarificationRequest,
      workspace: fixture.workplaceDir,
      attachmentCount: 1,
    })
    try {
      await fixture.runner.infra.runCheckpointStore!.write(checkpoint)
      await expect(fixture.runner.runCheckpoints!.resolveWaitingUserHead(fixture.session.id)).resolves.toMatchObject({
        kind: 'blocked',
        checkpointId: checkpoint.id,
        reasons: expect.arrayContaining([expect.stringContaining('reattach the missing resources')]),
      })
      const response = await fetch(`http://127.0.0.1:${fixture.server.port}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'Try the original PDF task again.',
          sessionId: fixture.session.id,
          requestKey,
          permissionMode: 'full',
        }),
      })
      const stream = await response.text()
      const runId = stream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]

      expect(response.status).toBe(200)
      expect(stream).toContain('event: error')
      expect(stream).toContain('reattach the missing resources')
      expect(stream).not.toContain('event: result')
      expect(fixture.llm.chat).not.toHaveBeenCalled()
      expect(fixture.llm.chatStream).not.toHaveBeenCalled()
      expect(await fixture.runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
      await expect(fixture.runner.replay(runId!)).resolves.toMatchObject({
        status: 'error',
        conversationContinuation: {
          resolution: 'blocked',
          checkpointId: checkpoint.id,
          resources: { status: 'failed', attachmentCount: 1 },
          failure: { code: 'resource_restore_failed', recoverable: true },
        },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('accepts active control and task events, waits for queue registration, and preserves app source', async () => {
    const sessionId = asSessionId('control-session')
    const runtimeEvents = makeRuntimeEvents(sessionId)
    const firstAppend = runtimeEvents.append
    firstAppend
      .mockImplementationOnce((runId) => ({
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

  it('keeps a Main-owned run alive when the observing SSE client disconnects', async () => {
    const sessionId = asSessionId('detached-stream-session')
    const runtimeEvents = makeRuntimeEvents(sessionId)
    let releaseRun!: () => void
    let receivedSignal: AbortSignal | undefined
    const runGate = new Promise<void>((resolve) => { releaseRun = resolve })
    const runStream = vi.fn(async (input: Parameters<AgentRunner['runStream']>[0]) => {
      receivedSignal = input.signal
      await runGate
      return {
        runId: input.runId!,
        sessionId,
        status: 'ok' as const,
        reply: '后台完成',
        messages: [],
        trace: [],
        durationMs: 4,
      }
    })
    const { dataDir, server } = await createFixture(runStream, runtimeEvents)
    const base = `http://127.0.0.1:${server.port}`
    const controller = new AbortController()

    try {
      const response = await fetch(`${base}${LOCAL_APP_API_ROUTES.runStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '断开观察连接后继续运行' }),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      const runId = runStream.mock.calls[0]?.[0].runId
      expect(runId).toEqual(expect.any(String))

      controller.abort()
      await waitFor(() => receivedSignal !== undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(receivedSignal?.aborted).toBe(false)

      const eventPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, String(runId), '/events')
      const stillActive = await fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'setting_changed', payload: { key: 'reasoning', value: 'high' } }),
      })
      expect(stillActive.status).toBe(202)

      releaseRun()
      await waitFor(async () => {
        const after = await fetch(`${base}${eventPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'resume_requested' }),
        })
        return after.status === 404
      })
      expect(receivedSignal?.aborted).toBe(false)
    } finally {
      releaseRun()
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for run stream state')
}
