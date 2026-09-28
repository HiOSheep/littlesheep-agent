// O5 evidence: cross-day Provider usage aggregation over persisted durable events.
//
// Every fixture here is written through the real DurableEventStore and read back
// through the same reducer the Harness kernel uses, so the assertions run
// against the persisted shapes rather than a hand-written stand-in for them.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableHarnessEvent, ProviderUsageDailySeries } from '@littlesheep/types';
import { DurableEventStore } from './durable-event-store.js';
import { ProviderUsageDailyIndexStore } from './provider-usage-daily-index.js';
import { ProviderUsageDailyService } from './provider-usage-daily-service.js';
import {
  ProviderUsageDailyRangeError,
  assertBoundedDailyRange,
  isSupportedTimeZone,
  isValidLocalDate,
  localDateRange,
  zonedDateKey,
} from './provider-usage-daily-time.js';
import { buildProviderUsageDailySeries } from './provider-usage-daily-series.js';
import { foldProviderUsageDailyRuns } from './provider-usage-daily-fold.js';

const roots: string[] = [];
/** Deterministic "now" for every series: 2026-09-27 20:00 in Asia/Shanghai. */
const NOW = new Date('2026-09-27T12:00:00.000Z');
const SHANGHAI = 'Asia/Shanghai';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ls-usage-daily-'));
  roots.push(root);
  return root;
}

interface RequestFixture {
  readonly requestId: string;
  /** Response event time (the usage-event time the aggregate dates by). */
  readonly at: string;
  readonly startedAt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly prompt?: number;
  readonly completion?: number;
  readonly total?: number;
  readonly cached?: number;
  readonly reasoning?: number;
  /** `unavailable` records a response that reported no usable usage. */
  readonly usage?: 'available' | 'unavailable';
  /** Omits the response and settles as failed: a request with no response. */
  readonly unanswered?: boolean;
  readonly retryOf?: string;
}

/** Appends one run in the exact event order and payload shape the Harness uses. */
async function appendRun(
  store: DurableEventStore,
  options: {
    readonly sessionId: string;
    readonly runId: string;
    readonly mode?: 'next' | 'shadow';
    readonly events?: readonly DurableHarnessEvent[];
    /** False when continuing a run whose ingress event already exists. */
    readonly accepted?: boolean;
    readonly requests: readonly RequestFixture[];
  },
): Promise<void> {
  const identity = { sessionId: options.sessionId, runId: options.runId };
  const write = async (input: Parameters<DurableEventStore['append']>[0]): Promise<void> => {
    const outcome = await store.append(input);
    expect(outcome.kind).toBe('appended');
  };
  if (options.accepted !== false) {
    await write({
      ...identity,
      eventId: `${options.runId}:run-accepted`,
      idempotencyKey: `${options.runId}:run-accepted`,
      type: 'run_accepted',
      source: 'runtime',
      payload: { origin: 'app', model: 'fixture-model', durableHarnessMode: options.mode ?? 'next' },
    });
  }
  for (const request of options.requests) {
    const provider = request.provider ?? 'deepseek';
    const model = request.model ?? 'deepseek-chat';
    const startedAt = request.startedAt ?? request.at;
    await write({
      ...identity,
      eventId: `${options.runId}:model-request:${request.requestId}:started`,
      idempotencyKey: `${options.runId}:model-request:${request.requestId}:started`,
      type: 'model_request_started',
      source: 'runtime',
      occurredAt: startedAt,
      payload: {
        requestId: request.requestId,
        requestIndex: 1,
        stage: 'execute',
        purpose: 'execute',
        provider,
        model,
        stream: false,
        ...(request.retryOf ? { retryOf: request.retryOf, retryReason: 'schema' } : {}),
      },
    });
    if (request.unanswered) {
      await write({
        ...identity,
        eventId: `${options.runId}:model-request:${request.requestId}:settled`,
        idempotencyKey: `${options.runId}:model-request:${request.requestId}:settled`,
        type: 'model_request_settled',
        source: 'runtime',
        occurredAt: request.at,
        payload: { requestId: request.requestId, status: 'failed', transportStatus: 'failed' },
      });
      continue;
    }
    const prompt = request.prompt ?? 120;
    await write({
      ...identity,
      eventId: `${options.runId}:model-request:${request.requestId}:response`,
      idempotencyKey: `${options.runId}:model-request:${request.requestId}:response`,
      type: 'model_response_received',
      source: 'runtime',
      occurredAt: request.at,
      payload: {
        requestId: request.requestId,
        provider,
        model,
        stream: false,
        transportStatus: 'completed',
        providerReachStatus: 'reached',
        cacheStatus: request.usage === 'unavailable' ? 'unavailable' : 'partial',
        reconciliation: request.usage === 'unavailable' ? 'unavailable' : 'exact_match',
        ...(request.usage === 'unavailable' ? { usageStatus: 'unavailable' as const } : {
          usageStatus: 'available' as const,
          promptTokens: prompt,
          completionTokens: request.completion ?? 40,
          totalTokens: request.total ?? prompt + (request.completion ?? 40),
          ...(request.cached === undefined ? {} : { cachedPromptTokens: request.cached }),
          ...(request.reasoning === undefined ? {} : { reasoningTokens: request.reasoning }),
          localCalibration: {
            version: 1,
            tokenizerId: 'fixture-tokenizer',
            localPromptTokens: prompt,
            differenceTokens: 0,
            relativeDifference: 0,
            status: 'exact_match',
          },
        }),
      },
    });
    await write({
      ...identity,
      eventId: `${options.runId}:model-request:${request.requestId}:settled`,
      idempotencyKey: `${options.runId}:model-request:${request.requestId}:settled`,
      type: 'model_request_settled',
      source: 'runtime',
      occurredAt: request.at,
      payload: {
        requestId: request.requestId,
        status: 'received',
        providerReached: true,
        transportStatus: 'completed',
        usageStatus: request.usage === 'unavailable' ? 'unavailable' : 'available',
      },
    });
  }
}

function serviceFor(root: string, store: DurableEventStore): ProviderUsageDailyService {
  return new ProviderUsageDailyService({
    dataRoot: root,
    eventSource: store,
    stepDelayMs: 1,
    now: () => NOW,
  });
}

const derivedDirectory = (root: string): string => ProviderUsageDailyIndexStore.pathsFor(root).directory;

/** Full pass, as a user-triggered refresh with an unbounded budget would do. */
async function indexAll(service: ProviderUsageDailyService): Promise<void> {
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const result = await service.runPass({ budget: 512, restart: guard === 1 });
    if (!result.hasMore) return;
  }
  throw new Error('indexing did not converge');
}

function seriesFor(
  service: ProviderUsageDailyService,
  options: {
    readonly from: string;
    readonly to: string;
    readonly timezone?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly knownSessionIds?: ReadonlySet<string>;
  },
): ProviderUsageDailySeries {
  return service.query({
    from: options.from,
    to: options.to,
    timezone: options.timezone ?? SHANGHAI,
    timezoneSource: options.timezone === undefined ? 'system' : 'request',
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.knownSessionIds === undefined ? {} : { knownSessionIds: options.knownSessionIds }),
  });
}

/** Series fields that must be identical across rebuilds (no timestamps). */
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
      missingResponses: series.coverage.missingResponses,
      unreportedRequests: series.coverage.unreportedRequests,
      unreadableRuns: series.coverage.unreadableRuns,
      modes: series.coverage.modes,
      duplicateAttempts: series.coverage.duplicateAttempts,
      retainedAfterDeleteSessions: series.coverage.retainedAfterDeleteSessions,
      clearedThrough: series.coverage.clearedThrough,
      projectionBuilt: series.coverage.projectionBuilt,
      statement: series.coverage.statement,
    },
  };
}

describe('provider usage daily aggregation', () => {
  it('counts one attempt per request id and keeps independent retries separate', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [
        { requestId: 'req-original', at: '2026-09-10T02:00:00.000Z', prompt: 100, completion: 50, cached: 30 },
        {
          requestId: 'req-retry',
          at: '2026-09-10T02:05:00.000Z',
          prompt: 20,
          completion: 5,
          retryOf: 'req-original',
        },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const series = seriesFor(service, { from: '2026-09-10', to: '2026-09-10' });

    // The retry is a separate billable attempt: both count, neither is merged.
    expect(series.days[0]).toMatchObject({
      date: '2026-09-10',
      state: 'recorded',
      requests: 2,
      total: 175,
      input: 120,
      output: 55,
      cached: 30,
    });
    expect(series.totals).toMatchObject({ requests: 2, total: 175, activeDays: 1 });
    expect(series.coverage.duplicateAttempts).toBe(0);
  });

  it('agrees between per-request, per-day and range totals for one fixture', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [
        { requestId: 'req-1', at: '2026-09-06T01:00:00.000Z', prompt: 100, completion: 10 },
        { requestId: 'req-2', at: '2026-09-07T01:00:00.000Z', prompt: 50, completion: 5, total: 80 },
        { requestId: 'req-3', at: '2026-09-08T01:00:00.000Z', prompt: 7, completion: 3 },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const series = seriesFor(service, { from: '2026-09-06', to: '2026-09-08' });

    // Per-request sum: 110 + 80 (the Provider-reported total wins) + 10.
    expect(series.totals.total).toBe(200);
    expect(series.days.map((day) => day.total)).toEqual([110, 80, 10]);
    expect(series.days.reduce((total, day) => total + day.total, 0)).toBe(series.totals.total);
    expect(series.days.reduce((total, day) => total + day.requests, 0)).toBe(series.totals.requests);
    expect(series.totals).toMatchObject({ input: 157, output: 18, activeDays: 3 });
    expect(series.coverage.attempts).toBe(3);
    expect(series.days[1]).toMatchObject({ total: 80, input: 50, output: 5 });
  });

  it('exposes a names-only partition listing and a change revision per run', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [{ requestId: 'req-1', at: '2026-09-09T01:00:00.000Z' }],
    });
    const partitions = await store.listRunPartitions();
    expect(partitions).toHaveLength(1);
    expect(partitions[0]).toMatch(/^[a-f0-9]{64}$/);
    const first = await store.readRunRevision(partitions[0]!);
    expect(first).toMatchObject({ sessionId: 'session-a', runId: 'run-1', eventCount: 4 });
    expect(await store.readRunRevision(partitions[0]!)).toEqual(first);
    // A growing log changes the revision, so an incremental pass re-reads it.
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      accepted: false,
      requests: [{ requestId: 'req-2', at: '2026-09-09T02:00:00.000Z' }],
    });
    const second = await store.readRunRevision(partitions[0]!);
    expect(second?.eventCount).toBe(7);
    expect(second?.revision).not.toBe(first?.revision);
    await expect(store.readRunRevision('not-a-partition')).rejects.toThrow(/invalid event partition/);
  });

  it('collapses a copied log (fork or replay) instead of counting it twice', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [
        { requestId: 'req-1', at: '2026-09-11T02:00:00.000Z', prompt: 100, completion: 50 },
      ],
    });
    // A replayed append of the very same response is refused by the store.
    const original = (await store.read('session-a', 'run-1'))
      .find((event) => event.type === 'model_response_received');
    expect(original).toBeDefined();
    const replayed = await store.append({
      eventId: original!.eventId,
      idempotencyKey: original!.idempotencyKey,
      sessionId: original!.sessionId,
      runId: original!.runId,
      type: original!.type,
      source: original!.source,
      occurredAt: original!.occurredAt,
      payload: original!.payload,
    });
    expect(replayed.kind).toBe('duplicate');
    // A fork copies the conversation, so the copied run names the same provider
    // attempt; the copy must not add consumption.
    await appendRun(store, {
      sessionId: 'session-branch',
      runId: 'run-1',
      requests: [
        { requestId: 'req-1', at: '2026-09-11T02:00:00.000Z', prompt: 100, completion: 50 },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const series = seriesFor(service, { from: '2026-09-11', to: '2026-09-11' });

    expect(series.days[0]).toMatchObject({ requests: 1, total: 150, input: 100, output: 50 });
    expect(series.totals.total).toBe(150);
    expect(series.coverage.duplicateAttempts).toBe(1);
    expect(series.coverage.indexedRuns).toBe(2);
    // The replay left no second event file behind.
    const partitions = await store.listRunPartitions();
    const events = await store.read('session-a', 'run-1');
    expect(partitions).toHaveLength(2);
    expect(events.filter((event) => event.type === 'model_response_received')).toHaveLength(1);
  });

  it('keeps a day with no calls distinct from a day whose calls reported zero', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-zero',
      requests: [{ requestId: 'req-zero', at: '2026-09-12T02:00:00.000Z', prompt: 0, completion: 0 }],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const series = seriesFor(service, { from: '2026-09-11', to: '2026-09-12' });

    expect(series.days[0]).toMatchObject({ date: '2026-09-11', state: 'empty', requests: 0, total: 0 });
    expect(series.days[1]).toMatchObject({ date: '2026-09-12', state: 'recorded', requests: 1, total: 0 });
    expect(series.totals.activeDays).toBe(1);
  });

  it('reports missing coverage instead of zero for unreported requests', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-missing',
      requests: [
        { requestId: 'req-no-usage', at: '2026-09-13T02:00:00.000Z', usage: 'unavailable' },
        { requestId: 'req-no-response', at: '2026-09-13T03:00:00.000Z', unanswered: true },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const series = seriesFor(service, { from: '2026-09-13', to: '2026-09-13' });

    expect(series.days[0]).toMatchObject({
      state: 'partial',
      requests: 0,
      total: 0,
      missingResponses: 1,
      unreportedRequests: 1,
    });
    expect(series.coverage).toMatchObject({ missingResponses: 1, unreportedRequests: 1 });
    expect(series.coverage.statement).toContain('未报 usage');
  });

  it('bounds the requested range and the identity facets', async () => {
    expect(isValidLocalDate('2026-09-31')).toBe(false);
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(isSupportedTimeZone('Asia/Shanghai')).toBe(true);
    expect(isSupportedTimeZone('Mars/Olympus')).toBe(false);
    expect(localDateRange('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
    expect(localDateRange('2026-12-31', '2027-01-01')).toEqual(['2026-12-31', '2027-01-01']);
    expect(() => assertBoundedDailyRange('2025-01-01', '2026-09-27')).toThrow(ProviderUsageDailyRangeError);

    const attempts = Array.from({ length: 70 }, (_unused, index) => ({
      requestId: `req-${index}`,
      at: '2026-09-14T02:00:00.000Z',
      provider: `provider-${String(index).padStart(2, '0')}`,
      model: 'model',
      total: 100 - index,
      input: 10,
      output: 5,
      cached: 0,
      reasoning: 0,
    }));
    const series = buildProviderUsageDailySeries({
      timezone: SHANGHAI,
      timezoneSource: 'request',
      from: '2026-09-14',
      to: '2026-09-14',
      filters: {},
      attempts,
      missing: [],
      coverage: {
        indexedRuns: 1,
        indexedSessions: 1,
        attempts: attempts.length,
        missingResponses: 0,
        unreportedRequests: 0,
        unreadableRuns: 0,
        modes: { next: 1, shadow: 0, unknown: 0 },
        duplicateAttempts: 0,
        projectionBuilt: true,
        stale: false,
        retainedAfterDeleteSessions: 0,
        backfill: { status: 'complete', partitions: 1, processed: 1, indexed: 1, failed: 0 },
      },
      now: NOW,
    });
    expect(series.days).toHaveLength(1);
    expect(series.identities.providers).toHaveLength(64);
    expect(series.bounds).toMatchObject({ maxRangeDays: 400, maxIdentities: 64, identitiesTruncated: true });
    expect(series.identities.providers[0]).toMatchObject({ id: 'provider-00', total: 100 });
    expect(series.totals.requests).toBe(70);
  });

  it('cancels and resumes a backfill without double counting', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    for (let index = 0; index < 6; index += 1) {
      await appendRun(store, {
        sessionId: `session-${index}`,
        runId: `run-${index}`,
        requests: [{
          requestId: `req-${index}`,
          at: `2026-09-15T0${index}:00:00.000Z`,
          prompt: 100,
          completion: 10,
        }],
      });
    }
    const service = serviceFor(root, store);
    const firstStep = await service.runPass({ budget: 2 });
    expect(firstStep).toMatchObject({ hasMore: true, processed: 2, indexed: 2, partitions: 6 });

    const cancelled = await service.cancelBackfill();
    expect(cancelled).toMatchObject({ status: 'cancelled', hasMore: true });
    expect(cancelled.cursor).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const afterCancel = await service.progress();
    expect(afterCancel.processed).toBe(2);

    let guard = 0;
    while (guard < 10) {
      guard += 1;
      const step = await service.runPass({ budget: 2 });
      if (!step.hasMore) break;
    }
    const series = seriesFor(service, { from: '2026-09-15', to: '2026-09-15' });
    expect(series.days[0]).toMatchObject({ requests: 6, total: 660 });
    expect(series.coverage.duplicateAttempts).toBe(0);

    // A full re-scan over the same events changes nothing: applying a run
    // replaces its contribution instead of adding to it.
    const rescanned = await service.runPass({ budget: 512, restart: true });
    expect(rescanned).toMatchObject({ status: 'complete', indexed: 0, partitions: 6 });
    expect(seriesFor(service, { from: '2026-09-15', to: '2026-09-15' }).days[0]).toMatchObject({
      requests: 6,
      total: 660,
    });
  });

  it('rebuilds the identical series from the persisted events alone', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [
        { requestId: 'req-1', at: '2026-09-16T01:00:00.000Z', prompt: 100, completion: 20, cached: 10 },
        { requestId: 'req-2', at: '2026-09-17T01:00:00.000Z', provider: 'openai', model: 'gpt-x' },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    const before = seriesFor(service, { from: '2026-09-01', to: '2026-09-30' });

    // The derived index is deleted entirely; only the events remain.
    await rm(derivedDirectory(root), { recursive: true, force: true });
    const rebuilt = serviceFor(root, store);
    await indexAll(rebuilt);
    const after = seriesFor(rebuilt, { from: '2026-09-01', to: '2026-09-30' });
    expect(comparable(after)).toEqual(comparable(before));

    // And the same events in a brand-new data root produce the same series:
    // nothing outside the event log feeds the aggregate.
    const otherRoot = await newRoot();
    const otherStore = new DurableEventStore({ rootDir: join(otherRoot, 'durable-events') });
    const events = await store.read('session-a', 'run-1');
    for (const event of events) {
      await otherStore.append({
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        sessionId: event.sessionId,
        runId: event.runId,
        type: event.type,
        source: event.source,
        occurredAt: event.occurredAt,
        payload: event.payload,
      });
    }
    const otherService = serviceFor(otherRoot, otherStore);
    await indexAll(otherService);
    expect(comparable(seriesFor(otherService, { from: '2026-09-01', to: '2026-09-30' }))).toEqual(comparable(before));
  });

  it('re-projects the same persisted facts when the timezone changes', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-1',
      requests: [
        { requestId: 'req-night', at: '2026-09-17T19:30:00.000Z', prompt: 100, completion: 10 },
        { requestId: 'req-dst', at: '2026-03-08T04:30:00.000Z', prompt: 50, completion: 5 },
        { requestId: 'req-year', at: '2025-12-31T20:00:00.000Z', prompt: 25, completion: 5 },
      ],
    });
    const service = serviceFor(root, store);
    await indexAll(service);

    expect(zonedDateKey('2026-09-17T19:30:00.000Z', SHANGHAI)).toBe('2026-09-18');
    expect(zonedDateKey('2026-09-17T19:30:00.000Z', 'UTC')).toBe('2026-09-17');
    const shanghai = seriesFor(service, { from: '2026-09-17', to: '2026-09-18' });
    const utc = seriesFor(service, { from: '2026-09-17', to: '2026-09-18', timezone: 'UTC' });
    expect(shanghai.days[1]).toMatchObject({ date: '2026-09-18', requests: 1, total: 110 });
    expect(shanghai.days[0]).toMatchObject({ date: '2026-09-17', requests: 0 });
    expect(utc.days[0]).toMatchObject({ date: '2026-09-17', requests: 1, total: 110 });
    expect(utc.days[1]).toMatchObject({ date: '2026-09-18', requests: 0 });
    // Same facts, same range total: only the day boundary moved.
    expect(shanghai.totals.total).toBe(utc.totals.total);

    // A DST transition day keeps exactly one calendar day and loses no attempt.
    expect(zonedDateKey('2026-03-08T04:30:00.000Z', 'America/New_York')).toBe('2026-03-07');
    const newYork = seriesFor(service, {
      from: '2026-03-07',
      to: '2026-03-09',
      timezone: 'America/New_York',
    });
    expect(newYork.days.map((day) => day.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(newYork.days[0]).toMatchObject({ requests: 1, total: 55 });

    // A year boundary and a leap day are ordinary calendar days.
    const yearEdge = seriesFor(service, { from: '2025-12-31', to: '2026-01-01' });
    expect(yearEdge.days[0]).toMatchObject({ date: '2025-12-31', requests: 0 });
    expect(yearEdge.days[1]).toMatchObject({ date: '2026-01-01', requests: 1, total: 30 });
    expect(localDateRange('2028-02-29', '2028-02-29')).toEqual(['2028-02-29']);

    // Days after "today" in the series timezone are explicitly future, never 0.
    const future = seriesFor(service, { from: '2026-09-27', to: '2026-09-29' });
    expect(future.days.map((day) => day.state)).toEqual(['empty', 'future', 'future']);
    expect(future.days[1]).toMatchObject({ requests: 0, total: 0, missingResponses: 0 });
  });
});

describe('provider usage retention rules', () => {
  it('does not resurrect cleared usage through a backfill', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-old',
      requests: [{ requestId: 'req-old', at: '2026-09-20T02:00:00.000Z', prompt: 100, completion: 10 }],
    });
    const service = serviceFor(root, store);
    await indexAll(service);
    expect(seriesFor(service, { from: '2026-09-20', to: '2026-09-20' }).totals.total).toBe(110);

    await service.clearThrough(NOW.toISOString());
    const cleared = seriesFor(service, { from: '2026-09-20', to: '2026-09-20' });
    expect(cleared.totals.total).toBe(0);
    expect(cleared.coverage.clearedThrough).toBe(NOW.toISOString());

    // An attempt after the cutoff is counted; the earlier consumption stays
    // cleared, and the cleared day stays distinct from a day with no calls.
    await appendRun(store, {
      sessionId: 'session-a',
      runId: 'run-new',
      requests: [{ requestId: 'req-new', at: '2026-09-27T14:00:00.000Z', prompt: 7, completion: 3 }],
    });
    await service.runPass({ budget: 512, restart: true });
    const after = seriesFor(service, { from: '2026-09-20', to: '2026-09-27' });
    expect(after.days[0]).toMatchObject({ date: '2026-09-20', requests: 0, state: 'empty' });
    expect(after.days[7]).toMatchObject({ date: '2026-09-27', requests: 1, total: 10 });

    // The clear record is not part of the derived index, so discarding and
    // rebuilding the index cannot bring the cleared days back.
    await rm(derivedDirectory(root), { recursive: true, force: true });
    const rebuilt = serviceFor(root, store);
    await indexAll(rebuilt);
    const rebuiltSeries = seriesFor(rebuilt, { from: '2026-09-20', to: '2026-09-27' });
    expect(rebuiltSeries.days[0]).toMatchObject({ requests: 0, state: 'empty' });
    expect(rebuiltSeries.days[7]).toMatchObject({ requests: 1, total: 10 });
    expect(rebuiltSeries.totals.total).toBe(10);
    expect(rebuiltSeries.coverage.clearedThrough).toBe(NOW.toISOString());
  });

  it('retains a content-free summary after a session is permanently deleted', async () => {
    const root = await newRoot();
    const store = new DurableEventStore({ rootDir: join(root, 'durable-events') });
    await appendRun(store, {
      sessionId: 'session-gone',
      runId: 'run-gone',
      requests: [{ requestId: 'req-gone', at: '2026-09-22T02:00:00.000Z', prompt: 400, completion: 100 }],
    });
    const service = serviceFor(root, store);
    await indexAll(service);

    const known = new Set(['session-alive']);
    const series = seriesFor(service, {
      from: '2026-09-22',
      to: '2026-09-22',
      knownSessionIds: known,
    });
    expect(series.totals.total).toBe(500);
    expect(series.coverage.retainedAfterDeleteSessions).toBe(1);
    expect(series.coverage.statement).toContain('永久删除');

    // The retained summary is numbers and identities only: nothing derived from
    // conversation content is persisted in the index.
    const persisted = await readFile(
      join(derivedDirectory(root), 'provider-usage-daily-index.json'),
      'utf8',
    );
    for (const forbidden of ['"content"', '"text"', '"reply"', '"messages"', '"prompt"', '"toolResult"']) {
      expect(persisted).not.toContain(forbidden);
    }

    // Archiving is not deleting: a session that still exists anywhere counts as
    // present, and consumption is unchanged either way.
    const archived = seriesFor(service, {
      from: '2026-09-22',
      to: '2026-09-22',
      knownSessionIds: new Set(['session-gone']),
    });
    expect(archived.totals).toEqual(series.totals);
    expect(archived.coverage.retainedAfterDeleteSessions).toBe(0);
  });

  it('folds duplicate attempt facts from two indexed runs deterministically', async () => {
    const runs = [
      {
        sessionId: 'session-a',
        runId: 'run-1',
        mode: 'next' as const,
        attempts: [{
          requestId: 'req-1',
          at: '2026-09-23T02:00:00.000Z',
          provider: 'deepseek',
          model: 'deepseek-chat',
          total: 100,
          input: 80,
          output: 20,
          cached: 0,
          reasoning: 0,
        }],
        missing: [],
      },
      {
        sessionId: 'session-branch',
        runId: 'run-1',
        mode: 'next' as const,
        attempts: [{
          requestId: 'req-1',
          at: '2026-09-23T05:00:00.000Z',
          provider: 'deepseek',
          model: 'deepseek-chat',
          total: 100,
          input: 80,
          output: 20,
          cached: 0,
          reasoning: 0,
        }],
        missing: [],
      },
    ];
    const forward = foldProviderUsageDailyRuns({ runs });
    const backward = foldProviderUsageDailyRuns({ runs: [...runs].reverse() });
    expect(forward.attempts).toHaveLength(1);
    expect(forward.duplicateAttempts).toBe(1);
    expect(forward.attempts[0]?.at).toBe('2026-09-23T02:00:00.000Z');
    expect(backward.attempts[0]?.at).toBe(forward.attempts[0]?.at);
  });
});
