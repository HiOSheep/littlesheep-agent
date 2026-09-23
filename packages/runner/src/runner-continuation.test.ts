import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  textMessage,
  type AgentTool,
  type ClarificationRequest,
  type RunCheckpoint,
  type SessionId,
} from '@littlesheep/types'
import { createRunner } from './runner.js'
import { conversationTurnRunId } from './conversation-turn.js'

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' }
}

function mockLlm(response: ChatResponse): LlmClient {
  const chat = vi.fn(async (_request: ChatRequest) => response)
  const chatStream = vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    onDelta({ type: 'delta', delta: response.content })
    onDelta({ type: 'done', finishReason: response.finishReason })
    return response
  })
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
}

function queuedLlm(responses: ChatResponse[], requests: ChatRequest[]): LlmClient {
  const next = (request: ChatRequest): ChatResponse => {
    requests.push(request)
    const response = responses.shift()
    if (!response) throw new Error('unexpected LLM request')
    return response
  }
  return {
    chat: vi.fn(async (request) => next(request)),
    chatStream: vi.fn(async (request, onDelta) => {
      const response = next(request)
      if (response.content) onDelta({ type: 'delta', delta: response.content })
      onDelta({ type: 'done', finishReason: response.finishReason })
      return response
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
}

function recoveryRequest(id: string, sourceStage: ClarificationRequest['sourceStage'] = 'classify'): ClarificationRequest {
  return {
    id,
    kind: 'recovery_decision',
    sourceStage,
    createdAt: new Date().toISOString(),
    originalRequest: 'Complete the original PDF task.',
    blockingReason: 'A required runtime condition is unavailable.',
    questions: [{
      id: `${id}:question`,
      field: 'runtime_condition',
      prompt: 'Provide the missing condition or choose how to continue.',
      required: true,
    }],
  }
}

function waitingCheckpoint(input: {
  id: string
  sessionId: SessionId
  inboundMessageId: string
  request: ClarificationRequest
  workspace: string
  withAttachment?: boolean
  withTaskBook?: boolean
}): RunCheckpoint {
  return {
    version: 1,
    id: input.id,
    runId: `${input.id}:source-run`,
    sessionId: input.sessionId,
    status: 'waiting_user',
    currentStage: 'finalize',
    taskBookRevision: input.withTaskBook ? 1 : 0,
    ...(input.withTaskBook ? {
      taskBook: {
        assessment: {
          userNeed: 'Complete the original PDF task.',
          complexity: 'standard',
          goal: 'Complete the original PDF task.',
          successCriteria: ['The original PDF task is complete.'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 1.2,
        },
        goal: 'Complete the original PDF task.',
        complexity: 'standard',
        successCriteria: ['The original PDF task is complete.'],
        overdeliveryPolicy: { maxExtraScopeRatio: 1.2, guidance: 'Stay on the original task.' },
        steps: [{
          id: 'original-step',
          description: 'Complete the original PDF work.',
          tools: [],
          acceptanceCriteria: ['The original task is complete.'],
          status: 'pending',
        }],
      },
    } : {}),
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
      permissionPolicyId: 'restricted',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: input.withAttachment ? ['inspect_attachment'] : [],
      attachmentCount: input.withAttachment ? 1 : 0,
      ...(input.withAttachment ? {
        attachments: [{
          version: 1,
          attachmentId: 'original-attachment',
          cacheId: 'managed-cache-id',
          contentHash: 'a'.repeat(64),
          name: 'source.pdf',
          kind: 'document',
          mimeType: 'application/pdf',
          size: 100,
        }],
        toolRecipes: [{ version: 1, factory: 'inspect_attachment' }],
      } : {}),
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
    reason: 'waiting for a bound user response',
  }
}

function turnMessageId(sessionId: SessionId, requestKey: string): string {
  const digest = createHash('sha256').update(`${sessionId}\0${requestKey}`, 'utf8').digest('hex')
  return `conversation-turn-${digest}`
}

describe('runner checkpoint continuation', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-run-continuation-'))
    process.env.LITTLESHEEP_DATA_DIR = dataDir
  })

  afterEach(async () => {
    delete process.env.LITTLESHEEP_DATA_DIR
    await rm(dataDir, { recursive: true, force: true })
  })

  it('resumes from a checkpoint without appending the original inbound twice', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('continued reply')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'continue this task', { sessionId: session.id })
      await runner.sessionManager.append(session.id, [inbound])
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'continuation-checkpoint',
        runId: 'interrupted-run',
        sessionId: session.id,
        status: 'recoverable',
        currentStage: 'reply',
        taskBookRevision: 0,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [],
        sideEffects: [{
          idempotencyKey: 'tool:write:completed',
          toolName: 'write',
          status: 'succeeded',
          effectKind: 'local_mutation',
          evidenceRef: 'tool-result:write-completed',
        }],
        loopBudget: {
          attemptsUsed: 0,
          maxAttempts: 8,
          elapsedMs: 0,
          maxElapsedMs: 60_000,
          noProgressRounds: 0,
          maxNoProgressRounds: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: inbound.id,
          cwd: workspace,
          workspaceContext: { boundaryKind: 'agent_workplace' },
          model: 'test/model',
          origin: 'test',
          permissionPolicyId: 'restricted',
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
        },
        createdAt: new Date().toISOString(),
        reason: 'interrupted during execution',
      }
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.resumeCheckpoint!(checkpoint.id)
      expect(result.status, result.error).toBe('ok')
      expect(result.reply).toBe('continued reply')
      expect(result.sideEffects).toEqual(checkpoint.sideEffects)
      expect(result.modelRequests?.find((request) => request.cacheObservation)?.cacheObservation?.invalidationReasons)
        .toContain('replayed')
      const messages = await runner.sessionManager.read(session.id)
      expect(messages.filter((message) => message.id === inbound.id)).toHaveLength(1)
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        resultStatus: 'ok',
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('does not resume a checkpoint with an uncertain external side effect', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('unused')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'unsafe continuation', { sessionId: session.id })
      await runner.sessionManager.append(session.id, [inbound])
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'uncertain-continuation',
        runId: 'interrupted-run',
        sessionId: session.id,
        status: 'recoverable',
        currentStage: 'execute',
        taskBookRevision: 0,
        eventCursor: 0,
        pendingEventIds: [],
        contextSnapshotIds: [],
        sideEffects: [{
          idempotencyKey: 'tool:exec:unknown',
          toolName: 'exec',
          status: 'unknown',
          effectKind: 'external',
        }],
        loopBudget: {
          attemptsUsed: 0,
          maxAttempts: 8,
          elapsedMs: 0,
          maxElapsedMs: 60_000,
          noProgressRounds: 0,
          maxNoProgressRounds: 2,
        },
        resumeState: {
          version: 1,
          inboundMessageId: inbound.id,
          cwd: DEFAULT_CONFIG.agents.defaults.workspace,
          model: 'test/model',
          origin: 'test',
          permissionPolicyId: 'restricted',
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
        },
        createdAt: new Date().toISOString(),
        reason: 'effect uncertain',
      }
      await runner.infra.runCheckpointStore!.write(checkpoint)
      await expect(runner.resumeCheckpoint!(checkpoint.id)).rejects.toThrow('without verified completion')
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
    } finally {
      await runner.shutdown()
    }
  })

  it('binds an ordinary same-session answer before generic classification and uses current permission', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const requests: ChatRequest[] = []
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'deepseek/deepseek-v4-flash',
      llm: queuedLlm([
        textResponse('{"kind":"retry","reason":"permission changed"}'),
        textResponse('{"plan":[{"description":"continue the original PDF task","tools":[]}]}'),
        textResponse('Original PDF work continued.'),
        textResponse('The original PDF translation task is complete.'),
        textResponse('{"verdict":"pass","reason":"original goal completed"}'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ], requests),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('deepseek/deepseek-v4-flash')
      const original = textMessage('user', 'Translate the attached PDF and deliver a PDF.', { sessionId: session.id })
      const clarificationRequest = {
        id: 'pdf-request:clarification',
        kind: 'recovery_decision' as const,
        sourceStage: 'classify' as const,
        createdAt: new Date().toISOString(),
        originalRequest: 'Translate the attached PDF and deliver a PDF.',
        blockingReason: 'Permission and the PDF tool are unavailable.',
        questions: [{
          id: 'question-1',
          field: 'permission',
          prompt: 'Enable the required permission and tool, then tell me to retry.',
          required: true,
        }],
      }
      const question = textMessage('assistant', 'Enable the required permission and tool, then tell me to retry.', {
        sessionId: session.id,
        clarificationRequest,
      })
      await runner.sessionManager.append(session.id, [original, question])
      const checkpoint: RunCheckpoint = {
        version: 1,
        id: 'waiting-pdf-checkpoint',
        runId: 'original-pdf-run',
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
          cwd: workspace,
          model: 'deepseek/deepseek-v4-flash',
          origin: 'app',
          permissionPolicyId: 'restricted',
          reasoning: 'auto',
          behaviorModeId: 'general',
          availableToolNames: [],
          attachmentCount: 0,
          continuation: {
            version: 1,
            requestId: clarificationRequest.id,
            sourceStage: 'classify',
          },
          appliedTaskBookPatchIds: [],
          deferredRuntimeEvents: [],
          recoveryAttempts: 0,
          replanAttempts: 0,
          maxReplanAttempts: 2,
          verificationHistory: [],
        },
        createdAt: new Date().toISOString(),
        reason: 'waiting for permission and tool availability',
      }
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const continuationInput = {
        sessionId: session.id,
        text: 'The permission and tool are available now. Try again.',
        permissionPolicyId: 'full' as const,
        requestKey: 'ordinary-turn-1',
      }
      const [result, joined] = await Promise.all([
        runner.run(continuationInput),
        runner.run(continuationInput),
      ])

      expect(result.status).toBe('ok')
      expect(joined).toMatchObject({ runId: result.runId, status: result.status, reply: result.reply })
      expect(result.trace.map((entry) => entry.name)).not.toContain('classify')
      expect(requests[0]?.model).toBe('deepseek-v4-flash')
      expect(requests.some((request) => String(request.messages[0]?.content)
        .includes('Choose the next LittleSheep activity'))).toBe(false)
      expect(result.resolvedRunConfig?.permissionPolicyId).toBe('full')
      expect(result.conversationContinuation).toMatchObject({
        resolution: 'bound',
        checkpointId: checkpoint.id,
        sourceRunId: checkpoint.runId,
        requestId: clarificationRequest.id,
        disposition: 'retry',
        resumeStage: 'decide',
        resources: { status: 'not_required', attachmentCount: 0, toolRecipeCount: 0 },
        permissions: { checkpoint: 'restricted', current: 'full' },
        replayPrevention: { answerMessageAlreadyPersisted: false },
      })
      const messages = await runner.sessionManager.read(session.id)
      expect(messages.filter((message) => message.id === original.id)).toHaveLength(1)
      expect(messages.filter((message) => message.clarificationResponse?.requestId === clarificationRequest.id)).toHaveLength(1)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        resultStatus: 'ok',
        requestId: clarificationRequest.id,
        requestKey: 'ordinary-turn-1',
        answerMessageId: expect.stringMatching(/^conversation-turn-[a-f0-9]{64}$/u),
      })
      await expect(runner.replay(result.runId)).resolves.toMatchObject({
        conversationContinuation: {
          resolution: 'bound',
          checkpointId: checkpoint.id,
          disposition: 'retry',
          permissions: { checkpoint: 'restricted', current: 'full' },
        },
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('reconstructs an auto-bound completion when its execution log is missing after restart', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const firstModel = queuedLlm([
      textResponse('{"kind":"retry","reason":"permission changed"}'),
      textResponse('{"plan":[{"description":"continue the original task","tools":[]}]}'),
      textResponse('Original task output.'),
      textResponse('The original task is complete.'),
      textResponse('{"verdict":"pass","reason":"original goal completed"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ], [])
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original task.', { sessionId: session.id })
      const request = recoveryRequest('ordinary-restart-request')
      await first.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'ordinary-restart-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await first.infra.runCheckpointStore!.write(checkpoint)
      const input = {
        sessionId: session.id,
        text: 'Permission is enabled. Continue the original task.',
        permissionPolicyId: 'full' as const,
        requestKey: 'ordinary-restart-turn',
      }
      const completed = await first.run(input)
      await first.shutdown()
      firstStopped = true
      await rm(join(dataDir, 'execution-logs', `${completed.runId}.json`), { force: true })

      const replayModel = mockLlm(textResponse('must not execute'))
      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: replayModel,
        skillsDirs: [],
      })
      const replayed = await second.run(input)

      expect(replayed).toMatchObject({
        runId: completed.runId,
        status: completed.status,
        reply: completed.reply,
        conversationContinuation: {
          resolution: 'bound',
          checkpointId: checkpoint.id,
          resumeRule: 'durable-session-completion-receipt->replay',
        },
      })
      expect(replayModel.chat).not.toHaveBeenCalled()
      expect(replayModel.chatStream).not.toHaveBeenCalled()
      await expect(second.replay(completed.runId)).resolves.toMatchObject({
        status: 'ok',
        reply: completed.reply,
        conversationContinuation: {
          checkpointId: checkpoint.id,
          resumeRule: 'durable-session-completion-receipt->replay',
        },
      })
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('reconstructs a completed continuation whose source is older than the checkpoint inspection window', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const model = mockLlm(textResponse('must not execute'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: model,
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the long-lived original task.', { sessionId: session.id })
      const request = recoveryRequest('long-history-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const source = waitingCheckpoint({
        id: 'long-history-source',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withTaskBook: true,
      })
      source.createdAt = '2026-01-01T00:00:00.000Z'
      await runner.infra.runCheckpointStore!.write(source)

      const requestKey = 'long-history-turn'
      const answerText = 'The condition is available; complete the original task.'
      const answerMessageId = turnMessageId(session.id, requestKey)
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      await runner.infra.runCheckpointDispositionStore.claimResume(
        source.id,
        'completion receipt survived without its execution log',
        resumeRunId,
        {
          requestId: request.id,
          answerMessageId,
          requestKey,
          continuationDisposition: 'retry',
        },
      )
      await runner.sessionManager.append(session.id, [
        textMessage('user', answerText, {
          id: answerMessageId,
          sessionId: session.id,
          runId: resumeRunId,
          clarificationResponse: {
            requestId: request.id,
            answer: answerText,
            answeredAt: '2026-01-01T00:00:01.000Z',
          },
        }),
        textMessage('assistant', 'The long-lived original task is complete.', {
          sessionId: session.id,
          runId: resumeRunId,
          stage: 'finalize',
        }),
      ])

      for (let index = 0; index < 130; index += 1) {
        const filler = waitingCheckpoint({
          id: `long-history-newer-${index}`,
          sessionId: session.id,
          inboundMessageId: original.id,
          request,
          workspace,
        })
        filler.runId = `long-history-newer-run-${index}`
        filler.status = 'recoverable'
        filler.createdAt = new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString()
        await runner.infra.runCheckpointStore!.write(filler)
      }

      expect((await runner.runCheckpoints!.list(128)).some((item) => item.checkpoint.id === source.id)).toBe(false)
      const replayed = await runner.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
      })

      expect(replayed).toMatchObject({
        runId: resumeRunId,
        status: 'ok',
        reply: 'The long-lived original task is complete.',
        conversationContinuation: {
          resolution: 'bound',
          checkpointId: source.id,
          resumeRule: 'durable-session-completion-receipt->replay',
        },
      })
      expect(model.chat).not.toHaveBeenCalled()
      expect(model.chatStream).not.toHaveBeenCalled()
      await expect(runner.infra.runCheckpointDispositionStore.read(source.id)).resolves.toMatchObject({
        status: 'resumed',
        resumeRunId,
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('joins concurrent retries of the same normal conversation turn and returns one run result', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('One accepted reply.')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const attempts = await Promise.allSettled([
        runner.run({ sessionId: session.id, text: 'Hello.', requestKey: 'same-normal-turn' }),
        runner.run({ sessionId: session.id, text: 'Hello.', requestKey: 'same-normal-turn' }),
      ])

      expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(2)
      expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(0)
      const results = attempts
        .filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof runner.run>>> => item.status === 'fulfilled')
        .map((item) => item.value)
      expect(new Set(results.map((result) => result.runId)).size).toBe(1)
      expect(new Set(results.map((result) => result.reply))).toEqual(new Set(['One accepted reply.']))
      const messages = await runner.sessionManager.read(session.id)
      expect(messages.filter((message) => message.id === turnMessageId(session.id, 'same-normal-turn')))
        .toHaveLength(1)
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    } finally {
      await runner.shutdown()
    }
  })

  it('joins concurrent next-harness retries of the same turn and returns one run result', async () => {
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('One accepted next reply.')),
      skillsDirs: [],
      durableHarnessMode: 'next',
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const attempts = await Promise.allSettled([
        runner.run({ sessionId: session.id, text: 'Hello next.', requestKey: 'same-next-turn' }),
        runner.run({ sessionId: session.id, text: 'Hello next.', requestKey: 'same-next-turn' }),
      ])

      expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(2)
      expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(0)
      const results = attempts
        .filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof runner.run>>> => item.status === 'fulfilled')
        .map((item) => item.value)
      expect(new Set(results.map((result) => result.runId)).size).toBe(1)
      expect(new Set(results.map((result) => result.reply))).toEqual(new Set(['One accepted next reply.']))
      const messages = await runner.sessionManager.read(session.id)
      expect(messages.filter((message) => message.id === turnMessageId(session.id, 'same-next-turn')))
        .toHaveLength(1)
      expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    } finally {
      await runner.shutdown()
    }
  })

  it('restores attachment references and trusted tools once for concurrent ordinary retries', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const restoreResources = vi.fn(async () => ({
      attachments: [{
        id: 'original-attachment',
        path: join(workspace, 'managed-source.pdf'),
        name: 'source.pdf',
        kind: 'document' as const,
        mimeType: 'application/pdf',
        size: 100,
        cacheId: 'managed-cache-id',
        contentHash: 'a'.repeat(64),
      }],
      additionalTools: [{
        name: 'inspect_attachment',
        description: 'Inspect a verified managed attachment.',
        inputSchema: { parse: (input: unknown) => input },
        async execute() {
          return { callId: 'inspect-restored', name: 'inspect_attachment', ok: true, output: 'verified PDF' }
        },
      }],
    }))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: queuedLlm([
        textResponse('{"kind":"retry","reason":"the attachment runtime is available"}'),
        textResponse('{"plan":[{"description":"continue the PDF task","tools":[]}]}'),
        textResponse('PDF work continued with the restored source.'),
        textResponse('The original PDF task is complete.'),
        textResponse('{"verdict":"pass","reason":"the original goal completed"}'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ], []),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Translate the source PDF.', { sessionId: session.id })
      const request = recoveryRequest('restorable-attachment-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'restorable-attachment-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withAttachment: true,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)
      const input = {
        sessionId: session.id,
        text: 'The PDF tool is available now. Continue.',
        requestKey: 'restorable-attachment-turn',
        restoreCheckpointResources: restoreResources,
      }

      const [result, joined] = await Promise.all([runner.run(input), runner.run(input)])

      expect(joined.runId).toBe(result.runId)
      expect(restoreResources).toHaveBeenCalledTimes(1)
      expect(result.conversationContinuation).toMatchObject({
        resolution: 'bound',
        checkpointId: checkpoint.id,
        resources: {
          status: 'restored',
          attachmentCount: 1,
          toolRecipeCount: 1,
          restoredToolCount: 1,
        },
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('retries trusted resource restoration safely after process loss at the restore boundary', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const restoredAttachment = {
      id: 'resource-crash-attachment',
      path: join(workspace, 'managed-source.pdf'),
      name: 'source.pdf',
      kind: 'document' as const,
      mimeType: 'application/pdf',
      size: 100,
      cacheId: 'managed-cache-id',
      contentHash: 'a'.repeat(64),
    }
    const restoredTool: AgentTool = {
      name: 'inspect_attachment',
      description: 'Inspect a verified managed attachment.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      async execute() {
        return { callId: 'inspect-resource-crash', ok: true, output: 'verified PDF' }
      },
    }
    let restorationAttempt = 0
    const restoreResources = vi.fn(async () => {
      restorationAttempt += 1
      const restored = { attachments: [restoredAttachment], additionalTools: [restoredTool] }
      if (restorationAttempt === 1) {
        throw new Error('simulated process loss after trusted resources were reconstructed')
      }
      return restored
    })
    const firstModel = mockLlm(textResponse('must not be called before resources are restored'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Translate the source PDF.', { sessionId: session.id })
      const request = recoveryRequest('resource-crash-request')
      await first.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'resource-crash-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withAttachment: true,
      })
      await first.infra.runCheckpointStore!.write(checkpoint)
      const requestKey = 'resource-crash-turn'
      const answerText = 'The PDF tool is available now. Continue.'
      vi.spyOn(first.infra.executionLogStore, 'write')
        .mockRejectedValue(new Error('simulated process loss before failure audit'))

      await expect(first.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
        continuationDirective: 'retry',
        restoreCheckpointResources: restoreResources,
      })).rejects.toThrow('process loss after trusted resources were reconstructed')
      expect(await first.sessionManager.findMessage(session.id, turnMessageId(session.id, requestKey)))
        .toBeNull()
      expect(await first.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
      await first.shutdown()
      firstStopped = true

      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: queuedLlm([
          // The resumed turn runs in the single main loop: the model inspects the
          // restored attachment itself and names it in the answer, which is what
          // the continuity check looks for.
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'inspect-restored',
              type: 'function' as const,
              function: { name: 'inspect_attachment', arguments: JSON.stringify({ path: 'source.pdf' }) },
            }],
          },
          textResponse('The restored source.pdf was inspected (verified PDF) and the translation of the source PDF is complete.'),
        ], []),
        skillsDirs: [],
      })
      const result = await second.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
        continuationDirective: 'retry',
        restoreCheckpointResources: restoreResources,
      })

      expect(result.status).toBe('ok')
      expect(restoreResources).toHaveBeenCalledTimes(2)
      expect(result.conversationContinuation?.resources).toMatchObject({
        status: 'restored',
        attachmentCount: 1,
        toolRecipeCount: 1,
        restoredToolCount: 1,
      })
      expect((await second.sessionManager.read(session.id)).filter((message) => (
        message.id === turnMessageId(session.id, requestKey)
      ))).toHaveLength(1)
      expect(firstModel.chat).not.toHaveBeenCalled()
      expect(firstModel.chatStream).not.toHaveBeenCalled()
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('retries only the blocked document step after an exhausted recover checkpoint gains full access', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const requests: ChatRequest[] = []
    const restoredInspect = vi.fn(async () => ({
      callId: 'inspect-must-not-replay',
      ok: true,
      output: 'unexpected duplicate attachment read',
    }))
    const restoredInspectTool: AgentTool = {
      name: 'inspect_attachment',
      description: 'Inspect a verified managed attachment.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execute: restoredInspect,
    }
    const restoreResources = vi.fn(async () => ({
      attachments: [{
        id: 'original-attachment',
        path: join(workspace, 'managed-source.pdf'),
        name: 'source.pdf',
        kind: 'document' as const,
        mimeType: 'application/pdf',
        size: 100,
        cacheId: 'managed-cache-id',
        contentHash: 'a'.repeat(64),
      }],
      additionalTools: [restoredInspectTool],
    }))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: queuedLlm([
        {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{
            id: 'create-translated-pdf',
            type: 'function',
            function: {
              name: 'document_create',
              arguments: JSON.stringify({
                file_path: 'translated.pdf',
                format: 'pdf',
                blocks: [{ type: 'paragraph', text: 'Translated content' }],
              }),
            },
          }],
        },
        textResponse('The translated PDF was created from the preserved source evidence.'),
        textResponse('The original PDF translation is complete and translated.pdf is ready.'),
        textResponse('{"verdict":"pass","reason":"the translated PDF was created"}'),
        textResponse('{"memories":[],"createSkill":null}'),
      ], requests),
      skillsDirs: [],
      containerRoot: dataDir,
    })
    const documentCreate = runner.infra.registry.get('document_create')?.tool
    if (!documentCreate) throw new Error('document_create is not registered')
    const observedPermissionModes: Array<string | undefined> = []
    const executeDocumentCreate = vi.spyOn(documentCreate, 'execute').mockImplementation(async (_input, context) => {
      observedPermissionModes.push(context.permissionMode)
      return {
        callId: '',
        ok: true,
        output: 'Created PDF: translated.pdf',
        meta: { artifactPath: join(workspace, 'translated.pdf'), verified: true },
      }
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Translate the attached PDF and deliver another PDF.', { sessionId: session.id })
      const request = recoveryRequest('exhausted-document-request', 'recover')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'exhausted-document-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withAttachment: true,
        withTaskBook: true,
      })
      checkpoint.resumeState!.permissionPolicyId = 'research'
      checkpoint.resumeState!.availableToolNames = ['inspect_attachment', 'document_create']
      checkpoint.resumeState!.recoveryAttempts = DEFAULT_CONFIG.agents.defaults.maxRecoveryAttempts
      checkpoint.resumeState!.lastError = {
        stage: 'execute',
        message: 'Approval denied for document_create',
      }
      checkpoint.taskBook!.steps = [{
        id: 'inspect-source',
        description: 'Read the original PDF once.',
        tools: ['inspect_attachment'],
        acceptanceCriteria: ['The source content is available.'],
        status: 'done',
      }, {
        id: 'create-translation',
        description: 'Create the translated PDF.',
        tools: ['document_create'],
        acceptanceCriteria: ['A verified translated PDF is created.'],
        status: 'blocked',
      }]
      const inspectedAt = new Date(Date.now() - 2_000).toISOString()
      const blockedAt = new Date(Date.now() - 1_000).toISOString()
      checkpoint.taskExecution = {
        goal: checkpoint.taskBook!.goal,
        complexity: checkpoint.taskBook!.complexity,
        status: 'blocked',
        startedAt: inspectedAt,
        endedAt: blockedAt,
        steps: [{
          stepId: 'inspect-source',
          description: 'Read the original PDF once.',
          status: 'done',
          startedAt: inspectedAt,
          endedAt: inspectedAt,
          output: 'Preserved source text.',
          toolCallIds: ['original-inspect-call'],
          toolResults: [{
            callId: 'original-inspect-call',
            ok: true,
            output: 'Preserved source text.',
          }],
        }, {
          stepId: 'create-translation',
          description: 'Create the translated PDF.',
          status: 'blocked',
          startedAt: blockedAt,
          endedAt: blockedAt,
          error: 'Approval denied for document_create',
          failureKind: 'permission_denied',
          attempt: 1,
          toolCallIds: ['original-create-call'],
          toolResults: [{
            callId: 'original-create-call',
            ok: false,
            error: 'Approval denied',
          }],
        }],
      }
      checkpoint.taskBook!.stageResults = structuredClone(checkpoint.taskExecution!.steps)
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const requestKey = 'exhausted-document-turn'
      const result = await runner.run({
        sessionId: session.id,
        text: 'Full access and the required tools are available now. Try again.',
        requestKey,
        continuationDirective: 'retry',
        permissionPolicyId: 'full',
        restoreCheckpointResources: restoreResources,
      })

      expect(result.status).toBe('ok')
      expect(result.trace.map((entry) => entry.name).slice(0, 2)).toEqual(['recover', 'execute'])
      expect(result.trace.map((entry) => entry.name)).not.toContain('classify')
      expect(result.modelRequests?.some((request) => request.stage === 'recover')).toBe(false)
      expect(restoreResources).toHaveBeenCalledTimes(1)
      expect(restoredInspect).not.toHaveBeenCalled()
      expect(executeDocumentCreate).toHaveBeenCalledTimes(1)
      expect(observedPermissionModes).toEqual(['full'])
      // The resumed turn runs in the single main loop, so it no longer rewrites
      // plan-step bookkeeping; the recorded side effect below proves the blocked
      // step's work happened exactly once under the current permissions.
      expect(result.conversationContinuation).toMatchObject({
        resolution: 'bound',
        checkpointId: checkpoint.id,
        disposition: 'retry',
        resumeStage: 'recover',
        resumeRule: 'recover->recover',
        resources: {
          status: 'restored',
          attachmentCount: 1,
          toolRecipeCount: 1,
          restoredToolCount: 1,
        },
        permissions: { checkpoint: 'research', current: 'full' },
        replayPrevention: { completedStepCountPreserved: 1 },
      })
      // One settled side effect for the retried work. The loop owns the call, so
      // the effect is no longer attributed to a plan step.
      expect(result.sideEffects).toEqual([
        expect.objectContaining({ toolName: 'document_create', status: 'succeeded' }),
      ])
      expect((await runner.sessionManager.read(session.id)).filter((message) => (
        message.id === turnMessageId(session.id, requestKey)
      ))).toHaveLength(1)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        resultStatus: 'ok',
        continuationDisposition: 'retry',
      })
      await expect(runner.runCheckpoints!.resolveWaitingUserHead(session.id)).resolves.toEqual({ kind: 'none' })
      // The retried run delivers the answer it produced. It used to end here by
      // escalating instead: VERIFY read the *inherited* plan as an incomplete
      // step execution, sent the run to RECOVER, and the exhausted budget turned
      // that into a synthetic "how should I proceed?" question one round after
      // the user had already answered it.
      expect(requests).toHaveLength(2)
      expect(result.trace.map((entry) => entry.name)).toEqual(['recover', 'execute', 'verify', 'finalize'])
      expect(result.reply).toBe('The translated PDF was created from the preserved source evidence.')
    } finally {
      executeDocumentCreate.mockRestore()
      await runner.shutdown()
    }
  })

  it('supports a shadow rollout that audits the eligible head without claiming it', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const model = mockLlm(textResponse('Shadow-mode fresh reply.'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: model,
      skillsDirs: [],
      conversationContinuationMode: 'shadow',
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Original task.', { sessionId: session.id })
      const request = recoveryRequest('shadow-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'shadow-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Hello there.',
        requestKey: 'shadow-turn',
      })

      expect(result.trace.map((entry) => entry.name)).toContain('classify')
      expect(result.conversationContinuation).toMatchObject({
        resolution: 'eligible',
        checkpointId: checkpoint.id,
        requestId: request.id,
      })
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
      expect(await runner.infra.runCheckpointStore!.read(checkpoint.id)).toMatchObject({
        id: checkpoint.id,
        status: 'waiting_user',
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('keeps waiting checkpoints and dispositions untouched when automatic continuation is off', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const model = mockLlm(textResponse('Off-mode fresh reply.'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: model,
      skillsDirs: [],
      conversationContinuationMode: 'off',
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Original task.', { sessionId: session.id })
      const request = recoveryRequest('off-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'off-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Treat this as a normal turn while rollout is disabled.',
        requestKey: 'off-turn',
      })

      expect(result.trace.map((entry) => entry.name)).toContain('classify')
      expect(result.conversationContinuation).toMatchObject({ resolution: 'none' })
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
      expect(await runner.infra.runCheckpointStore!.read(checkpoint.id)).toEqual(checkpoint)
    } finally {
      await runner.shutdown()
    }
  })

  it('replays a completed request key after runner restart without another model call', async () => {
    const firstModel = mockLlm(textResponse('Durable reply.'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const input = { sessionId: session.id, text: 'Persist this turn.', requestKey: 'restart-replay-turn' }
      const original = await first.run(input)
      await first.shutdown()
      firstStopped = true

      const replayModel = mockLlm(textResponse('This must not be called.'))
      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: replayModel,
        skillsDirs: [],
      })
      const replayed = await second.run(input)

      expect(replayed).toMatchObject({
        runId: original.runId,
        status: original.status,
        reply: original.reply,
      })
      expect(replayModel.chat).not.toHaveBeenCalled()
      expect(replayModel.chatStream).not.toHaveBeenCalled()
      await expect(second.run({ ...input, text: 'Different content.' }))
        .rejects.toThrow('different turn content or runtime inputs')
      expect((await second.sessionManager.read(session.id))
        .filter((message) => message.id === turnMessageId(session.id, input.requestKey))).toHaveLength(1)
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('replays a completed next-harness request after restart without another model call', async () => {
    const firstModel = mockLlm(textResponse('Durable next reply.'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
      durableHarnessMode: 'next',
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const input = {
        sessionId: session.id,
        text: 'Persist this next-harness turn.',
        requestKey: 'next-restart-replay-turn',
      }
      const original = await first.run(input)
      expect(original).toMatchObject({ status: 'ok', reply: 'Durable next reply.', durableHarnessMode: 'next' })
      await first.shutdown()
      firstStopped = true

      const replayModel = mockLlm(textResponse('This must not be called.'))
      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: replayModel,
        skillsDirs: [],
        durableHarnessMode: 'next',
      })
      const replayed = await second.run(input)

      expect(replayed).toMatchObject({
        runId: original.runId,
        status: original.status,
        reply: original.reply,
      })
      expect(replayed.finalReplySettlement?.status).toBe('settled')
      expect(replayModel.chat).not.toHaveBeenCalled()
      expect(replayModel.chatStream).not.toHaveBeenCalled()
      expect((await second.sessionManager.read(session.id))
        .filter((message) => message.id === turnMessageId(session.id, input.requestKey))).toHaveLength(1)
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('recovers a claim-only crash and persists the bound answer exactly once after restart', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const firstModel = mockLlm(textResponse('must not be called before the simulated restart'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('claim-only-request')
      await first.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'claim-only-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await first.infra.runCheckpointStore!.write(checkpoint)
      const requestKey = 'claim-only-turn'
      const answerText = 'The runtime condition is available; retry.'
      const answerMessageId = turnMessageId(session.id, requestKey)
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      await first.infra.runCheckpointDispositionStore.claimResume(
        checkpoint.id,
        'claim was durable before process loss',
        resumeRunId,
        {
          requestId: request.id,
          answerMessageId,
          requestKey,
          continuationDisposition: 'retry',
        },
      )
      expect(await first.sessionManager.findMessage(session.id, answerMessageId)).toBeNull()
      await first.shutdown()
      firstStopped = true

      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: queuedLlm([
          textResponse('{"plan":[{"description":"continue after the claim crash","tools":[]}]}'),
          textResponse('Recovered task output.'),
          textResponse('The original task continued after the claim-only crash.'),
          textResponse('{"verdict":"pass","reason":"continuation completed"}'),
          textResponse('{"memories":[],"createSkill":null}'),
          textResponse('{"observations":[]}'),
        ], []),
        skillsDirs: [],
      })
      expect(await second.runCheckpoints!.recoverInterruptedResumes('application restarted')).toBe(1)
      const result = await second.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
        continuationDirective: 'retry',
      })

      expect(result.status).toBe('ok')
      expect(result.runId).toBe(resumeRunId)
      expect(result.conversationContinuation?.replayPrevention?.answerMessageAlreadyPersisted).toBe(false)
      expect((await second.sessionManager.read(session.id)).filter((message) => message.id === answerMessageId))
        .toHaveLength(1)
      expect(await second.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        resumeRunId,
        requestKey,
      })
      expect(firstModel.chat).not.toHaveBeenCalled()
      expect(firstModel.chatStream).not.toHaveBeenCalled()
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('reclaims an interrupted answer after the answer was persisted without appending it twice', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const requests: ChatRequest[] = []
    const firstModel = mockLlm(textResponse('must not be called before the simulated restart'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('crash-request')
      const question = textMessage('assistant', request.questions[0]!.prompt, {
        sessionId: session.id,
        clarificationRequest: request,
      })
      const requestKey = 'crash-retry-turn'
      const answerId = turnMessageId(session.id, requestKey)
      const answer = textMessage('user', 'The runtime condition is available; retry.', {
        id: answerId,
        sessionId: session.id,
        clarificationResponse: {
          requestId: request.id,
          answer: 'The runtime condition is available; retry.',
          answeredAt: new Date().toISOString(),
        },
      })
      await first.sessionManager.append(session.id, [original, question, answer])
      const checkpoint = waitingCheckpoint({
        id: 'crash-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await first.infra.runCheckpointStore!.write(checkpoint)
      const identity = {
        requestId: request.id,
        answerMessageId: answerId,
        requestKey,
        continuationDisposition: 'retry' as const,
      }
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      await first.infra.runCheckpointDispositionStore.claimResume(
        checkpoint.id,
        'claimed before simulated crash',
        resumeRunId,
        identity,
      )
      await first.shutdown()
      firstStopped = true
      expect(firstModel.chat).not.toHaveBeenCalled()
      expect(firstModel.chatStream).not.toHaveBeenCalled()

      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm: queuedLlm([
          textResponse('{"plan":[{"description":"continue after the crash","tools":[]}]}'),
          textResponse('Recovered task output.'),
          textResponse('The original task continued after the crash.'),
          textResponse('{"verdict":"pass","reason":"continuation completed"}'),
          textResponse('{"memories":[],"createSkill":null}'),
          textResponse('{"observations":[]}'),
        ], requests),
        skillsDirs: [],
      })
      expect(await second.runCheckpoints!.recoverInterruptedResumes('application restarted')).toBe(1)
      const result = await second.run({
        sessionId: session.id,
        text: 'The runtime condition is available; retry.',
        requestKey,
      })

      expect(result.status).toBe('ok')
      expect(result.conversationContinuation?.replayPrevention?.answerMessageAlreadyPersisted).toBe(true)
      expect((await second.sessionManager.read(session.id)).filter((message) => message.id === answerId))
        .toHaveLength(1)
      expect(requests.some((requestItem) => String(requestItem.messages[0]?.content)
        .includes('structurally bound user turn'))).toBe(false)
      expect(await second.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        requestKey,
        continuationDisposition: 'retry',
      })
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('links the latest runtime checkpoint when a claimed continuation throws before completion', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('must not execute')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Continue the original durable task.', { sessionId: session.id })
      const request = recoveryRequest('claimed-error-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const source = waitingCheckpoint({
        id: 'claimed-error-source',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      await runner.infra.runCheckpointStore!.write(source)
      const requestKey = 'claimed-error-turn'
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      const linked = structuredClone(source)
      linked.id = 'claimed-error-latest-runtime'
      linked.runId = resumeRunId
      linked.status = 'recoverable'
      linked.currentStage = 'recover'
      linked.createdAt = new Date(Date.now() + 1_000).toISOString()
      await runner.infra.runCheckpointStore!.write(linked)
      vi.spyOn(runner.sessionManager, 'appendIfAbsent')
        .mockRejectedValueOnce(new Error('simulated failure after continuation claim'))

      await expect(runner.run({
        sessionId: session.id,
        text: 'Retry the original task now.',
        requestKey,
        continuationDirective: 'retry',
      })).rejects.toThrow('simulated failure after continuation claim')
      await expect(runner.infra.runCheckpointDispositionStore.read(source.id)).resolves.toMatchObject({
        status: 'interrupted',
        resumeRunId,
        nextCheckpointId: linked.id,
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('fails closed after restart when the linked continuation checkpoint has an in-progress side effect', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const llm = mockLlm(textResponse('must not be called'))
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'unexpected mutation' }))
    const effectTool: AgentTool = {
      name: 'continuity_write',
      description: 'Apply one continuity test mutation.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:continuity-proof', mode: 'write' }],
      },
      execute: executeEffect,
    }
    const firstModel = mockLlm(textResponse('must not be called after the durable tool boundary'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('effect-started-request', 'execute')
      const requestKey = 'effect-started-turn'
      const answerText = 'The missing condition is available; continue the same task.'
      const answerMessageId = turnMessageId(session.id, requestKey)
      await first.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
        textMessage('user', answerText, {
          id: answerMessageId,
          sessionId: session.id,
          clarificationResponse: {
            requestId: request.id,
            answer: answerText,
            answeredAt: new Date().toISOString(),
          },
        }),
      ])
      const source = waitingCheckpoint({
        id: 'effect-started-source',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withTaskBook: true,
      })
      await first.infra.runCheckpointStore!.write(source)
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      await first.infra.runCheckpointDispositionStore.claimResume(
        source.id,
        'claimed before the effect boundary crash',
        resumeRunId,
        {
          requestId: request.id,
          answerMessageId,
          requestKey,
          continuationDisposition: 'retry',
        },
      )

      const linked = structuredClone(source)
      linked.id = 'effect-started-runtime-checkpoint'
      linked.runId = resumeRunId
      linked.status = 'recoverable'
      linked.currentStage = 'execute'
      linked.createdAt = new Date(Date.now() + 1_000).toISOString()
      linked.reason = 'started effectful tool continuity_write'
      linked.resumeState!.availableToolNames = ['continuity_write']
      linked.sideEffects = [{
        idempotencyKey: `tool:continuity_write:${createHash('sha256').update('{}').digest('hex')}`,
        inputHash: createHash('sha256').update('{}').digest('hex'),
        toolName: 'continuity_write',
        status: 'in_progress',
        stepId: 'original-step',
        callId: 'original-effect-call',
        resourceKeys: ['workspace:continuity-proof'],
        effectKind: 'local_mutation',
        startedAt: new Date().toISOString(),
      }]
      await first.infra.runCheckpointStore!.write(linked)

      await first.shutdown()
      firstStopped = true
      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm,
        skillsDirs: [],
      })

      expect(await second.runCheckpoints!.recoverInterruptedResumes('application restarted')).toBe(1)
      expect(await second.infra.runCheckpointDispositionStore.read(source.id)).toMatchObject({
        status: 'interrupted',
        resumeRunId,
        nextCheckpointId: linked.id,
      })

      await expect(second.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
        continuationDirective: 'retry',
        permissionPolicyId: 'full',
        additionalTools: [effectTool],
      })).rejects.toThrow('side effect(s) without verified completion evidence')
      expect(executeEffect).not.toHaveBeenCalled()
      expect(llm.chat).not.toHaveBeenCalled()
      expect(llm.chatStream).not.toHaveBeenCalled()
      expect((await second.sessionManager.read(session.id)).filter((message) => message.id === answerMessageId))
        .toHaveLength(1)
      expect(firstModel.chat).not.toHaveBeenCalled()
      expect(firstModel.chatStream).not.toHaveBeenCalled()
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('resumes from a linked successful-effect checkpoint without replaying its completed tool step', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const requests: ChatRequest[] = []
    const llm = queuedLlm([
      textResponse('The original PDF task continued from its durable completed step.'),
      textResponse('{"verdict":"pass","reason":"the completed effect and task output were preserved"}'),
      textResponse('{"memories":[],"createSkill":null}'),
      textResponse('{"observations":[]}'),
    ], requests)
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'duplicate mutation' }))
    const effectTool: AgentTool = {
      name: 'continuity_write',
      description: 'Apply one continuity test mutation.',
      inputSchema: { parse: (input) => input, jsonSchema: { type: 'object' } },
      execution: {
        concurrency: 'exclusive',
        resources: () => [{ key: 'workspace:continuity-proof', mode: 'write' }],
      },
      execute: executeEffect,
    }
    const firstModel = mockLlm(textResponse('must not be called after the durable tool boundary'))
    const first = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: firstModel,
      skillsDirs: [],
    })
    let second: Awaited<ReturnType<typeof createRunner>> | undefined
    let firstStopped = false
    try {
      const session = await first.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('effect-finished-request', 'execute')
      const requestKey = 'effect-finished-turn'
      const answerText = 'The missing condition is available; continue the same task.'
      const answerMessageId = turnMessageId(session.id, requestKey)
      await first.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
        textMessage('user', answerText, {
          id: answerMessageId,
          sessionId: session.id,
          clarificationResponse: {
            requestId: request.id,
            answer: answerText,
            answeredAt: new Date().toISOString(),
          },
        }),
      ])
      const source = waitingCheckpoint({
        id: 'effect-finished-source',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withTaskBook: true,
      })
      await first.infra.runCheckpointStore!.write(source)
      const resumeRunId = conversationTurnRunId(session.id, requestKey)!
      await first.infra.runCheckpointDispositionStore.claimResume(
        source.id,
        'claimed before the post-effect crash',
        resumeRunId,
        {
          requestId: request.id,
          answerMessageId,
          requestKey,
          continuationDisposition: 'retry',
        },
      )

      const linked = structuredClone(source)
      linked.id = 'effect-finished-runtime-checkpoint'
      linked.runId = resumeRunId
      linked.status = 'recoverable'
      linked.currentStage = 'execute'
      linked.createdAt = new Date(Date.now() + 1_000).toISOString()
      linked.reason = 'finished effectful tool continuity_write'
      linked.resumeState!.availableToolNames = ['continuity_write']
      linked.taskBook!.steps[0]!.tools = ['continuity_write']
      linked.taskBook!.steps[0]!.status = 'done'
      const originalToolResult = {
        callId: 'original-effect-call',
        ok: true,
        output: 'original side effect completed',
        durationMs: 5,
        meta: { stepId: 'original-step' },
      }
      linked.taskExecution = {
        goal: linked.taskBook!.goal,
        complexity: linked.taskBook!.complexity,
        status: 'done',
        startedAt: new Date(Date.now() - 2_000).toISOString(),
        endedAt: new Date(Date.now() - 1_000).toISOString(),
        summary: 'The original effectful step completed before the crash.',
        steps: [{
          stepId: 'original-step',
          description: 'Complete the original PDF work.',
          status: 'done',
          startedAt: new Date(Date.now() - 2_000).toISOString(),
          endedAt: new Date(Date.now() - 1_000).toISOString(),
          output: 'original side effect completed',
          toolCallIds: ['original-effect-call'],
          toolResults: [originalToolResult],
        }],
      }
      const inputHash = createHash('sha256').update('{}').digest('hex')
      linked.sideEffects = [{
        idempotencyKey: `tool:continuity_write:${inputHash}`,
        inputHash,
        toolName: 'continuity_write',
        status: 'succeeded',
        stepId: 'original-step',
        callId: 'original-effect-call',
        resourceKeys: ['workspace:continuity-proof'],
        effectKind: 'local_mutation',
        startedAt: new Date(Date.now() - 2_000).toISOString(),
        endedAt: new Date(Date.now() - 1_000).toISOString(),
        evidenceRef: 'tool:original-effect-call',
      }]
      await first.infra.runCheckpointStore!.write(linked)

      await first.shutdown()
      firstStopped = true
      second = await createRunner({
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        llm,
        skillsDirs: [],
      })

      expect(await second.runCheckpoints!.recoverInterruptedResumes('application restarted')).toBe(1)
      const result = await second.run({
        sessionId: session.id,
        text: answerText,
        requestKey,
        continuationDirective: 'retry',
        permissionPolicyId: 'full',
        additionalTools: [effectTool],
      })

      expect(result.status).toBe('ok')
      expect(executeEffect).not.toHaveBeenCalled()
      expect(result.taskExecution?.steps).toEqual([
        expect.objectContaining({ stepId: 'original-step', status: 'done', output: 'original side effect completed' }),
      ])
      expect(result.sideEffects).toEqual(linked.sideEffects)
      expect(result.conversationContinuation?.replayPrevention).toMatchObject({
        completedStepCountPreserved: 1,
        succeededSideEffectCountPreserved: 1,
        uncertainSideEffectCount: 0,
        answerMessageAlreadyPersisted: true,
      })
      expect(await second.infra.runCheckpointDispositionStore.read(source.id)).toMatchObject({
        status: 'resumed',
        resultStatus: 'ok',
        requestKey,
        continuationDisposition: 'retry',
      })
      expect((await second.sessionManager.read(session.id)).filter((message) => message.id === answerMessageId))
        .toHaveLength(1)
      expect(requests.length).toBeGreaterThan(0)
      expect(firstModel.chat).not.toHaveBeenCalled()
      expect(firstModel.chatStream).not.toHaveBeenCalled()
    } finally {
      await second?.shutdown()
      if (!firstStopped) await first.shutdown()
    }
  })

  it('cancels a waiting task without restoring resources or entering an effectful stage', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const restoreResources = vi.fn(async () => {
      throw new Error('resource restoration must not run for cancellation')
    })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('The original task has been cancelled.')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('cancel-request', 'recover')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'cancel-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withAttachment: true,
        withTaskBook: true,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Cancel that task.',
        requestKey: 'cancel-turn',
        continuationDirective: 'cancel',
        restoreCheckpointResources: restoreResources,
      })

      expect(result.status).toBe('ok')
      expect(result.trace.map((entry) => entry.name)).toEqual(['reply', 'finalize'])
      expect(result.toolInvocations ?? []).toHaveLength(0)
      expect(restoreResources).not.toHaveBeenCalled()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'abandoned',
        continuationDisposition: 'cancel',
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('defers the old head and runs an explicit new task without inheriting old task state', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('This is the separate task response.')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('new-task-request', 'recover')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'new-task-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withTaskBook: true,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Hello. This is a separate new task.',
        requestKey: 'new-task-turn',
        continuationDirective: 'new_task',
      })

      expect(result.status).toBe('ok')
      const names = result.trace.map((entry) => entry.name)
      // The new task is conversational, so it runs in the single main loop and
      // must still inherit neither the deferred head's plan nor its state: no
      // planning request, no recovery, no TaskBook.
      expect(names).toContain('execute')
      expect(names).not.toContain('decide')
      expect(names).not.toContain('recover')
      expect(result.taskBook).toBeUndefined()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'deferred',
        continuationDisposition: 'new_task',
      })
      await expect(runner.runCheckpoints!.resolveWaitingUserHead(session.id)).resolves.toEqual({ kind: 'none' })
    } finally {
      await runner.shutdown()
    }
  })

  it('fails closed on an ambiguous bound turn before claim or resource restoration', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const restoreResources = vi.fn(async () => ({ attachments: [], additionalTools: [] }))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: mockLlm(textResponse('not a valid disposition')),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('ambiguous-request', 'recover')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'ambiguous-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withAttachment: true,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Do something different, maybe.',
        requestKey: 'ambiguous-turn',
        restoreCheckpointResources: restoreResources,
      })

      // An ambiguous disposition is the model's judgement, not a protocol
      // violation: the stale checkpoint is abandoned and the turn runs as a new
      // task, so the user still gets an answer instead of a failed turn.
      expect(result.status).toBe('ok')
      expect(restoreResources).not.toHaveBeenCalled()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'abandoned',
        continuationDisposition: 'cancel',
      })
      expect((await runner.sessionManager.read(session.id))
        .some((message) => message.id === turnMessageId(session.id, 'ambiguous-turn'))).toBe(true)
      await expect(runner.replay(conversationTurnRunId(session.id, 'ambiguous-turn')!)).resolves.toMatchObject({
        conversationContinuation: {
          resolution: 'abandoned',
          checkpointId: checkpoint.id,
        },
      })
      await expect(runner.runCheckpoints!.resolveWaitingUserHead(session.id)).resolves.toEqual({ kind: 'none' })
    } finally {
      await runner.shutdown()
    }
  })

  it('resumes a same-task goal revision in the single main loop', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const requests: ChatRequest[] = []
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: queuedLlm([
        textResponse('The original task was revised and the bilingual PDF work is complete.'),
        textResponse('The same task was revised: the bilingual PDF work is complete.'),
      ], requests),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original PDF task.', { sessionId: session.id })
      const request = recoveryRequest('revision-request', 'recover')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'revision-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
        withTaskBook: true,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Revise the same task: make the output bilingual.',
        requestKey: 'revision-turn',
        continuationDirective: 'revise_goal',
      })

      expect(result.status).toBe('ok')
      // The revised goal resumes straight into the one main loop: no planning
      // request, no re-classification and no recovery.
      expect(result.trace[0]?.name).toBe('execute')
      expect(result.trace.map((entry) => entry.name)).not.toContain('classify')
      expect(result.trace.map((entry) => entry.name)).not.toContain('decide')
      expect(result.trace.map((entry) => entry.name)).not.toContain('recover')
      // The revised goal reaches the model as the current user turn, and the
      // persisted plan stays readable as history.
      expect(JSON.stringify(requests[0]?.messages)).toContain('make the output bilingual')
      expect(result.taskBook?.goal).toBe('Complete the original PDF task.')
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        continuationDisposition: 'revise_goal',
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('fails closed on multiple waiting heads before persisting or classifying the turn', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const model = mockLlm(textResponse('unused'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: model,
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Original task.', { sessionId: session.id })
      const request = recoveryRequest('multi-head-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      await runner.infra.runCheckpointStore!.write(waitingCheckpoint({
        id: 'multi-head-a', sessionId: session.id, inboundMessageId: original.id, request, workspace,
      }))
      await runner.infra.runCheckpointStore!.write(waitingCheckpoint({
        id: 'multi-head-b', sessionId: session.id, inboundMessageId: original.id, request, workspace,
      }))

      await expect(runner.run({
        sessionId: session.id,
        text: 'Continue.',
        requestKey: 'multi-head-turn',
      })).rejects.toThrow('multiple waiting tasks require explicit selection')
      expect(model.chat).not.toHaveBeenCalled()
      expect((await runner.sessionManager.read(session.id))
        .some((message) => message.id === turnMessageId(session.id, 'multi-head-turn'))).toBe(false)
      await expect(runner.replay(conversationTurnRunId(session.id, 'multi-head-turn')!)).resolves.toMatchObject({
        status: 'error',
        conversationContinuation: {
          resolution: 'conflict',
          candidateCheckpointIds: ['multi-head-a', 'multi-head-b'],
          failure: { code: 'multiple_waiting_heads', recoverable: true },
        },
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('blocks a legacy attachment checkpoint with a concrete reattach action', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const model = mockLlm(textResponse('unused'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: model,
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Original task with a PDF.', { sessionId: session.id })
      const request = recoveryRequest('legacy-attachment-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'legacy-attachment-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      checkpoint.resumeState!.attachmentCount = 1
      await runner.infra.runCheckpointStore!.write(checkpoint)

      await expect(runner.run({
        sessionId: session.id,
        text: 'Try again.',
        requestKey: 'legacy-attachment-turn',
      })).rejects.toThrow('reattach the missing resources')
      expect(model.chat).not.toHaveBeenCalled()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
      await expect(runner.replay(conversationTurnRunId(session.id, 'legacy-attachment-turn')!)).resolves.toMatchObject({
        conversationContinuation: {
          resolution: 'blocked',
          checkpointId: checkpoint.id,
          resources: { status: 'failed', attachmentCount: 1 },
          failure: { code: 'resource_restore_failed', recoverable: true },
        },
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('re-evaluates a formerly full-access checkpoint under the current restricted policy', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: queuedLlm([
        textResponse('{"kind":"retry","reason":"continue under current policy"}'),
        textResponse('{"plan":[{"description":"continue safely","tools":[]}]}'),
        textResponse('Restricted continuation output.'),
        textResponse('The original task continued under restricted access.'),
        textResponse('{"verdict":"pass","reason":"goal completed under current policy"}'),
        textResponse('{"memories":[],"createSkill":null}'),
        textResponse('{"observations":[]}'),
      ], []),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const original = textMessage('user', 'Complete the original task.', { sessionId: session.id })
      const request = recoveryRequest('permission-downgrade-request')
      await runner.sessionManager.append(session.id, [
        original,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = waitingCheckpoint({
        id: 'permission-downgrade-checkpoint',
        sessionId: session.id,
        inboundMessageId: original.id,
        request,
        workspace,
      })
      checkpoint.resumeState!.permissionPolicyId = 'full'
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Continue under the current restricted policy.',
        requestKey: 'permission-downgrade-turn',
        permissionPolicyId: 'restricted',
        requireApprovalForAllTools: true,
      })

      expect(result.resolvedRunConfig?.permissionPolicyId).toBe('restricted')
      expect(result.conversationContinuation?.permissions).toEqual({
        checkpoint: 'full',
        current: 'restricted',
      })
    } finally {
      await runner.shutdown()
    }
  })
})
