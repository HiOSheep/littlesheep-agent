import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner, ExecutionLog } from '@littlesheep/runner'
import { buildSessionContextUsageRecord, routeSessions, type SessionRouteContext } from './session-routes.js'
import { localAppApiItemPath, LOCAL_APP_API_PREFIXES } from '../../shared/local-app-api-routes.js'

function usageLog(input: {
  sessionId: string
  runId: string
  model: string
  promptTokens: number
  endedAt: string
}): ExecutionLog {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    model: input.model,
    startedAt: input.endedAt,
    endedAt: input.endedAt,
    usage: {
      promptTokens: input.promptTokens,
      completionTokens: 10,
      source: 'provider',
    },
  } as ExecutionLog
}

describe('session context usage history projection', () => {
  it('restores only the newest count belonging to the requested session', () => {
    const record = buildSessionContextUsageRecord([
      usageLog({
        sessionId: 'session-current',
        runId: 'run-old',
        model: 'openai/gpt-5.5',
        promptTokens: 120,
        endedAt: '2026-08-25T09:00:00.000Z',
      }),
      usageLog({
        sessionId: 'session-current',
        runId: 'run-new',
        model: 'openai/gpt-5.5',
        promptTokens: 240,
        endedAt: '2026-08-25T09:02:00.000Z',
      }),
      usageLog({
        sessionId: 'session-other',
        runId: 'run-foreign',
        model: 'openai/gpt-5.5',
        promptTokens: 9_999,
        endedAt: '2026-08-25T09:03:00.000Z',
      }),
    ], 'session-current')

    expect(record).toMatchObject({
      modelRef: 'openai/gpt-5.5',
      usage: { promptTokens: 240 },
    })
  })

  it('does not fabricate a count when the session has no displayable usage', () => {
    expect(buildSessionContextUsageRecord([
      { sessionId: 'session-empty', runId: 'run-empty', startedAt: '2026-08-25T09:00:00.000Z', endedAt: '2026-08-25T09:00:00.000Z' } as ExecutionLog,
    ], 'session-empty')).toBeUndefined()
  })
})

describe('next-mode execution-log replay boundary', () => {
  it('shows a recovered waiting status even when the crash left no assistant message or execution log', async () => {
    const runner = mockReplayRunner(vi.fn().mockResolvedValue({ kind: 'runtime_status', sessionId: 'session-1', runId: 'run-1',
      cursor: 8, settlementId: 'runtime-1', status: 'waiting_user', reason: 'effect_settlement_unknown' }))
    Object.assign(runner, {
      replay: vi.fn().mockResolvedValue(null), durableHarnessModeForRun: async () => 'next',
      sessionManager: { readWindow: async () => ({ messages: [
        { id: 'u', runId: 'run-1', role: 'user', content: [{ type: 'text', text: 'original' }], timestamp: '2026-09-11T00:00:00Z' },
      ], hasMore: false }) },
    })
    const history = await invokeReplay(runner, 'run-1', '/sessions/session-1/messages')
    expect(history.status).toBe(200)
    expect(history.body.messages).toMatchObject([
      { role: 'user', text: 'original' },
      { id: 'run-1:runtime-status', role: 'assistant', text: '', activity: { status: 'waiting_user' } },
    ])
  })
  it('uses the same durable projection for history and run replay after a rollout change', async () => {
    const replay = vi.fn().mockResolvedValue({ kind: 'runtime_status', sessionId: 'session-1', runId: 'run-1',
      cursor: 8, settlementId: 'runtime-1', status: 'waiting_user', reason: 'effect_settlement_unknown' })
    const runner = mockReplayRunner(replay)
    Object.assign(runner, { durableHarnessMode: 'shadow', sessionManager: { readWindow: async () => ({
      messages: [
        { id: 'u', runId: 'run-1', role: 'user', content: [{ type: 'text', text: 'user question' }], timestamp: '2026-09-11T00:00:00Z' },
        { id: 'a', runId: 'run-1', role: 'assistant', stage: 'finalize', content: [{ type: 'text', text: 'unsettled preview' }], timestamp: '2026-09-11T00:00:01Z' },
      ], hasMore: false,
    }) } })
    const run = await invokeReplay(runner, 'run-1')
    const history = await invokeReplay(runner, 'run-1', '/sessions/session-1/messages')
    expect(run.status).toBe(200)
    expect(history.status).toBe(200)
    expect(history.body.messages).toMatchObject([
      { role: 'user', text: 'user question' },
      { role: 'assistant', text: '', activity: { status: 'waiting_user', runtimeStatus: run.body.runtimeStatus } },
    ])
    expect(JSON.stringify(history.body)).not.toContain('unsettled preview')
    expect(replay).toHaveBeenCalledTimes(2)
  })
  it('returns only the durable settled reply from the generic run replay route', async () => {
    const replayDurableFinalReply = vi.fn().mockResolvedValue({
      kind: 'settled',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 8,
      settlementId: 'settlement-1',
      reply: 'durable settled reply',
      replyFingerprint: 'fingerprint-1',
      modelRequestId: 'request-1',
    })
    const runner = mockReplayRunner(replayDurableFinalReply)

    const response = await invokeReplay(runner, 'run-1')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      reply: 'durable settled reply',
      finalReplySettlement: { status: 'settled', settlementId: 'settlement-1' },
    })
    expect(response.body.reply).not.toBe('temporary execution-log reply')
    expect(replayDurableFinalReply).toHaveBeenCalledWith('session-1', 'run-1')
  })

  it('returns Runtime status and no model text when the durable reply is unsettled', async () => {
    const replayDurableFinalReply = vi.fn().mockResolvedValue({
      kind: 'unavailable',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 8,
      status: 'completed',
      reason: 'not_settled',
    })
    const runner = mockReplayRunner(replayDurableFinalReply)

    const response = await invokeReplay(runner, 'run-1')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      reply: '',
      runtimeStatus: { status: 'failed', reason: 'durable_final_reply_not_settled' },
    })
    expect(response.body.finalReplySettlement).toBeUndefined()
    expect(response.body.webEvidence).toBeUndefined()
    expect(JSON.stringify(response.body)).not.toContain('temporary execution-log reply')
  })
})

function mockReplayRunner(
  replayDurableFinalReply: AgentRunner['replayDurableFinalReply'],
): AgentRunner {
  return {
    durableHarnessMode: 'next',
    replay: vi.fn().mockResolvedValue({
      runId: 'run-1',
      durableHarnessMode: 'next',
      sessionId: 'session-1',
      startedAt: '2026-08-25T09:00:00.000Z',
      endedAt: '2026-08-25T09:00:01.000Z',
      status: 'ok',
      model: 'test/model',
      inboundText: 'input',
      reply: 'temporary execution-log reply',
      trace: [],
      toolCalls: [],
      durationMs: 1,
      webEvidence: { secret: 'must be hidden' } as never,
    } satisfies ExecutionLog),
    replayDurableFinalReply,
  } as unknown as AgentRunner
}

async function invokeReplay(
  runner: AgentRunner,
  runId: string,
  path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, runId),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void routeSessions({
      req,
      res,
      url,
      path: url.pathname,
      method: req.method ?? 'GET',
    }, {
      getRunner: () => runner,
      sessionIndex: {} as SessionRouteContext['sessionIndex'],
      projectIndex: {} as SessionRouteContext['projectIndex'],
      archiveIndex: {} as SessionRouteContext['archiveIndex'],
    }).catch((error: unknown) => {
      if (res.writableEnded) return
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  await listen(server)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP address')
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  } finally {
    await close(server)
  }
}

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}
