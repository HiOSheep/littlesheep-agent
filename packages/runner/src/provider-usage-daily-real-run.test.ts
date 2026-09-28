// O5 acceptance evidence: the daily aggregate over the events a REAL runner wrote.
//
// Nothing in this file writes an event payload by hand. A real `createRunner` run
// with a scripted `LlmClient` produces the durable log through the shipped
// Harness producers — `model_request_started` → `model_response_received`
// (carrying the real provider usage projection) → `model_request_settled` — and
// this file only reads what the store accepted. The retry fixture is a real one
// too: a capability turn whose first reply is empty makes the reply stage mint a
// second request id with `retryOf: 'empty_output'`, so one run contains two
// genuinely billed Provider attempts.
//
// Step 1 (fork / replay / retry counted once), Step 2 (a day with no events
// versus a day whose call reported zero) and Step 5 (rebuild from events alone)
// are measured here; the fork taken through the product's own branch route is
// measured in packages/app/src/main/local-app-api/usage-daily-real-events.test.ts.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { reduceDurableRunProjection } from '@littlesheep/harness';
import type { DurableHarnessEvent, ProviderUsageDailySeries } from '@littlesheep/types';
import type { AgentRunner, CreateRunnerOptions } from './runner.js';
import { createRunner } from './runner.js';
import { DurableEventStore } from './durable-event-store.js';
import { ProviderUsageDailyIndexStore } from './provider-usage-daily-index.js';
import { ProviderUsageDailyService } from './provider-usage-daily-service.js';

type LlmClient = NonNullable<CreateRunnerOptions['llm']>;
type ChatRequest = Parameters<LlmClient['chat']>[0];
type ChatResponse = Awaited<ReturnType<LlmClient['chat']>>;
type StreamChunk = Parameters<Parameters<LlmClient['chatStream']>[1]>[0];

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
  };
}

interface ScriptedLlm {
  readonly llm: LlmClient;
  /** Provider calls the runner actually made (streaming and non-streaming). */
  calls(): number;
}

function scriptedLlm(responses: readonly ChatResponse[]): ScriptedLlm {
  const queue = [...responses];
  let calls = 0;
  const next = (): ChatResponse => {
    const response = queue.shift();
    if (!response) throw new Error('unexpected Provider call: the script is exhausted');
    calls += 1;
    return response;
  };
  const chat = vi.fn(async (_request: ChatRequest) => next());
  return {
    llm: {
      chat,
      chatStream: vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
        const response = next();
        if (response.content) onDelta({ type: 'delta', delta: response.content });
        onDelta({ type: 'done', finishReason: response.finishReason });
        return response;
      }),
      embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
    },
    calls: () => calls,
  };
}

let dataDir: string;
const runners: AgentRunner[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-o5-real-run-'));
  mkdirSync(join(dataDir, 'workplace'), { recursive: true });
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  runners.length = 0;
});

afterEach(async () => {
  for (const runner of runners) await runner.shutdown().catch(() => undefined);
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function realRunner(llm: LlmClient, model: string): Promise<AgentRunner> {
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.workspace = join(dataDir, 'workplace');
  const runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model,
    llm,
    skillsDirs: [],
    containerRoot: dataDir,
  });
  runners.push(runner);
  return runner;
}

function eventStore(runner: AgentRunner): DurableEventStore {
  return runner.infra.durableEventStore as unknown as DurableEventStore;
}

function freshService(root = dataDir): ProviderUsageDailyService {
  return new ProviderUsageDailyService({
    dataRoot: root,
    eventSource: new DurableEventStore({ rootDir: join(root, 'durable-events') }),
    stepDelayMs: 1,
  });
}

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
  options: { readonly from: string; readonly to: string; readonly model?: string },
): ProviderUsageDailySeries {
  return service.query({
    from: options.from,
    to: options.to,
    timezone: 'UTC',
    timezoneSource: 'request',
    ...(options.model === undefined ? {} : { model: options.model }),
  });
}

/** Fields that must be identical across rebuilds (timestamps excluded). */
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
      // The backfill sentence names how many partitions the LAST pass indexed,
      // which legitimately differs between a resumed pass and a fresh rebuild;
      // every other claim in the statement must match.
      statement: series.coverage.statement.replace(/回填状态 [^；]*/u, '回填状态 <progress>'),
    },
  };
}

interface ReportedAttempt {
  readonly requestId: string;
  readonly date: string;
  readonly total: number;
  readonly input: number;
  readonly output: number;
  readonly retryOf?: string;
}

/**
 * The Provider's own report, read back per partition through the same reducer
 * the Harness kernel uses. This is the independent side of every total below:
 * the aggregate has to agree with what the Provider reported, not with itself.
 */
async function providerReports(
  store: DurableEventStore,
): Promise<{ readonly attempts: ReportedAttempt[]; readonly responseEvents: number }> {
  const attempts: ReportedAttempt[] = [];
  let responseEvents = 0;
  for (const partitionKey of await store.listRunPartitions()) {
    const revision = await store.readRunRevision(partitionKey);
    if (!revision) continue;
    const events = await store.read(revision.sessionId, revision.runId);
    responseEvents += events.filter((event) => event.type === 'model_response_received').length;
    const projection = reduceDurableRunProjection(events);
    for (const request of projection.modelRequests) {
      const usage = request.providerUsage;
      if (!usage || !request.respondedAt) continue;
      attempts.push({
        requestId: request.requestId,
        date: request.respondedAt.slice(0, 10),
        total: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
        input: usage.promptTokens,
        output: usage.completionTokens,
        ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
      });
    }
  }
  return { attempts, responseEvents };
}

/** Inclusive UTC day range covering the days the reports actually name. */
function rangeOver(attempts: readonly ReportedAttempt[]): { from: string; to: string } {
  const dates = [...new Set(attempts.map((attempt) => attempt.date))].sort();
  const first = dates[0];
  const last = dates.at(-1);
  if (!first || !last) throw new Error('no reported attempt to build a range from');
  return { from: first, to: last };
}

/** Per-day expectation derived from the Provider reports, not from the aggregate. */
function expectedDays(
  attempts: readonly ReportedAttempt[],
): Map<string, { requests: number; total: number; input: number; output: number }> {
  const days = new Map<string, { requests: number; total: number; input: number; output: number }>();
  for (const attempt of attempts) {
    const current = days.get(attempt.date) ?? { requests: 0, total: 0, input: 0, output: 0 };
    days.set(attempt.date, {
      requests: current.requests + 1,
      total: current.total + attempt.total,
      input: current.input + attempt.input,
      output: current.output + attempt.output,
    });
  }
  return days;
}

/** The UTC day before a calendar date. */
function dayBefore(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) - 86_400_000).toISOString().slice(0, 10);
}

const EMPTY_DAY = {
  requests: 0,
  total: 0,
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  missingResponses: 0,
  unreportedRequests: 0,
};

/**
 * Copies one run's accepted events into a forked run identity.
 *
 * This is the shape the fold's comment calls a copied log: the same Provider
 * request ids arrive again under a second run. The bytes are the real run's own
 * — only the session/run identity and the identity-prefixed ids change — and
 * `store.append` accepts them because the target partition is new. The product's
 * own fork route copies conversation messages instead (measured in the app-level
 * evidence), so this copy exists to exercise the cross-run dedup guard, and the
 * control in provider-usage-daily-dedup-control.test.ts shows what the same
 * fixture returns when that guard is bypassed.
 */
async function copyRunLog(
  store: DurableEventStore,
  source: { readonly sessionId: string; readonly runId: string },
  target: { readonly sessionId: string; readonly runId: string },
): Promise<number> {
  const events = await store.read(source.sessionId, source.runId);
  for (const event of events) {
    const outcome = await store.append({
      eventId: event.eventId.replace(source.runId, target.runId),
      idempotencyKey: event.idempotencyKey.replace(source.runId, target.runId),
      sessionId: target.sessionId,
      runId: target.runId,
      type: event.type,
      source: event.source,
      occurredAt: event.occurredAt,
      payload: event.payload,
    });
    expect(outcome.kind).toBe('appended');
  }
  return events.length;
}

async function reappend(store: DurableEventStore, event: DurableHarnessEvent): Promise<string> {
  const outcome = await store.append({
    eventId: event.eventId,
    idempotencyKey: event.idempotencyKey,
    sessionId: event.sessionId,
    runId: event.runId,
    type: event.type,
    source: event.source,
    occurredAt: event.occurredAt,
    payload: event.payload,
  });
  return outcome.kind;
}

describe('O5 real-run daily aggregation', () => {
  it('counts each real Provider attempt once when a retry, a replay, a restart and a copied log are present', async () => {
    const script = scriptedLlm([
      // Capability turn: the first reply is empty, so the reply stage retries once.
      usageResponse('', 50, 7),
      usageResponse('Status answer', 60, 9),
      // Follow-up turn in the same session.
      usageResponse('Follow-up answer', 120, 40),
    ]);
    const runner = await realRunner(script.llm, 'test/model');
    const capability = await runner.run({ text: '你能调用网络了吗？' });
    expect(capability.status).toBe('ok');
    expect(capability.reply).toBe('Status answer');
    const followUp = await runner.run({ sessionId: capability.sessionId, text: 'hello' });
    expect(followUp.status).toBe('ok');
    expect(followUp.reply).toBe('Follow-up answer');
    // The retry is a second real Provider call, not a local re-read.
    expect(script.calls()).toBe(3);

    const store = eventStore(runner);
    const capabilityKey = { sessionId: String(capability.sessionId), runId: capability.runId };
    const followUpKey = { sessionId: String(followUp.sessionId), runId: followUp.runId };
    const capabilityEvents = await store.read(capabilityKey.sessionId, capabilityKey.runId);
    const followUpEvents = await store.read(followUpKey.sessionId, followUpKey.runId);
    const starts = capabilityEvents.filter((event) => event.type === 'model_request_started');
    const responses = capabilityEvents.filter((event) => event.type === 'model_response_received');
    // Real event shapes: two starts, two responses, one settlement each, the
    // second request naming the first as the attempt it retried.
    expect(starts).toHaveLength(2);
    expect(responses).toHaveLength(2);
    expect(capabilityEvents.filter((event) => event.type === 'model_request_settled')).toHaveLength(2);
    const firstRequestId = starts[0]!.payload['requestId'];
    expect(typeof firstRequestId).toBe('string');
    expect(starts[1]!.payload['retryOf']).toBe(firstRequestId);
    expect(starts[1]!.payload['retryReason']).toBe('empty_output');
    expect(responses.map((event) => event.payload['requestId'])).toEqual([
      firstRequestId,
      starts[1]!.payload['requestId'],
    ]);
    expect(responses.map((event) => event.payload['usageStatus'])).toEqual(['available', 'available']);
    expect(responses.map((event) => event.payload['totalTokens'])).toEqual([57, 69]);
    expect(await store.listRunPartitions()).toHaveLength(2);

    // Side A: what the Provider reported, reduced from the accepted events.
    const reports = await providerReports(store);
    expect(reports.responseEvents).toBe(3);
    expect(reports.attempts).toHaveLength(3);
    expect(new Set(reports.attempts.map((attempt) => attempt.requestId)).size).toBe(3);
    expect(reports.attempts.filter((attempt) => attempt.retryOf !== undefined)).toHaveLength(1);
    expect(reports.attempts.reduce((total, attempt) => total + attempt.total, 0)).toBe(286);
    const expected = expectedDays(reports.attempts);
    const range = rangeOver(reports.attempts);

    // Side B: the landed aggregate over the same log.
    const service = freshService();
    await indexAll(service);
    const indexed = seriesFor(service, range);
    expect(indexed.totals).toEqual({
      total: 286,
      input: 230,
      output: 56,
      cached: 0,
      reasoning: 0,
      requests: 3,
      activeDays: expected.size,
      peak: [...expected.entries()]
        .map(([date, day]) => ({ date, total: day.total }))
        .sort((left, right) => right.total - left.total)[0],
    });
    expect(indexed.totals.total).toBe(286);
    expect(indexed.totals.input).toBe(230);
    expect(indexed.totals.output).toBe(56);
    expect(indexed.totals.requests).toBe(3);
    // Every counted attempt is a distinct Provider request id, and each day's
    // rows agree with the Provider reports rather than with the range total.
    expect(indexed.coverage).toMatchObject({
      indexedRuns: 2,
      indexedSessions: 1,
      attempts: 3,
      duplicateAttempts: 0,
      missingResponses: 0,
      unreportedRequests: 0,
      unreadableRuns: 0,
    });
    for (const day of indexed.days) {
      const row = expected.get(day.date);
      if (row) expect(day).toMatchObject({ state: 'recorded', ...row });
      else expect(day).toMatchObject({ state: 'empty', requests: 0, total: 0 });
    }
    expect(indexed.days.reduce((total, day) => total + day.total, 0)).toBe(indexed.totals.total);
    expect(indexed.days.reduce((count, day) => count + day.requests, 0)).toBe(indexed.totals.requests);
    expect(indexed.days.filter((day) => day.requests > 0)).toHaveLength(indexed.totals.activeDays);

    // Replay: the store refuses the same events a second time, so a recovered or
    // replayed run cannot add a duplicate attempt.
    const replayOutcomes: string[] = [];
    for (const event of capabilityEvents) replayOutcomes.push(await reappend(store, event));
    expect(new Set(replayOutcomes)).toEqual(new Set(['duplicate']));
    expect((await store.read(capabilityKey.sessionId, capabilityKey.runId)).length)
      .toBe(capabilityEvents.length);

    // A copied log (the shape a cross-run dedup guard exists for): the same
    // request ids arrive again under two forked run identities.
    const copiedEvents =
      await copyRunLog(store, capabilityKey, { sessionId: `${capabilityKey.sessionId}-branch`, runId: `${capabilityKey.runId}-branch` })
      + await copyRunLog(store, followUpKey, { sessionId: `${followUpKey.sessionId}-branch`, runId: `${followUpKey.runId}-branch` });
    expect(copiedEvents).toBe(capabilityEvents.length + followUpEvents.length);
    expect(await store.listRunPartitions()).toHaveLength(4);

    const pass = await service.runPass({ budget: 512, restart: true });
    expect(pass).toMatchObject({ status: 'complete', partitions: 4, indexed: 2 });
    const afterCopy = seriesFor(service, range);
    // Identical numbers: the copies are the same Provider attempts, counted once.
    expect(afterCopy.totals).toEqual(indexed.totals);
    expect(afterCopy.coverage).toMatchObject({
      indexedRuns: 4,
      // Both real runs live in one session, so their two copies share one
      // forked session identity: the copied log adds a second session, not a
      // third.
      indexedSessions: 2,
      attempts: 3,
      duplicateAttempts: 3,
    });
    expect(afterCopy.coverage.statement).toContain('同一 requestId 只计一次（已合并 3 条重复事件）');

    // Restart: a new store and a new service over the same data root rebuild the
    // same series from the same events.
    const restarted = freshService();
    await indexAll(restarted);
    expect(comparable(seriesFor(restarted, range))).toEqual(comparable(afterCopy));
  });

  it('keeps a day with no events distinct from a day whose call reported zero', async () => {
    const script = scriptedLlm([usageResponse('Zero-cost answer', 0, 0)]);
    const runner = await realRunner(script.llm, 'test/zero-model');
    const run = await runner.run({ text: 'hello' });
    expect(run.status).toBe('ok');
    expect(script.calls()).toBe(1);

    const store = eventStore(runner);
    const responseEvent = (await store.read(String(run.sessionId), run.runId))
      .find((event) => event.type === 'model_response_received');
    // The real event carries a reported zero, not an absent usage report.
    expect(responseEvent?.payload).toMatchObject({
      usageStatus: 'available',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    const service = freshService();
    await indexAll(service);
    const runDate = String(responseEvent?.occurredAt).slice(0, 10);
    const emptyDate = dayBefore(runDate);
    const series = seriesFor(service, { from: emptyDate, to: runDate });

    expect(series.days.map((day) => day.date)).toEqual([emptyDate, runDate]);
    // A day with no recorded call at all.
    expect(series.days[0]).toEqual({ date: emptyDate, state: 'empty', ...EMPTY_DAY });
    // A day whose call happened and reported zero: not "no events", and not
    // missing coverage either.
    expect(series.days[1]).toEqual({ date: runDate, state: 'recorded', ...EMPTY_DAY, requests: 1 });
    expect(series.totals.activeDays).toBe(1);
    expect(series.coverage).toMatchObject({ missingResponses: 0, unreportedRequests: 0, attempts: 1 });
    expect(series.coverage.statement).toContain('其余日期没有记录（不是 0）');

    // The zero is a report about a call that happened, not an absent row: the
    // identity that made the call stays 'recorded' while an identity that never
    // called is 'empty' on the same dates. The filter uses the identity the
    // event actually recorded.
    const recordedModel = String(responseEvent?.payload['model']);
    expect(recordedModel.length).toBeGreaterThan(0);
    expect(seriesFor(service, { from: emptyDate, to: runDate, model: recordedModel }).days[1])
      .toMatchObject({ state: 'recorded', requests: 1, total: 0 });
    expect(seriesFor(service, { from: emptyDate, to: runDate, model: `${recordedModel}-absent` }).days[1])
      .toEqual({ date: runDate, state: 'empty', ...EMPTY_DAY });
  });

  it('rebuilds the same series from the persisted events alone', async () => {
    const script = scriptedLlm([usageResponse('Rebuild answer', 100, 20)]);
    const runner = await realRunner(script.llm, 'test/model');
    const run = await runner.run({ text: 'hello' });
    expect(run.status).toBe('ok');

    const service = freshService();
    await indexAll(service);
    const reports = await providerReports(eventStore(runner));
    const range = rangeOver(reports.attempts);
    const before = seriesFor(service, range);
    expect(before.totals).toMatchObject({ total: 120, input: 100, output: 20, requests: 1 });
    const indexFile = join(
      ProviderUsageDailyIndexStore.pathsFor(dataDir).directory,
      'provider-usage-daily-index.json',
    );
    expect(existsSync(indexFile)).toBe(true);

    // The derived index is deleted entirely; only the durable events remain.
    rmSync(ProviderUsageDailyIndexStore.pathsFor(dataDir).directory, { recursive: true, force: true });
    expect(existsSync(indexFile)).toBe(false);
    const rebuilt = freshService();
    await indexAll(rebuilt);
    const after = seriesFor(rebuilt, range);
    expect(comparable(after)).toEqual(comparable(before));
    // The rebuild still agrees with the Provider's report, not merely with the
    // pre-deletion numbers.
    expect(after.totals).toMatchObject({
      total: reports.attempts.reduce((total, attempt) => total + attempt.total, 0),
      requests: reports.attempts.length,
    });
  });
});
