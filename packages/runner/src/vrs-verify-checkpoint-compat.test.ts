import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  textMessage,
  type AgentTool,
  type ClarificationRequest,
  type RunCheckpoint,
  type SessionId,
  type VerificationRecord,
} from '@littlesheep/types'
import { createRunner } from './runner.js'

const FIXED_TIME = '2026-01-02T03:04:05.000Z'

type CheckpointResumeState = NonNullable<RunCheckpoint['resumeState']>
type FixtureOptions = {
  id: string
  sessionId: SessionId
  inboundMessageId: string
  cwd: string
  status?: RunCheckpoint['status']
  sideEffects?: RunCheckpoint['sideEffects']
  history?: VerificationRecord[]
  lastError?: NonNullable<CheckpointResumeState['lastError']>
  permissionPolicyId?: CheckpointResumeState['permissionPolicyId']
  availableToolNames?: string[]
  sourceStage?: ClarificationRequest['sourceStage']
  requestId?: string
}

function textResponse(content: string): ChatResponse {
  return { content, toolCalls: [], finishReason: 'stop' }
}

function toolCallResponse(name: string, argumentsJson = '{}'): ChatResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{
      id: 'legacy-checkpoint-replay-call',
      type: 'function',
      function: { name, arguments: argumentsJson },
    }],
  }
}

function scriptedLlm(first: ChatResponse | undefined, rest = textResponse('I cannot safely repeat the earlier operation.')): LlmClient {
  let firstPending = first !== undefined
  const next = (): ChatResponse => {
    if (firstPending) {
      firstPending = false
      return first!
    }
    return rest
  }
  const chat = vi.fn(async (_request: ChatRequest) => next())
  const chatStream = vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
    const response = next()
    if (response.content) onDelta({ type: 'delta', delta: response.content })
    onDelta({ type: 'done', finishReason: response.finishReason })
    return response
  })
  return {
    chat,
    chatStream,
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
}

function syntheticHistory(): VerificationRecord[] {
  return [
    { attempt: 1, verdict: 'pass', reason: 'legacy structural result', source: 'structural', verifiedAt: FIXED_TIME },
    { attempt: 2, verdict: 'fail', reason: 'legacy evidence gap', source: 'structural', verifiedAt: FIXED_TIME },
    { attempt: 3, verdict: 'unverified', reason: 'legacy incomplete acceptance', source: 'degraded', verifiedAt: FIXED_TIME },
    { attempt: 4, verdict: 'needs_replan', reason: 'legacy planner result', source: 'model', verifiedAt: FIXED_TIME },
  ]
}

function clarificationRequest(id: string, sourceStage: ClarificationRequest['sourceStage'] = 'verify'): ClarificationRequest {
  return {
    id,
    kind: 'recovery_decision',
    sourceStage,
    createdAt: FIXED_TIME,
    originalRequest: 'Complete the synthetic checkpoint task.',
    blockingReason: 'Legacy permission or evidence state requires an explicit user decision.',
    questions: [{
      id: id + ':question',
      field: 'recoveryDecision',
      prompt: 'Choose whether to retry the synthetic task.',
      required: true,
      options: ['Retry', 'Stop'],
    }],
  }
}

function legacyVerifyCheckpoint(input: FixtureOptions): RunCheckpoint {
  const requestId = input.requestId ?? input.id + ':request'
  return {
    version: 1,
    id: input.id,
    runId: input.id + ':source-run',
    sessionId: input.sessionId,
    status: input.status ?? 'recoverable',
    currentStage: 'verify',
    taskBookRevision: 0,
    eventCursor: 0,
    pendingEventIds: [],
    contextSnapshotIds: [],
    sideEffects: structuredClone(input.sideEffects ?? []),
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
      cwd: input.cwd,
      workspaceContext: { boundaryKind: 'agent_workplace' },
      model: 'test/model',
      origin: 'test',
      permissionPolicyId: input.permissionPolicyId ?? 'restricted',
      reasoning: 'auto',
      behaviorModeId: 'general',
      availableToolNames: input.availableToolNames ?? [],
      attachmentCount: 0,
      ...(input.sourceStage ? {
        continuation: {
          version: 1,
          requestId,
          sourceStage: input.sourceStage,
        },
      } : {}),
      ...(input.lastError ? { lastError: structuredClone(input.lastError) } : {}),
      appliedTaskBookPatchIds: [],
      deferredRuntimeEvents: [],
      recoveryAttempts: 0,
      replanAttempts: 0,
      maxReplanAttempts: 2,
      verificationHistory: structuredClone(input.history ?? []),
    },
    createdAt: FIXED_TIME,
    reason: 'synthetic legacy VERIFY checkpoint fixture',
  }
}

function localMutationTool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    description: 'Synthetic VRS checkpoint compatibility mutation.',
    inputSchema: {
      parse: (input) => input,
      jsonSchema: { type: 'object' },
    },
    execution: {
      concurrency: 'exclusive',
      resources: () => [{ key: 'workspace:vrs-synthetic-proof', mode: 'write' }],
    },
    execute,
  }
}

describe('VRS legacy VERIFY checkpoint continuation', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ls-vrs-verify-checkpoint-'))
    process.env.LITTLESHEEP_DATA_DIR = dataDir
  })

  afterEach(async () => {
    delete process.env.LITTLESHEEP_DATA_DIR
    await rm(dataDir, { recursive: true, force: true })
  })

  it('round-trips historical VERIFY shapes through the persisted version-1 checkpoint codec', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm: scriptedLlm(undefined),
      skillsDirs: [],
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Complete the synthetic checkpoint task.', { sessionId: session.id })
      const request = clarificationRequest('legacy-verify-waiting-request')
      await runner.sessionManager.append(session.id, [
        inbound,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])

      const inputHash = createHash('sha256').update('{}').digest('hex')
      const settled = {
        idempotencyKey: 'tool:synthetic_write:' + inputHash,
        inputHash,
        toolName: 'synthetic_write',
        status: 'succeeded' as const,
        stepId: 'legacy-step',
        callId: 'legacy-effect-call',
        resourceKeys: ['workspace:vrs-synthetic-proof'],
        effectKind: 'local_mutation' as const,
        startedAt: FIXED_TIME,
        endedAt: FIXED_TIME,
        evidenceRef: 'tool:legacy-effect-call',
      }
      const unknown = {
        idempotencyKey: 'tool:synthetic_write:unknown',
        inputHash: 'b'.repeat(64),
        toolName: 'synthetic_write',
        status: 'unknown' as const,
        callId: 'legacy-unknown-call',
        effectKind: 'unknown' as const,
        startedAt: FIXED_TIME,
      }
      const history = syntheticHistory()
      const fixtures = [
        legacyVerifyCheckpoint({
          id: 'legacy-verify-settled-no-last-error',
          sessionId: session.id,
          inboundMessageId: inbound.id,
          cwd: workspace,
          sideEffects: [settled],
          history: [],
        }),
        legacyVerifyCheckpoint({
          id: 'legacy-verify-unknown-with-gap',
          sessionId: session.id,
          inboundMessageId: inbound.id,
          cwd: workspace,
          sideEffects: [unknown],
          history: [history[1]!],
          lastError: { stage: 'verify', message: 'Recorded step evidence is incomplete.' },
        }),
        legacyVerifyCheckpoint({
          id: 'legacy-verify-waiting-approval',
          sessionId: session.id,
          inboundMessageId: inbound.id,
          cwd: workspace,
          status: 'waiting_user',
          permissionPolicyId: 'full',
          history,
          sourceStage: 'verify',
          requestId: request.id,
        }),
      ]

      for (const fixture of fixtures) {
        const written = await runner.infra.runCheckpointStore!.write(fixture)
        expect(written.kind).toBe('written')
        const decoded = await runner.infra.runCheckpointStore!.read(fixture.id)
        expect(decoded).not.toBeNull()
        expect(decoded?.version).toBe(1)
        expect(decoded?.currentStage).toBe('verify')
        expect(decoded?.status).toBe(fixture.status)
        expect(decoded?.sideEffects).toEqual(fixture.sideEffects)
        expect(decoded?.resumeState?.verificationHistory).toEqual(fixture.resumeState?.verificationHistory)
        expect(decoded?.resumeState?.lastError).toEqual(fixture.resumeState?.lastError)
        expect(decoded?.resumeState?.continuation).toEqual(fixture.resumeState?.continuation)
        expect(decoded?.resumeState?.replanAttempts).toBe(fixture.resumeState?.replanAttempts)
        expect(decoded?.resumeState?.maxReplanAttempts).toBe(fixture.resumeState?.maxReplanAttempts)
        expect(decoded).not.toHaveProperty('toolInvocations')
        expect(decoded).not.toHaveProperty('toolResults')
        expect(decoded).not.toHaveProperty('reply')
      }
    } finally {
      await runner.shutdown()
    }
  })

  it('re-enters safe recovery for a legacy verify checkpoint with missing evidence and does not replay its settled effect', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const toolName = 'synthetic_write'
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'unexpected duplicate mutation' }))
    const effectTool = localMutationTool(toolName, executeEffect)
    const llm = scriptedLlm(toolCallResponse(toolName), textResponse('The earlier mutation is already settled, so I will report the current state.'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
      approve: async () => true,
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Write the synthetic marker once.', { sessionId: session.id })
      await runner.sessionManager.append(session.id, [inbound])
      const inputHash = createHash('sha256').update('{}').digest('hex')
      const settled = {
        idempotencyKey: 'tool:' + toolName + ':' + inputHash,
        inputHash,
        toolName,
        status: 'succeeded' as const,
        callId: 'legacy-settled-call',
        resourceKeys: ['workspace:vrs-synthetic-proof'],
        effectKind: 'local_mutation' as const,
        startedAt: FIXED_TIME,
        endedAt: FIXED_TIME,
        evidenceRef: 'tool:legacy-settled-call',
      }
      const checkpoint = legacyVerifyCheckpoint({
        id: 'legacy-verify-settled-resume',
        sessionId: session.id,
        inboundMessageId: inbound.id,
        cwd: workspace,
        sideEffects: [settled],
        availableToolNames: [toolName],
        // Old restores clear this field; the absent invocation/result/reply are
        // still authoritative evidence gaps when VERIFY runs again.
        lastError: { stage: 'verify', message: 'Recorded step evidence is incomplete.' },
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)
      const decoded = await runner.infra.runCheckpointStore!.read(checkpoint.id)
      expect(decoded?.currentStage).toBe('verify')
      expect(decoded).not.toHaveProperty('toolInvocations')
      expect(decoded).not.toHaveProperty('toolResults')
      expect(decoded).not.toHaveProperty('reply')

      const events: Array<{ type?: string }> = []
      const result = await runner.resumeCheckpoint!(checkpoint.id, {
        permissionPolicyId: 'full',
        additionalTools: [effectTool],
        onToolEvent: (event) => events.push(event),
      })

      const stageNames = result.trace.map((entry) => entry.name)
      expect(stageNames[0]).toBe('recover')
      expect(stageNames).not.toContain('verify')
      expect(stageNames).toContain('recover')
      expect(stageNames).toContain('execute')
      expect(events.some((event) => event.type === 'verification_start')).toBe(false)
      expect(result.toolInvocations?.some((record) => (
        record.toolName === toolName && record.status === 'repeated_call_blocked'
      ))).toBe(true)
      expect(executeEffect).not.toHaveBeenCalled()
      expect(result.sideEffects).toEqual([settled])
      expect(result.verificationHistory?.some((record) => record.verdict === 'pass')).toBe(false)
      expect(result.status).toBe('ok')
    } finally {
      await runner.shutdown()
    }
  })

  it('escalates a repeated evidence gap from an old VERIFY checkpoint instead of accepting it', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const llm = scriptedLlm(undefined, textResponse('The earlier execution cannot be proven from this checkpoint.'))
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Continue the synthetic task from its old evidence gap.', { sessionId: session.id })
      await runner.sessionManager.append(session.id, [inbound])
      const history = [syntheticHistory()[1]!]
      const checkpoint = legacyVerifyCheckpoint({
        id: 'legacy-verify-gap-escalation',
        sessionId: session.id,
        inboundMessageId: inbound.id,
        cwd: workspace,
        history,
        // The older record has no resumable execution context or lastError.
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const events: Array<{ type?: string }> = []
      const result = await runner.resumeCheckpoint!(checkpoint.id, {
        onToolEvent: (event) => events.push(event),
      })
      const stageNames = result.trace.map((entry) => entry.name)

      expect(stageNames[0]).toBe('recover')
      expect(stageNames).not.toContain('verify')
      expect(stageNames.indexOf('ask_user')).toBeGreaterThan(stageNames.indexOf('recover'))
      expect(stageNames.indexOf('finalize')).toBeGreaterThan(stageNames.indexOf('ask_user'))
      expect(events.some((event) => event.type === 'verification_start')).toBe(false)
      expect(result.verificationHistory?.[0]).toEqual(history[0])
      expect(result.verificationHistory?.slice(1).some((record) => record.verdict === 'fail')).toBe(true)
      expect(result.verificationHistory?.slice(1).some((record) => record.verdict === 'pass')).toBe(false)
      const clarification = (await runner.sessionManager.read(session.id))
        .find((message) => message.role === 'assistant' && message.clarificationRequest)
      expect(clarification?.clarificationRequest?.sourceStage).toBe('recover')
      expect(result.status).toBe('ok')
    } finally {
      await runner.shutdown()
    }
  })

  it('fails closed before model or tool execution when an old VERIFY checkpoint contains an unknown effect', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const llm = scriptedLlm(undefined)
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'must not execute' }))
    const tool = localMutationTool('synthetic_write', executeEffect)
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Inspect the synthetic unknown-effect checkpoint.', { sessionId: session.id })
      await runner.sessionManager.append(session.id, [inbound])
      const checkpoint = legacyVerifyCheckpoint({
        id: 'legacy-verify-unknown-resume',
        sessionId: session.id,
        inboundMessageId: inbound.id,
        cwd: workspace,
        sideEffects: [{
          idempotencyKey: 'tool:synthetic_write:unknown',
          inputHash: 'c'.repeat(64),
          toolName: 'synthetic_write',
          status: 'unknown',
          callId: 'legacy-unknown-call',
          effectKind: 'external',
          startedAt: FIXED_TIME,
        }],
        availableToolNames: ['synthetic_write'],
        lastError: { stage: 'verify', message: 'Legacy verify did not finish settlement.' },
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      await expect(runner.resumeCheckpoint!(checkpoint.id, {
        additionalTools: [tool],
      })).rejects.toThrow('without verified completion evidence')
      expect(llm.chat).not.toHaveBeenCalled()
      expect(llm.chatStream).not.toHaveBeenCalled()
      expect(executeEffect).not.toHaveBeenCalled()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toBeNull()
    } finally {
      await runner.shutdown()
    }
  })

  it('preserves verify-source waiting and historical verdicts while rechecking approval under current policy', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const toolName = 'synthetic_write'
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'must remain denied' }))
    const tool = localMutationTool(toolName, executeEffect)
    const llm = scriptedLlm(toolCallResponse(toolName), textResponse('I cannot perform that operation without current approval.'))
    const approve = vi.fn(async () => false)
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Perform the synthetic operation only with permission.', { sessionId: session.id })
      const request = clarificationRequest('legacy-verify-permission-request')
      await runner.sessionManager.append(session.id, [
        inbound,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const history = syntheticHistory()
      const checkpoint = legacyVerifyCheckpoint({
        id: 'legacy-verify-waiting-permission-resume',
        sessionId: session.id,
        inboundMessageId: inbound.id,
        cwd: workspace,
        status: 'waiting_user',
        permissionPolicyId: 'full',
        availableToolNames: [toolName],
        history,
        lastError: { stage: 'verify', message: 'Legacy approval is still required.' },
        sourceStage: 'verify',
        requestId: request.id,
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Retry after the old permission prompt.',
        requestKey: 'legacy-verify-permission-answer',
        continuationDirective: 'retry',
        permissionPolicyId: 'restricted',
        requireApprovalForAllTools: true,
        approve,
        additionalTools: [tool],
      })

      expect(result.conversationContinuation?.resumeRule).toBe('verify->recover')
      expect(result.conversationContinuation?.resumeStage).toBe('recover')
      expect(result.conversationContinuation?.permissions).toEqual({
        checkpoint: 'full',
        current: 'restricted',
      })
      expect(result.trace[0]?.name).toBe('recover')
      expect(result.trace.map((entry) => entry.name)).not.toContain('verify')
      expect(approve).toHaveBeenCalled()
      expect(executeEffect).not.toHaveBeenCalled()
      expect(result.toolInvocations?.some((record) => (
        record.toolName === toolName && (
          record.status === 'approval_denied'
          || record.status === 'hard_denied'
          || record.status === 'approval_unavailable'
        )
      ))).toBe(true)
      expect(result.verificationHistory?.slice(0, history.length)).toEqual(history)
      expect(result.verificationHistory?.slice(history.length).some((record) => record.verdict === 'pass')).toBe(false)
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'resumed',
        continuationDisposition: 'retry',
      })
    } finally {
      await runner.shutdown()
    }
  })

  it('honors cancellation of a legacy verify-source waiting checkpoint without entering execute', async () => {
    const workspace = join(dataDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const llm = scriptedLlm(undefined, textResponse('The old task is cancelled.'))
    const executeEffect = vi.fn(async () => ({ callId: '', ok: true, output: 'must not execute' }))
    const tool = localMutationTool('synthetic_write', executeEffect)
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'test/model',
      llm,
      skillsDirs: [],
      containerRoot: dataDir,
    })
    try {
      const session = await runner.sessionManager.create('test/model')
      const inbound = textMessage('user', 'Cancel the synthetic task.', { sessionId: session.id })
      const request = clarificationRequest('legacy-verify-cancel-request')
      await runner.sessionManager.append(session.id, [
        inbound,
        textMessage('assistant', request.questions[0]!.prompt, {
          sessionId: session.id,
          clarificationRequest: request,
        }),
      ])
      const checkpoint = legacyVerifyCheckpoint({
        id: 'legacy-verify-waiting-cancel',
        sessionId: session.id,
        inboundMessageId: inbound.id,
        cwd: workspace,
        status: 'waiting_user',
        sourceStage: 'verify',
        requestId: request.id,
        availableToolNames: ['synthetic_write'],
      })
      await runner.infra.runCheckpointStore!.write(checkpoint)

      const result = await runner.run({
        sessionId: session.id,
        text: 'Stop the task.',
        requestKey: 'legacy-verify-cancel-answer',
        continuationDirective: 'cancel',
        additionalTools: [tool],
      })

      expect(result.conversationContinuation?.resumeRule).toBe('cancel->reply')
      expect(result.trace.map((entry) => entry.name)).toEqual(['reply', 'finalize'])
      expect(result.trace.map((entry) => entry.name)).not.toContain('verify')
      expect(result.trace.map((entry) => entry.name)).not.toContain('execute')
      expect(executeEffect).not.toHaveBeenCalled()
      expect(await runner.infra.runCheckpointDispositionStore.read(checkpoint.id)).toMatchObject({
        status: 'abandoned',
        continuationDisposition: 'cancel',
      })
    } finally {
      await runner.shutdown()
    }
  })
})
