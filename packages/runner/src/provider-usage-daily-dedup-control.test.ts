// O5 negative control: the Step-1 assertions are load-bearing, not vacuous.
//
// provider-usage-daily-real-run.test.ts asserts that a copied real log does not
// add consumption. This file takes the SAME fixture — real runner events plus a
// verbatim copy of one run's log under a forked run identity — and shows that
// the shipped numbers come out doubled when the cross-run dedup is bypassed.
// Nothing here is a product requirement: it exists so the green test is
// falsifiable, and so a future change that removes the dedup cannot silently
// keep the green test passing.
//
// How the bypass is built (same build, no source edit):
//   1. The shipped `ProviderUsageDailyService` query path folds every indexed run
//      through ONE `foldProviderUsageDailyRuns({ runs })` call, which is where
//      "the same requestId counts once" lives. The bypass calls the same shipped
//      fold once per run and concatenates the attempt facts — every other stage,
//      including the fold's own ordering and missing-coverage handling, is the
//      shipped code.
//   2. The identity-level bypass is empirical rather than structural: the same
//      copied log with re-minted request ids runs through the untouched
//      pipeline, which is what would happen if a copy did not preserve the
//      Provider request id.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { PROVIDER_USAGE_DAILY_VERSION } from '@littlesheep/types';
import type { AgentRunner, CreateRunnerOptions } from './runner.js';
import { createRunner } from './runner.js';
import { DurableEventStore } from './durable-event-store.js';
import { foldProviderUsageDailyRuns } from './provider-usage-daily-fold.js';
import { ProviderUsageDailyService } from './provider-usage-daily-service.js';
import { buildProviderUsageDailySeries } from './provider-usage-daily-series.js';

type LlmClient = NonNullable<CreateRunnerOptions['llm']>;
type ChatRequest = Parameters<LlmClient['chat']>[0];
type StreamChunk = Parameters<Parameters<LlmClient['chatStream']>[1]>[0];

let dataDir: string;
const runners: AgentRunner[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-o5-dedup-control-'));
  mkdirSync(join(dataDir, 'workplace'), { recursive: true });
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  runners.length = 0;
});

afterEach(async () => {
  for (const runner of runners) await runner.shutdown().catch(() => undefined);
  delete process.env.LITTLESHEEP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

async function realRun(): Promise<{ readonly runner: AgentRunner; readonly sessionId: string; readonly runId: string }> {
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.workspace = join(dataDir, 'workplace');
  const llm: LlmClient = {
    chat: vi.fn(async (_request: ChatRequest) => ({
      content: 'Control answer',
      toolCalls: [],
      finishReason: 'stop' as const,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 0 },
    })),
    chatStream: vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      onDelta({ type: 'delta', delta: 'Control answer' });
      onDelta({ type: 'done', finishReason: 'stop' });
      return {
        content: 'Control answer',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 0 },
      };
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  };
  const runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/control-model',
    llm,
    skillsDirs: [],
    containerRoot: dataDir,
  });
  runners.push(runner);
  const run = await runner.run({ text: 'hello' });
  expect(run.status).toBe('ok');
  return { runner, sessionId: String(run.sessionId), runId: run.runId };
}

/**
 * Verbatim copy of a real run's log under a forked identity, optionally
 * re-minting the Provider request ids so the shipped pipeline cannot recognise
 * the copy. Only session/run identity, the identity-prefixed event ids and
 * (optionally) the request ids change; every usage byte is the real one.
 *
 * A re-mint has to replace the id everywhere it appears in a payload — the
 * durable reducer refuses a `model_request_started` whose cache observation
 * names a different request — so the replacement is textual over the whole
 * payload, which is also what "the copy minted new ids" means in practice.
 */
async function copyLog(
  store: DurableEventStore,
  source: { readonly sessionId: string; readonly runId: string },
  options: { readonly reissueRequestIds: boolean },
): Promise<void> {
  const events = await store.read(source.sessionId, source.runId);
  const requestIds = events
    .filter((event) => event.type === 'model_request_started')
    .map((event) => String(event.payload['requestId']));
  const reissued = new Map(requestIds.map((requestId) => [requestId, `${requestId}-reissued`]));
  const target = { sessionId: `${source.sessionId}-branch`, runId: `${source.runId}-branch` };
  for (const event of events) {
    let payload = event.payload;
    if (options.reissueRequestIds && reissued.size > 0) {
      let serialized = JSON.stringify(event.payload);
      for (const [original, replacement] of reissued) serialized = serialized.replaceAll(original, replacement);
      payload = JSON.parse(serialized) as Record<string, unknown>;
    }
    const outcome = await store.append({
      eventId: event.eventId.replace(source.runId, target.runId),
      idempotencyKey: event.idempotencyKey.replace(source.runId, target.runId),
      sessionId: target.sessionId,
      runId: target.runId,
      type: event.type,
      source: event.source,
      occurredAt: event.occurredAt,
      payload,
    });
    expect(outcome.kind).toBe('appended');
  }
}

function serviceFor(): ProviderUsageDailyService {
  return new ProviderUsageDailyService({
    dataRoot: dataDir,
    eventSource: new DurableEventStore({ rootDir: join(dataDir, 'durable-events') }),
    stepDelayMs: 1,
  });
}

async function indexAll(service: ProviderUsageDailyService): Promise<void> {
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const result = await service.runPass({ budget: 512, restart: guard === 1 });
    if (!result.hasMore) return;
  }
  throw new Error('indexing did not converge');
}

describe('O5 dedup control', () => {
  it('double counts the copied log when the cross-run fold is bypassed, so the landed assertion is falsifiable', async () => {
    const run = await realRun();
    const store = run.runner.infra.durableEventStore as unknown as DurableEventStore;
    await copyLog(store, { sessionId: run.sessionId, runId: run.runId }, { reissueRequestIds: false });
    expect(await store.listRunPartitions()).toHaveLength(2);

    const service = serviceFor();
    await indexAll(service);
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const query = { from, to, timezone: 'UTC', timezoneSource: 'request' as const };

    // Landed behaviour: the copied attempt keeps its Provider request id, so it
    // is the same billable attempt and counts once.
    const landed = service.query(query);
    expect(landed.totals).toMatchObject({ requests: 1, total: 120, activeDays: 1 });
    expect(landed.coverage).toMatchObject({ indexedRuns: 2, attempts: 1, duplicateAttempts: 1 });

    // Bypass 1 — dedup disabled: fold each indexed run on its own with the
    // shipped fold and concatenate, then feed the shipped series stage.
    const indexedRuns = service.indexStore.runs;
    expect(indexedRuns).toHaveLength(2);
    const perRun = indexedRuns.flatMap((indexedRun) => (
      foldProviderUsageDailyRuns({ runs: [indexedRun] }).attempts
    ));
    const bypassed = buildProviderUsageDailySeries({
      timezone: 'UTC',
      timezoneSource: 'request',
      from,
      to,
      filters: {},
      attempts: perRun,
      missing: [],
      coverage: {
        indexedRuns: indexedRuns.length,
        indexedSessions: indexedRuns.length,
        attempts: perRun.length,
        missingResponses: 0,
        unreportedRequests: 0,
        unreadableRuns: 0,
        modes: { next: indexedRuns.length, shadow: 0, unknown: 0 },
        duplicateAttempts: 0,
        projectionBuilt: true,
        stale: false,
        retainedAfterDeleteSessions: 0,
        backfill: {
          status: 'complete',
          partitions: indexedRuns.length,
          processed: indexedRuns.length,
          indexed: indexedRuns.length,
          failed: 0,
        },
      },
      now: new Date(),
    });
    // Red for the landed expectation above: the same fixture now reports 240.
    expect(bypassed.totals).toMatchObject({ requests: 2, total: 240, activeDays: 1 });
    expect(bypassed.version).toBe(PROVIDER_USAGE_DAILY_VERSION);

    // The literal red: the Step-1 assertion, applied to the dedup-bypassed
    // series, throws instead of passing.
    let failure: string | undefined;
    try {
      expect(bypassed.totals).toMatchObject({ requests: 1, total: 120, activeDays: 1 });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBeDefined();
    expect(failure).toContain('240');
    console.log(`O5 dedup control (fold bypassed): ${failure?.split('\n')[0]}`);
  });

  it('double counts the same real log when the copy re-mints Provider request ids', async () => {
    const run = await realRun();
    const store = run.runner.infra.durableEventStore as unknown as DurableEventStore;
    await copyLog(store, { sessionId: run.sessionId, runId: run.runId }, { reissueRequestIds: true });

    const service = serviceFor();
    await indexAll(service);
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const series = service.query({ from, to, timezone: 'UTC', timezoneSource: 'request' });

    // The untouched pipeline has no way to tell the copy from a second real
    // attempt: identity is the Provider request id, and the copy changed it.
    expect(series.totals).toMatchObject({ requests: 2, total: 240 });
    expect(series.coverage).toMatchObject({ indexedRuns: 2, attempts: 2, duplicateAttempts: 0 });

    // The literal red for the same Step-1 expectation.
    let failure: string | undefined;
    try {
      expect(series.totals).toMatchObject({ requests: 1, total: 120 });
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).toBeDefined();
    expect(failure).toContain('240');
    console.log(`O5 dedup control (ids reissued): ${failure?.split('\n')[0]}`);
  });
});
