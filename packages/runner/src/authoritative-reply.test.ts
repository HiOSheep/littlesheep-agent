import { describe, expect, it, vi } from 'vitest'
import { asSessionId, type DurableFinalReplyReplay } from '@littlesheep/types'
import type { AgentRunner, RunnerResult } from './runner.js'
import {
  prepareAuthoritativeExecutionLog,
  prepareAuthoritativeRunnerResult,
} from './authoritative-reply.js'
import type { ExecutionLog } from './execution-log.js'

function result(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    status: 'ok',
    reply: 'temporary model reply',
    messages: [{
      id: 'proposal',
      role: 'assistant',
      stage: 'finalize',
      content: [{ type: 'text', text: 'temporary model reply' }],
      timestamp: new Date(0).toISOString(),
    }],
    trace: [],
    durationMs: 1,
    ...overrides,
  }
}

function nextRunner(replay: AgentRunner['replayDurableFinalReply']): AgentRunner {
  return { durableHarnessMode: 'next', replayDurableFinalReply: replay } as AgentRunner
}

function executionLog(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    status: 'ok',
    model: 'test/model',
    inboundText: 'input',
    reply: 'temporary model reply',
    trace: [],
    toolCalls: [],
    durationMs: 1,
    ...overrides,
  }
}

describe('prepareAuthoritativeRunnerResult', () => {
  it('uses the settled durable reply instead of a temporary result reply', async () => {
    const prepared = await prepareAuthoritativeRunnerResult(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => ({
      kind: 'settled',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 9,
      settlementId: 'settlement-1',
      reply: 'durable final reply',
      replyFingerprint: 'fingerprint',
      modelRequestId: 'model-request-1',
    }))), result())

    expect(prepared.status).toBe('ok')
    expect(prepared.reply).toBe('durable final reply')
    expect(prepared.finalReplySettlement).toMatchObject({
      settlementId: 'settlement-1',
      status: 'settled',
      reply: 'durable final reply',
    })
    expect(prepared.messages[0]?.finalReplySettlement).toMatchObject({
      settlementId: 'settlement-1',
      status: 'settled',
    })
  })

  it('does not publish a proposal or its model text when replay is unavailable', async () => {
    const prepared = await prepareAuthoritativeRunnerResult(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => ({
      kind: 'unavailable',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 4,
      status: 'completed',
      reason: 'not_settled',
    }))), result())

    expect(prepared.status).toBe('error')
    expect(prepared.reply).toBe('')
    expect(prepared.finalReplySettlement).toBeUndefined()
    expect(prepared.runtimeStatus).toMatchObject({ status: 'failed' })
    expect(prepared.messages).toEqual([])
    expect(prepared.error).not.toContain('temporary model reply')
  })

  it('converts a durable waiting-user status into Runtime-owned status', async () => {
    const prepared = await prepareAuthoritativeRunnerResult(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => ({
      kind: 'runtime_status',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 6,
      settlementId: 'runtime-status-1',
      status: 'waiting_user',
      reason: 'effect_settlement_unknown',
    }))), result())

    expect(prepared.status).toBe('error')
    expect(prepared.runtimeStatus).toEqual({
      version: 1,
      status: 'waiting_user',
      reason: 'effect_settlement_unknown',
    })
    expect(prepared.reply).toBe('')
  })

  it('keeps legacy and shadow results unchanged', async () => {
    const original = result()
    expect(await prepareAuthoritativeRunnerResult({} as AgentRunner, original)).toBe(original)
  })

  it('fails closed when durable replay throws', async () => {
    const prepared = await prepareAuthoritativeRunnerResult(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => {
      throw new Error('private durable store detail')
    })), result())

    expect(prepared.status).toBe('error')
    expect(prepared.reply).toBe('')
    expect(prepared.error).not.toContain('private durable store detail')
    expect(prepared.runtimeStatus?.reason).toBe('durable_final_reply_replay_failed')
  })

  it('applies the durable boundary to execution-log replay', async () => {
    const prepared = await prepareAuthoritativeExecutionLog(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => ({
      kind: 'settled',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 9,
      settlementId: 'settlement-1',
      reply: 'durable diagnostic reply',
      replyFingerprint: 'fingerprint',
      modelRequestId: 'model-request-1',
    }))), executionLog())

    expect(prepared.reply).toBe('durable diagnostic reply')
    expect(prepared.finalReplySettlement).toMatchObject({ status: 'settled' })
    expect(prepared.runtimeStatus).toBeUndefined()
  })

  it('hides an unconfirmed execution-log proposal from next-mode replay', async () => {
    const prepared = await prepareAuthoritativeExecutionLog(nextRunner(vi.fn(async (): Promise<DurableFinalReplyReplay> => ({
      kind: 'unavailable',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 4,
      status: 'completed',
      reason: 'not_settled',
    }))), executionLog())

    expect(prepared.reply).toBe('')
    expect(prepared.runtimeStatus).toMatchObject({ status: 'failed' })
    expect(prepared.error).not.toContain('temporary model reply')
  })
})
