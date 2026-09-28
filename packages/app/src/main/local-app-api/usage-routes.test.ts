// O5 HTTP evidence: the bounded Local App API contract for daily usage.
//
// The route is exercised over a real loopback HTTP server against a real
// durable event store written into a temporary data root, so the assertions
// cover the wire shape a UI package will consume, not an internal call.
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableEventStore, type AgentRunner } from '@littlesheep/runner'
import type { ProviderUsageDailySeries } from '@littlesheep/types'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { ArchiveIndex } from '../archive-index.js'
import { SessionIndex } from '../session-index.js'
import { routeUsage, type UsageRouteContext } from './usage-routes.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ls-usage-routes-'))
  roots.push(root)
  return root
}

interface Fixture {
  readonly root: string
  readonly store: DurableEventStore
  readonly context: UsageRouteContext
  /** Flipped to simulate the Runtime still starting. */
  runnerReady: boolean
}

async function fixture(): Promise<Fixture> {
  const root = newRoot()
  const store = new DurableEventStore({ rootDir: join(root, 'durable-events') })
  const sessionIndex = new SessionIndex({ dataDir: root })
  await sessionIndex.upsert('session-known', {
    title: 'known',
    createdAt: 1,
    lastMessageAt: 1,
    mode: 'limited',
    scope: 'standalone',
  })
  const state = { runnerReady: true }
  const runner = { infra: { durableEventStore: store } } as unknown as AgentRunner
  const context: UsageRouteContext = {
    getRunner: () => (state.runnerReady ? runner : undefined),
    dataDir: root,
    sessionIndex,
    archiveIndex: new ArchiveIndex({ dataDir: root }),
  }
  return {
    root,
    store,
    context,
    get runnerReady() { return state.runnerReady },
    set runnerReady(value: boolean) { state.runnerReady = value },
  }
}

/** One run with one provider attempt, written through the real event store. */
async function appendAttempt(
  store: DurableEventStore,
  input: {
    sessionId: string
    runId: string
    requestId: string
    at: string
    prompt: number
    completion: number
    provider?: string
    model?: string
  },
): Promise<void> {
  const identity = { sessionId: input.sessionId, runId: input.runId }
  const provider = input.provider ?? 'deepseek'
  const model = input.model ?? 'deepseek-chat'
  await store.append({
    ...identity,
    eventId: `${input.runId}:run-accepted`,
    idempotencyKey: `${input.runId}:run-accepted`,
    type: 'run_accepted',
    source: 'runtime',
    occurredAt: input.at,
    payload: { origin: 'app', model, durableHarnessMode: 'next' },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.requestId}:started`,
    idempotencyKey: `${input.runId}:model-request:${input.requestId}:started`,
    type: 'model_request_started',
    source: 'runtime',
    occurredAt: input.at,
    payload: { requestId: input.requestId, provider, model, stage: 'execute', requestIndex: 1 },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.requestId}:response`,
    idempotencyKey: `${input.runId}:model-request:${input.requestId}:response`,
    type: 'model_response_received',
    source: 'runtime',
    occurredAt: input.at,
    payload: {
      requestId: input.requestId,
      provider,
      model,
      transportStatus: 'completed',
      providerReachStatus: 'reached',
      cacheStatus: 'partial',
      reconciliation: 'unavailable',
      usageStatus: 'available',
      promptTokens: input.prompt,
      completionTokens: input.completion,
      totalTokens: input.prompt + input.completion,
    },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.requestId}:settled`,
    idempotencyKey: `${input.runId}:model-request:${input.requestId}:settled`,
    type: 'model_request_settled',
    source: 'runtime',
    occurredAt: input.at,
    payload: { requestId: input.requestId, status: 'received', usageStatus: 'available' },
  })
}

async function call(
  context: UsageRouteContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void routeUsage({ req, res, url, path: url.pathname, method: req.method ?? 'GET' }, context)
      .catch((error: unknown) => {
        const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
        if (res.headersSent) return res.end()
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
  })
  await listen(server)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test port')
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) as Record<string, unknown> : {},
    }
  } finally {
    await close(server)
  }
}

async function daily(
  context: UsageRouteContext,
  query: string,
): Promise<{ status: number; series: ProviderUsageDailySeries }> {
  const result = await call(context, `${LOCAL_APP_API_ROUTES.usageDaily}?${query}`)
  return { status: result.status, series: result.body as unknown as ProviderUsageDailySeries }
}

describe('daily usage API', () => {
  it('serves an explicit-timezone, explicitly bounded series after a refresh', async () => {
    const app = await fixture()
    await appendAttempt(app.store, {
      sessionId: 'session-known',
      runId: 'run-1',
      requestId: 'req-1',
      at: '2026-09-10T02:00:00.000Z',
      prompt: 300,
      completion: 40,
    })
    await appendAttempt(app.store, {
      sessionId: 'session-gone',
      runId: 'run-2',
      requestId: 'req-2',
      at: '2026-09-10T03:00:00.000Z',
      prompt: 100,
      completion: 10,
      provider: 'openai',
      model: 'gpt-x',
    })

    // Before any refresh the projection is honestly empty, not zero-filled.
    const cold = await daily(app.context, 'from=2026-09-10&to=2026-09-10&timezone=Asia/Shanghai')
    expect(cold.status).toBe(200)
    expect(cold.series.coverage.projectionBuilt).toBe(false)
    expect(cold.series.days[0]).toMatchObject({ state: 'empty', requests: 0 })
    expect(cold.series.coverage.statement).toContain('尚未建立用量投影')

    const refreshed = await call(app.context, LOCAL_APP_API_ROUTES.usageRefresh, {
      method: 'POST',
      body: { budget: 64 },
    })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.progress).toMatchObject({ status: 'complete', partitions: 2, indexed: 2 })

    const series = (await daily(app.context, 'from=2026-09-10&to=2026-09-10&timezone=Asia/Shanghai')).series
    expect(series).toMatchObject({
      version: 1,
      timezone: 'Asia/Shanghai',
      range: { from: '2026-09-10', to: '2026-09-10', days: 1 },
      bounds: { maxRangeDays: 400, maxIdentities: 64, identitiesTruncated: false },
      filters: {},
    })
    // Totals are computed by the backend: a consumer never re-adds days.
    expect(series.totals).toMatchObject({ total: 450, input: 400, output: 50, requests: 2, activeDays: 1 })
    expect(series.totals.peak).toEqual({ date: '2026-09-10', total: 450 })
    expect(series.identities.providers.map((entry) => entry.id).sort()).toEqual(['deepseek', 'openai'])
    expect(series.days[0]).toMatchObject({ state: 'recorded', requests: 2, total: 450 })
    expect(series.coverage).toMatchObject({
      timezoneSource: 'request',
      indexedRuns: 2,
      indexedSessions: 2,
      attempts: 2,
      // One usage row belongs to a session the index no longer knows.
      retainedAfterDeleteSessions: 1,
    })
    expect(series.coverage.statement).toContain('统计时区 Asia/Shanghai')
    expect(typeof series.coverage.updatedAt).toBe('string')
  })

  it('filters by recorded provider and model identity only', async () => {
    const app = await fixture()
    await appendAttempt(app.store, {
      sessionId: 'session-known', runId: 'run-1', requestId: 'req-1',
      at: '2026-09-11T02:00:00.000Z', prompt: 100, completion: 10,
    })
    await appendAttempt(app.store, {
      sessionId: 'session-known', runId: 'run-2', requestId: 'req-2',
      at: '2026-09-11T03:00:00.000Z', prompt: 200, completion: 20,
      provider: 'openai', model: 'gpt-x',
    })
    await call(app.context, LOCAL_APP_API_ROUTES.usageRefresh, { method: 'POST', body: { budget: 64 } })

    const filtered = await daily(
      app.context,
      'from=2026-09-11&to=2026-09-11&timezone=UTC&provider=openai&model=gpt-x',
    )
    expect(filtered.series.filters).toEqual({ provider: 'openai', model: 'gpt-x' })
    expect(filtered.series.totals).toMatchObject({ requests: 1, total: 220 })
    expect(filtered.series.identities.providers).toEqual([{ id: 'openai', requests: 1, total: 220 }])

    const unknown = await daily(app.context, 'from=2026-09-11&to=2026-09-11&provider=nobody')
    expect(unknown.series.totals.requests).toBe(0)
    expect(unknown.series.days[0]).toMatchObject({ state: 'empty' })
  })

  it('rejects unbounded or malformed requests instead of truncating them', async () => {
    const app = await fixture()
    const tooLong = await call(
      app.context,
      `${LOCAL_APP_API_ROUTES.usageDaily}?from=2020-01-01&to=2026-09-27&timezone=UTC`,
    )
    expect(tooLong.status).toBe(400)
    expect(String(tooLong.body.error)).toContain('400 days')

    expect((await call(app.context, `${LOCAL_APP_API_ROUTES.usageDaily}?timezone=Mars/Olympus`)).status).toBe(400)
    expect((await call(app.context, `${LOCAL_APP_API_ROUTES.usageDaily}?from=2026-09-01`)).status).toBe(400)
    expect((await call(app.context, `${LOCAL_APP_API_ROUTES.usageDaily}?from=2026-09-31&to=2026-10-01`)).status).toBe(400)
    expect((await call(app.context, `${LOCAL_APP_API_ROUTES.usageDaily}?from=2026-10-02&to=2026-10-01`)).status).toBe(400)

    // The default range is the heatmap's "last year", and it is bounded too.
    const fallback = await daily(app.context, 'timezone=UTC')
    expect(fallback.status).toBe(200)
    expect(fallback.series.range.days).toBe(366)
    expect(fallback.series.days.length).toBeLessThanOrEqual(400)
    expect(fallback.series.coverage.timezoneSource).toBe('request')

    const clear = await call(app.context, LOCAL_APP_API_ROUTES.usageClear, {
      method: 'POST',
      body: { through: 'not-a-time' },
    })
    expect(clear.status).toBe(400)
    const badBackfill = await call(app.context, LOCAL_APP_API_ROUTES.usageBackfill, {
      method: 'POST',
      body: { action: 'restart' },
    })
    expect(badBackfill.status).toBe(400)
  })

  it('keeps the projection readable while the Runtime is still starting', async () => {
    const app = await fixture()
    await appendAttempt(app.store, {
      sessionId: 'session-known', runId: 'run-1', requestId: 'req-1',
      at: '2026-09-12T02:00:00.000Z', prompt: 10, completion: 1,
    })
    await call(app.context, LOCAL_APP_API_ROUTES.usageRefresh, { method: 'POST', body: { budget: 64 } })
    const ready = (await daily(app.context, 'from=2026-09-12&to=2026-09-12&timezone=UTC')).series

    app.runnerReady = false
    const whileStarting = await daily(app.context, 'from=2026-09-12&to=2026-09-12&timezone=UTC')
    expect(whileStarting.status).toBe(200)
    expect(whileStarting.series.totals).toEqual(ready.totals)
    // A scan genuinely needs the Runner's event store, so it fails closed.
    const refresh = await call(app.context, LOCAL_APP_API_ROUTES.usageRefresh, { method: 'POST', body: {} })
    expect(refresh.status).toBe(503)
    expect(String(refresh.body.error)).toContain('runtime')
  })

  it('cancels, resumes and clears through the API without losing counted usage', async () => {
    const app = await fixture()
    for (let index = 0; index < 4; index += 1) {
      await appendAttempt(app.store, {
        sessionId: 'session-known',
        runId: `run-${index}`,
        requestId: `req-${index}`,
        at: `2026-09-13T0${index}:00:00.000Z`,
        prompt: 100,
        completion: 25,
      })
    }
    const first = await call(app.context, LOCAL_APP_API_ROUTES.usageBackfill, {
      method: 'POST',
      body: { action: 'start', budgetPerStep: 1 },
    })
    expect(first.status).toBe(200)
    expect(first.body.progress).toMatchObject({ partitions: 4 })

    const cancelled = await call(app.context, LOCAL_APP_API_ROUTES.usageBackfill, {
      method: 'POST',
      body: { action: 'cancel' },
    })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.progress).toMatchObject({ status: 'cancelled' })
    const status = await call(app.context, LOCAL_APP_API_ROUTES.usageBackfill, {
      method: 'POST',
      body: { action: 'status' },
    })
    expect(status.status).toBe(200)
    expect(status.body.progress).toMatchObject({ status: 'cancelled' })

    // A resumed bounded backfill finishes the history; the total is the sum of
    // each attempt exactly once, whatever the pass boundaries were.
    let hasMore = true
    let guard = 0
    while (hasMore && guard < 10) {
      guard += 1
      const step = await call(app.context, LOCAL_APP_API_ROUTES.usageBackfill, {
        method: 'POST',
        body: { action: 'start', budgetPerStep: 2 },
      })
      hasMore = (step.body.progress as { hasMore?: boolean }).hasMore === true
    }
    const indexed = (await daily(app.context, 'from=2026-09-13&to=2026-09-13&timezone=UTC')).series
    expect(indexed.totals).toMatchObject({ requests: 4, total: 500 })
    expect(indexed.coverage.duplicateAttempts).toBe(0)

    // Clearing is an explicit action with a recorded cutoff scope.
    const cleared = await call(app.context, LOCAL_APP_API_ROUTES.usageClear, {
      method: 'POST',
      body: { through: '2026-09-30T00:00:00.000Z' },
    })
    expect(cleared.status).toBe(200)
    expect(cleared.body.clearedThrough).toBe('2026-09-30T00:00:00.000Z')
    const afterClear = (await daily(app.context, 'from=2026-09-13&to=2026-09-13&timezone=UTC')).series
    expect(afterClear.totals.requests).toBe(0)
    expect(afterClear.days[0]).toMatchObject({ state: 'empty' })
    expect(afterClear.coverage.clearedThrough).toBe('2026-09-30T00:00:00.000Z')
    expect(afterClear.coverage.statement).toContain('清空')
  })
})

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}
