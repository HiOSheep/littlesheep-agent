import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { createRunner, type AgentRunner, type CreateRunnerOptions, type RunCheckpointInspection } from '@littlesheep/runner'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  asSessionId,
  textMessage,
  type RunCheckpoint,
  type RunCheckpointDisposition,
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

function checkpointInspection(
  dataDir: string,
  resumeStateOverrides: Partial<NonNullable<RunCheckpoint['resumeState']>> = {},
): RunCheckpointInspection {
  const checkpoint: RunCheckpoint = {
    version: 1,
    id: 'checkpoint-1',
    runId: 'source-run-1',
    sessionId: asSessionId('checkpoint-session'),
    status: 'recoverable',
    currentStage: 'execute',
    currentStepId: 'step-1',
    taskBookRevision: 1,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects: [],
    loopBudget: {
      attemptsUsed: 1,
      maxAttempts: 8,
      elapsedMs: 500,
      maxElapsedMs: 60_000,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
    resumeState: {
      version: 1,
      inboundMessageId: 'inbound-1',
      cwd: join(dataDir, 'workplace'),
      model: 'openai/gpt-4o-mini',
      origin: 'app',
      permissionPolicyId: 'research',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: [],
      attachmentCount: 0,
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 0,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: [],
      workspaceContext: { boundaryKind: 'agent_workplace' },
      ...resumeStateOverrides,
    },
    createdAt: '2026-07-29T10:00:00.000Z',
    reason: 'application closed during execution',
  }
  return { checkpoint, disposition: null, resumable: true, reasons: [] }
}

function abandonedDisposition(): RunCheckpointDisposition {
  const at = '2026-07-29T10:10:00.000Z'
  return {
    version: 1,
    checkpointId: 'checkpoint-1',
    status: 'abandoned',
    decidedAt: at,
    updatedAt: at,
    reason: 'user abandoned',
    history: [{ status: 'abandoned', at, reason: 'user abandoned' }],
  }
}

async function createFixture(
  resumeImplementation?: NonNullable<AgentRunner['resumeCheckpoint']>,
  resumeStateOverrides: Partial<NonNullable<RunCheckpoint['resumeState']>> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-checkpoint-api-'))
  const workplaceDir = join(dataDir, 'workplace')
  mkdirSync(workplaceDir, { recursive: true })
  const config = structuredClone(DEFAULT_CONFIG)
  config.agents.defaults.workspace = workplaceDir
  const inspection = checkpointInspection(dataDir, resumeStateOverrides)
  const reconcileCompletedRuns = vi.fn(async () => 1)
  const recoverInterruptedResumes = vi.fn(async () => 1)
  const abandon = vi.fn(async () => ({
    kind: 'written' as const,
    disposition: abandonedDisposition(),
  }))
  const defaultResume: NonNullable<AgentRunner['resumeCheckpoint']> = async (_id, options = {}) => {
    options.onToolEvent?.({ type: 'verification_start' })
    options.onAssistantDelta?.('继续完成')
    return {
      runId: options.runId!,
      sessionId: inspection.checkpoint.sessionId,
      status: 'ok',
      reply: '继续完成',
      messages: [],
      trace: [],
      durationMs: 5,
    }
  }
  const resumeCheckpoint = vi.fn<NonNullable<AgentRunner['resumeCheckpoint']>>(
    resumeImplementation ?? defaultResume,
  )
  const runner = {
    state: { model: config.agents.defaults.model },
    runStream: vi.fn(),
    resumeCheckpoint,
    runCheckpoints: {
      list: vi.fn(async () => [inspection]),
      inspect: vi.fn(async (id: string) => id === inspection.checkpoint.id ? inspection : null),
      abandon,
      reconcileCompletedRuns,
      recoverInterruptedResumes,
      diagnostics: () => ({
        rootDir: join(dataDir, 'run-checkpoints'),
        scannedFiles: 1,
        readFiles: 1,
        validFiles: 1,
        invalidFiles: 0,
        diagnostics: [],
      }),
    },
    runtimeEvents: {
      append: vi.fn(() => ({ kind: 'rejected', reason: 'run-not-active', message: 'not active' })),
      summary: vi.fn(() => null),
    },
  } as unknown as AgentRunner
  const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
  const server = await startLocalAppApiServer({
    getRunner: () => runner,
    port: 0,
    sessionIndex,
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
    abandon,
    dataDir,
    inspection,
    reconcileCompletedRuns,
    recoverInterruptedResumes,
    resumeCheckpoint,
    server,
    sessionIndex,
  }
}

describe('run checkpoint Local App API', () => {
  it('discovers, inspects and resumes a checkpoint through bounded HTTP and SSE contracts', async () => {
    const fixture = await createFixture()
    const base = `http://127.0.0.1:${fixture.server.port}`
    try {
      expect(fixture.reconcileCompletedRuns).toHaveBeenCalledWith(
        'startup reconciled checkpoint with successful execution log',
      )
      expect(fixture.recoverInterruptedResumes).toHaveBeenCalledWith(
        'application restarted before checkpoint continuation completed',
      )
      expect(fixture.recoverInterruptedResumes.mock.invocationCallOrder[0])
        .toBeLessThan(fixture.reconcileCompletedRuns.mock.invocationCallOrder[0]!)

      const listResponse = await fetch(`${base}${LOCAL_APP_API_ROUTES.runCheckpoints}`)
      expect(listResponse.status).toBe(200)
      await expect(listResponse.json()).resolves.toMatchObject({
        checkpoints: [{ id: 'checkpoint-1', resumable: true, currentStage: 'execute' }],
        diagnostics: { invalidFiles: 0, warningCount: 0 },
      })

      const itemPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, 'checkpoint-1')
      const inspectResponse = await fetch(`${base}${itemPath}`)
      expect(inspectResponse.status).toBe(200)
      await expect(inspectResponse.json()).resolves.toMatchObject({
        checkpoint: { id: 'checkpoint-1', pendingEventCount: 0 },
      })

      const resumeResponse = await fetch(`${base}${itemPath}/resume/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'resume from test',
          permissionMode: 'research',
          reasoning: 'auto',
          profile: 'general',
          requestKey: 'explicit-resume-turn',
          continuationDirective: 'answer',
        }),
      })
      expect(resumeResponse.status).toBe(200)
      const stream = await resumeResponse.text()
      expect(stream).toContain('event: start')
      expect(stream).toContain('event: verification_start')
      expect(stream).toContain('event: delta')
      expect(stream).toContain('event: result')
      const resumeOptions = fixture.resumeCheckpoint.mock.calls[0]?.[1]
      expect(resumeOptions?.runId).toEqual(expect.any(String))
      expect(resumeOptions).toMatchObject({
        permissionPolicyId: 'research',
        reasoning: 'auto',
        profile: 'general',
        requestKey: 'explicit-resume-turn',
        continuationDirective: 'answer',
      })
      expect(stream).toContain(`"runId":"${resumeOptions?.runId}"`)
      expect((await fixture.sessionIndex.list()).find((session) => session.id === 'checkpoint-session')).toMatchObject({
        id: 'checkpoint-session',
        workspacePath: join(fixture.dataDir, 'workplace'),
      })
    } finally {
      await fixture.server.stop()
      rmSync(fixture.dataDir, { recursive: true, force: true })
    }
  })

  it('inherits checkpoint policy, profile, and reasoning when resume overrides are omitted', async () => {
    const fixture = await createFixture(undefined, {
      permissionPolicyId: 'full',
      behaviorModeId: 'coding',
      reasoning: 'high',
    })
    const base = `http://127.0.0.1:${fixture.server.port}`
    const itemPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, 'checkpoint-1')
    try {
      const response = await fetch(`${base}${itemPath}/resume/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'resume with checkpoint defaults',
          requestKey: 'checkpoint-defaults-turn',
          continuationDirective: 'answer',
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('event: result')
      expect(fixture.resumeCheckpoint.mock.calls[0]?.[1]).toMatchObject({
        permissionPolicyId: 'full',
        reasoning: 'high',
        profile: 'coding',
      })
    } finally {
      await fixture.server.stop()
      rmSync(fixture.dataDir, { recursive: true, force: true })
    }
  })

  it('joins concurrent explicit retries and replays the completed stable request without another execution', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-checkpoint-real-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const previousDataDir = process.env.LITTLESHEEP_DATA_DIR
    process.env.LITTLESHEEP_DATA_DIR = dataDir
    const config = structuredClone(DEFAULT_CONFIG)
    config.agents.defaults.workspace = workplaceDir
    const llm = queuedLlm([
      textResponse('{"plan":[{"description":"continue the original PDF task","tools":[]}]}'),
      textResponse('Original PDF work continued once.'),
      textResponse('The original PDF task is complete.'),
      textResponse('{"verdict":"pass","reason":"original goal completed"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ])
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    let server: Awaited<ReturnType<typeof startLocalAppApiServer>> | undefined
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Translate the PDF and deliver the translated PDF.', {
        sessionId: session.id,
      })
      const clarificationRequest = {
        id: 'explicit-retry-request',
        kind: 'recovery_decision' as const,
        sourceStage: 'classify' as const,
        createdAt: new Date().toISOString(),
        originalRequest: 'Translate the PDF and deliver the translated PDF.',
        blockingReason: 'Permission was unavailable.',
        questions: [{
          id: 'question-1',
          field: 'permission',
          prompt: 'Enable permission, then continue.',
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
        id: 'explicit-retry-checkpoint',
        runId: 'explicit-retry-source-run',
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

      const path = localAppApiItemPath(
        LOCAL_APP_API_PREFIXES.runCheckpoints,
        checkpoint.id,
        '/resume/stream',
      )
      const requestBody = JSON.stringify({
        text: 'Permission is enabled. Continue the original task.',
        reason: 'explicit stable retry test',
        permissionMode: 'full',
        requestKey: 'explicit-stable-turn',
        continuationDirective: 'answer',
      })
      const request = () => fetch(`http://127.0.0.1:${server!.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      })
      const [firstResponse, joinedResponse] = await Promise.all([request(), request()])
      const [firstStream, joinedStream] = await Promise.all([firstResponse.text(), joinedResponse.text()])
      const firstRunId = firstStream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]
      const joinedRunId = joinedStream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]

      expect(firstResponse.status).toBe(200)
      expect(joinedResponse.status).toBe(200)
      expect(firstRunId).toMatch(/^conversation-run-[a-f0-9]{64}$/u)
      expect(joinedRunId).toBe(firstRunId)
      expect(firstStream).toContain('event: result')
      expect(joinedStream).toContain('event: result')
      const modelCallsAfterCompletion = vi.mocked(llm.chat).mock.calls.length
        + vi.mocked(llm.chatStream).mock.calls.length

      const replayResponse = await request()
      const replayStream = await replayResponse.text()
      const replayRunId = replayStream.match(/event: start\ndata: \{"ok":true,"runId":"([^"]+)"/)?.[1]
      expect(replayResponse.status).toBe(200)
      expect(replayRunId).toBe(firstRunId)
      expect(replayStream).toContain('event: result')
      expect(vi.mocked(llm.chat).mock.calls.length + vi.mocked(llm.chatStream).mock.calls.length)
        .toBe(modelCallsAfterCompletion)
      expect((await runner.sessionManager.read(session.id))
        .filter((message) => message.clarificationResponse?.requestId === clarificationRequest.id))
        .toHaveLength(1)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        requestKey: 'explicit-stable-turn',
        continuationDisposition: 'answer',
        resumeRunId: firstRunId,
      })
    } finally {
      await server?.stop()
      await runner.shutdown()
      if (previousDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR
      else process.env.LITTLESHEEP_DATA_DIR = previousDataDir
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('abandons a checkpoint without deleting its source session', async () => {
    const fixture = await createFixture()
    const base = `http://127.0.0.1:${fixture.server.port}`
    const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, 'checkpoint-1', '/abandon')
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'user chose not to continue' }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ checkpointId: 'checkpoint-1', outcome: 'abandoned' })
      expect(fixture.abandon).toHaveBeenCalledWith('checkpoint-1', 'user chose not to continue')
      expect((await fixture.sessionIndex.list()).find((session) => session.id === 'checkpoint-session')).toBeUndefined()
    } finally {
      await fixture.server.stop()
      rmSync(fixture.dataDir, { recursive: true, force: true })
    }
  })

  it('keeps checkpoint recovery alive when its observing SSE client disconnects', async () => {
    let releaseResume!: () => void
    let receivedSignal: AbortSignal | undefined
    let markCompleted!: () => void
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve })
    const completed = new Promise<void>((resolve) => { markCompleted = resolve })
    const fixture = await createFixture(async (_id, options = {}) => {
      receivedSignal = options.signal
      await resumeGate
      markCompleted()
      return {
        runId: options.runId!,
        sessionId: asSessionId('checkpoint-session'),
        status: 'ok',
        reply: '恢复完成',
        messages: [],
        trace: [],
        durationMs: 5,
      }
    })
    const base = `http://127.0.0.1:${fixture.server.port}`
    const itemPath = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runCheckpoints, 'checkpoint-1')
    const controller = new AbortController()
    try {
      const response = await fetch(`${base}${itemPath}/resume/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'detached recovery test' }),
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      controller.abort()
      await waitFor(() => receivedSignal !== undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(receivedSignal?.aborted).toBe(false)

      releaseResume()
      await completed
      expect(receivedSignal?.aborted).toBe(false)
    } finally {
      releaseResume()
      await fixture.server.stop()
      rmSync(fixture.dataDir, { recursive: true, force: true })
    }
  })
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for checkpoint recovery state')
}
