import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { textMessage, asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { createRunner } from './runner.js'

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
      expect(result.status).toBe('ok')
      expect(result.reply).toBe('continued reply')
      expect(result.sideEffects).toEqual(checkpoint.sideEffects)
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
})
