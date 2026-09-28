// O5 HTTP acceptance evidence over REAL runner events.
//
// Every number below is produced by a real `createRunner` run: the durable log
// carries the Provider usage the scripted LlmClient reported, and the daily
// series is read back through the shipped Local App API route over loopback
// HTTP. This file covers the three items the runner-level evidence cannot:
// the bounded response shape, a fork taken through the product's own branch
// route, and a bounded backfill that is cancelled and resumed through the API.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import {
  DurableEventStore,
  createRunner,
  type AgentRunner,
  type CreateRunnerOptions,
} from '@littlesheep/runner'
import { asSessionId, type Message, type ProviderUsageDailySeries } from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import { ArchiveIndex } from '../archive-index.js'
import { ProjectIndex } from '../project-index.js'
import { SessionIndex } from '../session-index.js'
import { routeSessions, type SessionRouteContext } from './session-routes.js'
import { routeUsage, type UsageRouteContext } from './usage-routes.js'

type LlmClient = NonNullable<CreateRunnerOptions['llm']>
type ChatRequest = Parameters<LlmClient['chat']>[0]
type ChatResponse = Awaited<ReturnType<LlmClient['chat']>>
type StreamChunk = Parameters<Parameters<LlmClient['chatStream']>[1]>[0]

/** One provider report exactly as the LlmClient returns it to the Harness. */
function usageResponse(content: string, promptTokens: number, completionTokens: number): ChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedPromptTokens: 0,
    },
  }
}

let dataDir: string
let workplaceDir: string
const runners: AgentRunner[] = []

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-o5-api-evidence-'))
  workplaceDir = join(dataDir, 'workplace')
  mkdirSync(workplaceDir, { recursive: true })
  process.env.LITTLESHEEP_DATA_DIR = dataDir
  runners.length = 0
})

afterEach(async () => {
  for (const runner of runners) await runner.shutdown().catch(() => undefined)
  delete process.env.LITTLESHEEP_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

interface ApiResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly bytes: number
}

interface Evidence {
  readonly runner: AgentRunner
  readonly store: DurableEventStore
  call(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult>
  daily(query: string): Promise<ApiResult & { readonly series: ProviderUsageDailySeries }>
  run(text: string, sessionId?: string): Promise<{ sessionId: string; runId: string }>
  close(): Promise<void>
}

/** A real runner behind the shipped usage and session routes, over loopback HTTP. */
async function evidenceFixture(script: readonly ChatResponse[]): Promise<Evidence> {
  const queue = [...script]
  const next = (): ChatResponse => {
    const response = queue.shift()
    if (!response) throw new Error('unexpected Provider call: the script is exhausted')
    return response
  }
  const llm: LlmClient = {
    chat: vi.fn(async (_request: ChatRequest) => next()),
    chatStream: vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const response = next()
      if (response.content) onDelta({ type: 'delta', delta: response.content })
      onDelta({ type: 'done', finishReason: response.finishReason })
      return response
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.agents.defaults.workspace = workplaceDir
  const runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/model',
    llm,
    skillsDirs: [],
    containerRoot: dataDir,
  })
  runners.push(runner)
  const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
  const usageContext: UsageRouteContext = {
    getRunner: () => runner,
    dataDir,
    sessionIndex,
    archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
  }
  const sessionContext: SessionRouteContext = {
    getRunner: () => runner,
    sessionIndex,
    projectIndex: new ProjectIndex({ dataDir }),
    archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const request = { req, res, url, path: url.pathname, method: req.method ?? 'GET' }
    void (async () => {
      if (await routeUsage(request, usageContext)) return
      if (await routeSessions(request, sessionContext)) return
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no route' }))
    })().catch((error: unknown) => {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
      if (res.headersSent) return res.end()
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  const origin = `http://127.0.0.1:${address.port}`

  /** Serialized byte length of a response body, measured, not estimated. */
  const call = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult> => {
    const response = await fetch(`${origin}${path}`, {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text ? JSON.parse(text) as Record<string, unknown> : {},
      bytes: Buffer.byteLength(text, 'utf8'),
    }
  }

  return {
    runner,
    store: runner.infra.durableEventStore as unknown as DurableEventStore,
    call,
    async daily(query) {
      const result = await call(`${LOCAL_APP_API_ROUTES.usageDaily}?${query}`)
      return { ...result, series: result.body as unknown as ProviderUsageDailySeries }
    },
    async run(text, sessionId) {
      const result = await runner.run({
        text,
        ...(sessionId === undefined ? {} : { sessionId: asSessionId(sessionId) }),
      })
      expect(result.status, result.error).toBe('ok')
      return { sessionId: String(result.sessionId), runId: result.runId }
    },
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

/** The UTC calendar days the accepted response events fall into. */
async function reportedRange(store: DurableEventStore): Promise<{
  from: string
  to: string
  total: number
  responses: number
  dates: string[]
}> {
  const dates: string[] = []
  let total = 0
  let responses = 0
  for (const partitionKey of await store.listRunPartitions()) {
    const revision = await store.readRunRevision(partitionKey)
    if (!revision) continue
    for (const event of await store.read(revision.sessionId, revision.runId)) {
      if (event.type !== 'model_response_received') continue
      responses += 1
      if (event.payload['usageStatus'] !== 'available') continue
      dates.push(event.occurredAt.slice(0, 10))
      total += Number(event.payload['totalTokens'] ?? 0)
    }
  }
  dates.sort()
  const first = dates[0]
  const last = dates.at(-1)
  if (!first || !last) throw new Error('no reported attempt to build a range from')
  return { from: first, to: last, total, responses, dates: [...new Set(dates)] }
}

function comparable(series: ProviderUsageDailySeries): unknown {
  return {
    timezone: series.timezone,
    range: series.range,
    days: series.days,
    totals: series.totals,
    identities: series.identities,
    coverage: {
      indexedRuns: series.coverage.indexedRuns,
      indexedSessions: series.coverage.indexedSessions,
      attempts: series.coverage.attempts,
      duplicateAttempts: series.coverage.duplicateAttempts,
      missingResponses: series.coverage.missingResponses,
      unreportedRequests: series.coverage.unreportedRequests,
      retainedAfterDeleteSessions: series.coverage.retainedAfterDeleteSessions,
      // The backfill sentence names what the last pass indexed, which differs
      // between a resumed pass and a fresh rebuild.
      statement: series.coverage.statement.replace(/回填状态 [^；]*/u, '回填状态 <progress>'),
    },
  }
}

describe('O5 daily usage API evidence', () => {
  it('bounds the response and counts a real fork as no new consumption', async () => {
    const app = await evidenceFixture([
      usageResponse('Fork source answer', 120, 40),
      usageResponse('Branch answer', 25, 5),
    ])
    try {
      const source = await app.run('hello')
      const reports = await reportedRange(app.store)
      expect(reports).toMatchObject({ total: 160, responses: 1 })
      const range = `from=${reports.from}&to=${reports.to}&timezone=UTC`

      await app.call(LOCAL_APP_API_ROUTES.usageRefresh, { method: 'POST', body: { budget: 64 } })
      const before = await app.daily(range)
      expect(before.status).toBe(200)
      expect(before.series.totals).toMatchObject({
        requests: 1,
        total: 160,
        input: 120,
        output: 40,
        activeDays: reports.dates.length,
      })
      expect(before.series.coverage).toMatchObject({ indexedRuns: 1, attempts: 1, duplicateAttempts: 0 })

      // The product's own fork route: the branch is a real session holding the
      // conversation up to the chosen message.
      const messages: Message[] = await app.runner.sessionManager.read(asSessionId(source.sessionId))
      const forkPoint = [...messages].reverse().find((message) => message.role === 'assistant')
      expect(forkPoint?.id).toBeTruthy()
      const forked = await app.call(
        localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, source.sessionId, '/branch'),
        { method: 'POST', body: { messageId: forkPoint!.id } },
      )
      expect(forked.status, String(forked.body['error'])).toBe(200)
      const branchId = String(forked.body['sessionId'])
      expect(branchId).not.toBe(source.sessionId)
      const branchMessages = await app.runner.sessionManager.read(asSessionId(branchId))
      expect(branchMessages.length).toBe(Number(forked.body['messages']))
      expect(branchMessages.length).toBeGreaterThan(0)

      // The fork copied conversation only: no run partition, no second attempt.
      expect(await app.store.listRunPartitions()).toHaveLength(1)
      const afterFork = await app.daily(range)
      expect(comparable(afterFork.series)).toEqual(comparable(before.series))

      // Continuing the branch is a genuinely new Provider call, counted once:
      // the copied history is not billed again.
      await app.run('continue in the branch', branchId)
      await app.call(LOCAL_APP_API_ROUTES.usageRefresh, { method: 'POST', body: { budget: 64 } })
      const afterBranchRun = await app.daily(range)
      expect(afterBranchRun.series.totals).toMatchObject({
        requests: 2,
        total: 190,
        activeDays: reports.dates.length,
      })
      expect(afterBranchRun.series.coverage).toMatchObject({
        indexedRuns: 2,
        indexedSessions: 2,
        attempts: 2,
        duplicateAttempts: 0,
      })

      // Bounded response: 400 days is the cap and is served in full; one day
      // more is refused instead of truncated.
      const capped = await app.daily('from=2025-01-01&to=2026-02-04&timezone=UTC')
      expect(capped.status).toBe(200)
      expect(capped.series.range).toEqual({ from: '2025-01-01', to: '2026-02-04', days: 400 })
      expect(capped.series.days).toHaveLength(400)
      expect(capped.series.bounds).toEqual({ maxRangeDays: 400, maxIdentities: 64, identitiesTruncated: false })
      const overCap = await app.daily('from=2025-01-01&to=2026-02-05&timezone=UTC')
      expect(overCap.status).toBe(400)
      expect(String(overCap.body['error'])).toContain('400 days')
      // The default "last year" range is bounded too.
      const defaulted = await app.daily('timezone=UTC')
      expect(defaulted.status).toBe(200)
      expect(defaulted.series.range.days).toBe(366)
      expect(defaulted.series.days).toHaveLength(366)
      expect(defaulted.series.identities.providers.length).toBeLessThanOrEqual(64)
      expect(defaulted.series.identities.models.length).toBeLessThanOrEqual(64)

      // Literal payload sizes: the document grows with the requested days, not
      // with the history behind them, and the rejection above is what keeps it
      // bounded.
      expect(capped.bytes).toBeLessThan(80_000)
      expect(capped.bytes / defaulted.bytes).toBeLessThan(1.2)
      console.log(`O5 bounded response bytes: 400-day=${capped.bytes} 366-day=${defaulted.bytes}`)
    } finally {
      await app.close()
    }
  })

  it('cancels and resumes a bounded backfill through the API without double counting', async () => {
    const app = await evidenceFixture([
      usageResponse('Backfill one', 100, 10),
      usageResponse('Backfill two', 20, 5),
      usageResponse('Backfill three', 7, 3),
    ])
    try {
      const runs = [
        await app.run('hello'),
        await app.run('hello'),
        await app.run('hello'),
      ]
      expect(new Set(runs.map((run) => run.sessionId)).size).toBe(3)
      const reports = await reportedRange(app.store)
      // The Provider reported 110 + 25 + 10; the API must agree exactly once.
      expect(reports).toMatchObject({ total: 145, responses: 3 })
      const range = `from=${reports.from}&to=${reports.to}&timezone=UTC`

      const started = await app.call(LOCAL_APP_API_ROUTES.usageBackfill, {
        method: 'POST',
        body: { action: 'start', budgetPerStep: 1 },
      })
      expect(started.status).toBe(200)
      expect(started.body['progress']).toMatchObject({ partitions: 3, processed: 1, hasMore: true })

      const cancelled = await app.call(LOCAL_APP_API_ROUTES.usageBackfill, {
        method: 'POST',
        body: { action: 'cancel' },
      })
      expect(cancelled.status).toBe(200)
      expect(cancelled.body['progress']).toMatchObject({ status: 'cancelled', hasMore: true })
      expect((cancelled.body['progress'] as { cursor?: string }).cursor).toBeTruthy()
      const idle = await app.call(LOCAL_APP_API_ROUTES.usageBackfill, {
        method: 'POST',
        body: { action: 'status' },
      })
      expect(idle.body['progress']).toMatchObject({ status: 'cancelled' })
      // A cancelled backfill never counts more than the Provider reported.
      const partial = await app.daily(range)
      expect(partial.series.totals.total).toBeLessThanOrEqual(145)
      console.log(
        `O5 after cancel: total=${partial.series.totals.total} of 145, processed=${partial.series.coverage.backfill.processed}`,
      )

      // Resumed with the same bounded step size until the history is covered.
      let hasMore = true
      let guard = 0
      while (hasMore && guard < 10) {
        guard += 1
        const step = await app.call(LOCAL_APP_API_ROUTES.usageBackfill, {
          method: 'POST',
          body: { action: 'start', budgetPerStep: 1 },
        })
        hasMore = (step.body['progress'] as { hasMore?: boolean }).hasMore === true
      }
      expect(hasMore).toBe(false)
      const complete = await app.daily(range)
      expect(complete.series.totals).toMatchObject({
        requests: 3,
        total: 145,
        input: 127,
        output: 18,
        activeDays: reports.dates.length,
      })
      expect(complete.series.coverage).toMatchObject({
        indexedRuns: 3,
        attempts: 3,
        duplicateAttempts: 0,
        unreadableRuns: 0,
        backfill: { status: 'complete', partitions: 3, processed: 3, indexed: 3, failed: 0 },
      })

      // A full re-scan over the same events changes nothing: applying a run
      // replaces its contribution instead of adding to it.
      const rescanned = await app.call(LOCAL_APP_API_ROUTES.usageRefresh, {
        method: 'POST',
        body: { budget: 64, restart: true },
      })
      expect(rescanned.status).toBe(200)
      expect(rescanned.body['progress']).toMatchObject({ status: 'complete', indexed: 0, partitions: 3 })
      const afterRescan = await app.daily(range)
      expect(afterRescan.series.totals).toEqual(complete.series.totals)
      expect(comparable(afterRescan.series)).toEqual(comparable(complete.series))
    } finally {
      await app.close()
    }
  })
})
