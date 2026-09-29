// O5's open boundary, measured on the wire: the identity facet cap.
//
// `packages/app/src/main/local-app-api/usage-routes.ts` promises a bounded facet
// list (`PROVIDER_USAGE_DAILY_MAX_IDENTITIES`). Until now that bound only had
// unit-level proof, because every route fixture carried one or two provider
// identities and `identities.providers.length <= 64` cannot fail on those. This
// file is the O6 consumer's case: a real data root with more recorded providers
// than the cap, read over a real loopback HTTP request, so the assertion is made
// against the bytes a renderer would receive.
//
// The three numbers that matter are asserted apart from each other, because they
// mean different things:
//   - the facet list is capped at 64 items,
//   - `identitiesTruncated` admits the list is not everything, and
//   - the totals still count every one of the 70 attempts: the cap is a bound on
//     the facet list, never on the usage.
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableEventStore, type AgentRunner } from '@littlesheep/runner'
import {
  PROVIDER_USAGE_DAILY_MAX_IDENTITIES,
  type ProviderUsageDailySeries,
} from '@littlesheep/types'
import { LOCAL_APP_API_ROUTES } from '../../shared/local-app-api-routes.js'
import { ArchiveIndex } from '../archive-index.js'
import { SessionIndex } from '../session-index.js'
import { routeUsage, type UsageRouteContext } from './usage-routes.js'

/** One more identity than the cap: the smallest fixture that can prove the bound. */
const PROVIDERS = PROVIDER_USAGE_DAILY_MAX_IDENTITIES + 6
const DAY = '2026-09-20'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; store: DurableEventStore; context: UsageRouteContext }> {
  const root = mkdtempSync(join(tmpdir(), 'ls-usage-facet-'))
  roots.push(root)
  const store = new DurableEventStore({ rootDir: join(root, 'durable-events') })
  const sessionIndex = new SessionIndex({ dataDir: root })
  await sessionIndex.upsert('session-facets', {
    title: 'facets', createdAt: 1, lastMessageAt: 1, mode: 'limited', scope: 'standalone',
  })
  const runner = { infra: { durableEventStore: store } } as unknown as AgentRunner
  return {
    root,
    store,
    context: {
      getRunner: () => runner,
      dataDir: root,
      sessionIndex,
      archiveIndex: new ArchiveIndex({ dataDir: root }),
    },
  }
}

/** One run with one Provider attempt, written through the real durable store. */
async function appendAttempt(
  store: DurableEventStore,
  input: { runId: string; provider: string; at: string; prompt: number },
): Promise<void> {
  const identity = { sessionId: 'session-facets', runId: input.runId }
  await store.append({
    ...identity,
    eventId: `${input.runId}:run-accepted`,
    idempotencyKey: `${input.runId}:run-accepted`,
    type: 'run_accepted',
    source: 'runtime',
    occurredAt: input.at,
    payload: { origin: 'app', model: 'fixture-model', durableHarnessMode: 'next' },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.runId}:started`,
    idempotencyKey: `${input.runId}:model-request:${input.runId}:started`,
    type: 'model_request_started',
    source: 'runtime',
    occurredAt: input.at,
    payload: {
      requestId: input.runId, provider: input.provider, model: 'fixture-model',
      stage: 'execute', requestIndex: 1,
    },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.runId}:response`,
    idempotencyKey: `${input.runId}:model-request:${input.runId}:response`,
    type: 'model_response_received',
    source: 'runtime',
    occurredAt: input.at,
    payload: {
      requestId: input.runId,
      provider: input.provider,
      model: 'fixture-model',
      transportStatus: 'completed',
      providerReachStatus: 'reached',
      cacheStatus: 'partial',
      reconciliation: 'unavailable',
      usageStatus: 'available',
      promptTokens: input.prompt,
      completionTokens: 1,
      totalTokens: input.prompt + 1,
    },
  })
  await store.append({
    ...identity,
    eventId: `${input.runId}:model-request:${input.runId}:settled`,
    idempotencyKey: `${input.runId}:model-request:${input.runId}:settled`,
    type: 'model_request_settled',
    source: 'runtime',
    occurredAt: input.at,
    payload: { requestId: input.runId, status: 'received', usageStatus: 'available' },
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
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
  } finally {
    await close(server)
  }
}

describe('daily usage facet bound on the wire', () => {
  it(`caps each facet list at ${PROVIDER_USAGE_DAILY_MAX_IDENTITIES} without losing counted usage`, async () => {
    const app = await fixture()
    for (let round = 0; round * 60 < PROVIDERS; round += 1) {
      const batch: Array<Promise<void>> = []
      for (let offset = 0; offset < 60; offset += 1) {
        const index = round * 60 + offset
        if (index >= PROVIDERS) break
        const minute = String(index % 60).padStart(2, '0')
        batch.push(appendAttempt(app.store, {
          runId: `run-${index}`,
          provider: `provider-${String(index).padStart(3, '0')}`,
          at: `${DAY}T${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${minute}:00.000Z`,
          prompt: 100 + index,
        }))
      }
      await Promise.all(batch)
    }

    const refreshed = await call(app.context, LOCAL_APP_API_ROUTES.usageRefresh, {
      method: 'POST',
      body: { budget: 512 },
    })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.progress).toMatchObject({ status: 'complete', partitions: PROVIDERS, indexed: PROVIDERS })

    const response = await call(
      app.context,
      `${LOCAL_APP_API_ROUTES.usageDaily}?from=${DAY}&to=${DAY}&timezone=UTC`,
    )
    expect(response.status).toBe(200)
    const series = response.body as unknown as ProviderUsageDailySeries

    // 1. The facet list is bounded. This is the assertion that cannot fail on a
    //    one-identity fixture and therefore had no route-level proof before.
    expect(series.identities.providers.length).toBe(PROVIDER_USAGE_DAILY_MAX_IDENTITIES)
    expect(series.bounds.maxIdentities).toBe(PROVIDER_USAGE_DAILY_MAX_IDENTITIES)
    // 2. The bound is admitted in the payload rather than hidden.
    expect(series.bounds.identitiesTruncated).toBe(true)
    // 3. The cap is a facet bound, not a usage bound: every attempt is still counted.
    const expectedTotal = Array.from({ length: PROVIDERS }, (_, index) => 100 + index + 1)
      .reduce((sum, value) => sum + value, 0)
    expect(series.totals).toMatchObject({ requests: PROVIDERS, total: expectedTotal })
    expect(series.totals.activeDays).toBe(1)
    expect(series.days[0]).toMatchObject({ state: 'recorded', requests: PROVIDERS, total: expectedTotal })
    // The 64 kept entries are the highest-usage ones, sorted by total descending.
    const totals = series.identities.providers.map((entry) => entry.total)
    expect([...totals].sort((left, right) => right - left)).toEqual(totals)
    expect(totals).not.toContain(101)

    // A filtered read of a provider that fell outside the facet list still works:
    // the filter is applied to the projection, not to the bounded list.
    const outside = await call(
      app.context,
      `${LOCAL_APP_API_ROUTES.usageDaily}?from=${DAY}&to=${DAY}&timezone=UTC&provider=provider-000`,
    )
    expect((outside.body as unknown as ProviderUsageDailySeries).totals).toMatchObject({ requests: 1, total: 101 })
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
