import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner, ExecutionLog } from '@littlesheep/runner'
import { SessionIndex } from '../session-index.js'
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
  it('sums the session cache reuse over every run, counting only reported usage', () => {
    const log = (runId: string, endedAt: string, usage: Partial<NonNullable<ExecutionLog['usage']>> | undefined) => ({
      sessionId: 'session-cache',
      runId,
      model: 'deepseek/deepseek-flash',
      startedAt: endedAt,
      endedAt,
      ...(usage === undefined ? {} : { usage: { completionTokens: 1, source: 'provider' as const, ...usage } }),
    }) as ExecutionLog

    const record = buildSessionContextUsageRecord([
      // Run 1: the cold start — 1,000 prompt tokens, only 100 cached.
      log('run-1', '2026-09-22T01:00:00.000Z', {
        promptTokens: 1_000, cachedPromptTokens: 100, uncachedPromptTokens: 900,
        requestCount: 1, usageReportedRequestCount: 1,
      }),
      // Run 2: nearly everything cached.
      log('run-2', '2026-09-22T01:01:00.000Z', {
        promptTokens: 4_000, cachedPromptTokens: 3_800, uncachedPromptTokens: 200,
        requestCount: 2, usageReportedRequestCount: 2,
      }),
      // A later run whose usage never arrived: counted as missing, not as a miss.
      log('run-3', '2026-09-22T01:02:00.000Z', undefined),
      // Another session must not leak into this one.
      {
        sessionId: 'session-other', runId: 'run-x', model: 'deepseek/deepseek-flash',
        startedAt: '2026-09-22T01:03:00.000Z', endedAt: '2026-09-22T01:03:00.000Z',
        usage: { promptTokens: 9_999, cachedPromptTokens: 9_999, completionTokens: 1, source: 'provider' },
      } as ExecutionLog,
    ], 'session-cache')

    // 4,800 / 5,000 — the same provider fields the acceptance ledger judges.
    expect(record?.sessionCache).toMatchObject({
      inputTokens: 5_000,
      cachedTokens: 3_900,
      uncachedTokens: 1_100,
      measuredRequests: 3,
      requestsWithoutUsage: 0,
    })
    expect(record?.sessionCache?.hitPercent).toBeCloseTo(78, 6)
    expect(JSON.stringify(record)).not.toContain('9999')
  })

  it('keeps a partial session labelled instead of presenting it as complete', () => {
    const record = buildSessionContextUsageRecord([{
      sessionId: 'session-partial', runId: 'run-1', model: 'deepseek/deepseek-flash',
      startedAt: '2026-09-22T02:00:00.000Z', endedAt: '2026-09-22T02:00:00.000Z',
      usage: {
        promptTokens: 2_000, cachedPromptTokens: 1_000, uncachedPromptTokens: 1_000,
        requestCount: 3, usageReportedRequestCount: 1, source: 'provider',
      },
    } as ExecutionLog], 'session-partial')

    expect(record?.sessionCache).toMatchObject({
      inputTokens: 2_000,
      cachedTokens: 1_000,
      measuredRequests: 1,
      requestsWithoutUsage: 2,
    })
    expect(record?.sessionCache?.hitPercent).toBeCloseTo(50, 6)
  });

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

describe('compaction operation history projection', () => {
  it('projects durable compaction operation history for one session', async () => {
    const runner = mockReplayRunner(vi.fn())
    Object.assign(runner, {
      compactionOperationHistory: vi.fn().mockResolvedValue([{
        id: 'operation-1',
        sessionId: 'session-1',
        force: false,
        createdAt: '2026-09-16T00:00:00.000Z',
        status: 'completed',
        result: 'compacted',
        coalescedRequests: 0,
        usage: { requestCount: 1, usageStatus: 'unavailable' },
      }]),
    })

    const response = await invokeReplay(runner, 'unused', '/sessions/session-1/compaction-operations')

    expect(response.status).toBe(200)
    expect(response.body.operations).toMatchObject([{
      id: 'operation-1',
      sessionId: 'session-1',
      status: 'completed',
      result: 'compacted',
    }])
  })

  it('carries bounded compaction operation history in the session message page', async () => {
    const runner = mockReplayRunner(vi.fn())
    Object.assign(runner, {
      sessionManager: { readWindow: async () => ({ messages: [], hasMore: false }) },
      compactionOperationHistory: vi.fn().mockResolvedValue([{
        id: 'operation-page',
        sessionId: 'session-1',
        force: false,
        createdAt: '2026-09-16T00:00:00.000Z',
        status: 'completed',
        result: 'no-new-range',
        coalescedRequests: 0,
      }]),
    })

    const response = await invokeReplay(runner, 'unused', '/sessions/session-1/messages')

    expect(response.status).toBe(200)
    expect(response.body.compactionOperations).toMatchObject([{ id: 'operation-page', result: 'no-new-range' }])
  })

  it('reports unavailable history instead of fabricating an empty list', async () => {
    const runner = mockReplayRunner(vi.fn())
    const response = await invokeReplay(runner, 'unused', '/sessions/session-1/compaction-operations')
    expect(response.status).toBe(503)
    expect(response.body.error).toContain('unavailable')
  })
})

function mockReplayRunner(
  replayDurableFinalReply: AgentRunner['replayDurableFinalReply'],
): AgentRunner {  return {
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

// CE-02: a project session runs where its project is, so the saved default cannot
// move it. This PATCH is the deliberate switch, and it is the only thing that may
// write a session's own directory while that session has a project.
describe('explicit session workspace switch', () => {
  async function patchSession(
    sessionIndex: SessionIndex,
    sessionId: string,
    body: Record<string, unknown>,
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
        getRunner: () => ({}) as AgentRunner,
        sessionIndex,
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
      const response = await fetch(
        `http://127.0.0.1:${address.port}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, sessionId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    } finally {
      await close(server)
    }
  }

  async function projectSession(dataDir: string): Promise<SessionIndex> {
    const workplaceDir = join(dataDir, 'workplace')
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    mkdirSync(join(dataDir, 'alpha'), { recursive: true })
    mkdirSync(join(dataDir, 'moved'), { recursive: true })
    await sessionIndex.upsert('session-project', {
      title: 'Alpha',
      mode: 'research',
      scope: 'project',
      projectId: 'project-alpha',
      workspacePath: join(dataDir, 'alpha'),
    })
    return sessionIndex
  }

  it('moves one project session to the directory the user picked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-session-workspace-'))
    try {
      const sessionIndex = await projectSession(dataDir)
      const moved = join(dataDir, 'moved')

      const response = await patchSession(sessionIndex, 'session-project', { workspacePath: moved })

      expect(response.status).toBe(200)
      expect(response.body.session).toMatchObject({ id: 'session-project', workspacePath: moved })
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-project', workspacePath: moved }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses a directory that does not exist instead of recording it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-session-workspace-'))
    try {
      const sessionIndex = await projectSession(dataDir)
      const missing = join(dataDir, 'not-here')

      const response = await patchSession(sessionIndex, 'session-project', { workspacePath: missing })

      expect(response.status).toBe(400)
      expect(String(response.body.error)).toContain('not an existing directory')
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ workspacePath: join(dataDir, 'alpha') }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('refuses a relative path and a session that has no workspace of its own', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-session-workspace-'))
    try {
      const sessionIndex = await projectSession(dataDir)
      await sessionIndex.upsert('session-standalone', { title: 'Chat', mode: 'research', scope: 'standalone' })

      const relative = await patchSession(sessionIndex, 'session-project', { workspacePath: 'moved' })
      expect(relative.status).toBe(400)
      expect(String(relative.body.error)).toContain('must be absolute')

      const standalone = await patchSession(sessionIndex, 'session-standalone', {
        workspacePath: join(dataDir, 'moved'),
      })
      expect(standalone.status).toBe(400)
      expect(String(standalone.body.error)).toContain('only a project session')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
