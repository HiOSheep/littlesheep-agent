import { describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatResponse, LlmClient } from '@littlesheep/llm'
import { asSessionId, type ClarificationRequest, type RunCheckpoint } from '@littlesheep/types'
import { resolveContinuationDisposition } from './continuation-disposition.js'

function llm(content: string): LlmClient {
  const response: ChatResponse = { content, toolCalls: [], finishReason: 'stop' }
  return {
    chat: vi.fn(async (_request: ChatRequest) => response),
    chatStream: vi.fn(),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
}

const request: ClarificationRequest = {
  id: 'request-1',
  kind: 'recovery_decision',
  sourceStage: 'recover',
  createdAt: new Date().toISOString(),
  originalRequest: 'translate the PDF',
  blockingReason: 'permission unavailable',
  questions: [{ id: 'q1', field: 'permission', prompt: 'Enable permission.', required: true }],
}

const checkpoint: RunCheckpoint = {
  version: 1,
  id: 'checkpoint-1',
  runId: 'source-run',
  sessionId: asSessionId('session-1'),
  status: 'waiting_user',
  currentStage: 'finalize',
  taskBookRevision: 0,
  eventCursor: 0,
  pendingEventIds: [],
  contextSnapshotIds: [],
  sideEffects: [],
  loopBudget: {
    attemptsUsed: 0,
    maxAttempts: 8,
    elapsedMs: 0,
    maxElapsedMs: 60_000,
    noProgressRounds: 0,
    maxNoProgressRounds: 2,
  },
  createdAt: new Date().toISOString(),
  reason: 'waiting',
}

describe('continuation disposition', () => {
  it('uses the constrained model enum for a bound retry', async () => {
    await expect(resolveContinuationDisposition({
      llm: llm('{"kind":"retry","reason":"permission changed"}'),
      model: 'test/model',
      checkpoint,
      request,
      answer: 'Permission is enabled; try again.',
    })).resolves.toMatchObject({ kind: 'retry', source: 'model' })
  })

  it('fails closed on invalid model output and honors an explicit control directive', async () => {
    await expect(resolveContinuationDisposition({
      llm: llm('not json'),
      model: 'test/model',
      checkpoint,
      request,
      answer: 'something else',
    })).resolves.toMatchObject({ kind: 'ambiguous', source: 'runtime_fallback' })
    const model = llm('unused')
    await expect(resolveContinuationDisposition({
      llm: model,
      model: 'test/model',
      checkpoint,
      request,
      answer: 'cancel',
      directive: 'cancel',
    })).resolves.toEqual({ kind: 'cancel', source: 'directive' })
    expect(model.chat).not.toHaveBeenCalled()
  })
})
