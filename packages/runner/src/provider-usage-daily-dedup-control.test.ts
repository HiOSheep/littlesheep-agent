// O5 negative control: the Step-1 assertions are load-bearing, not vacuous.
//
// provider-usage-daily-real-run.test.ts asserts that a real retry plus a copied
// real log still counts each Provider attempt once (3 attempts / 286 tokens).
// This file builds the SAME fixture — the same scripted LlmClient, the same
// capability turn whose empty first reply triggers a real `retryOf` retry, the
// same follow-up turn, the same verbatim copy of both runs under forked run
// identities — and shows that the shipped numbers double when the cross-run
// deduplication is bypassed. Nothing here is a product requirement: it exists so
// the green test is falsifiable, and so a change that removes the dedup cannot
// keep the green test passing.
//
// How the bypass is built (same build, no source edit):
//   1. The shipped query path folds every indexed run through ONE
//      `foldProviderUsageDailyRuns({ runs })` call, which is where "the same
//      requestId counts once" lives. The bypass calls the same shipped fold once
//      per run and concatenates the attempt facts into the shipped series stage;
//      every other stage is untouched.
//   2. The identity-level bypass is empirical rather than structural: the same
//      copied log with re-minted request ids runs through the untouched
//      pipeline, which is what a copy that did not preserve the Provider request
//      id would look like.
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

interface ControlFixture {
  readonly runner: AgentRunner;
  readonly store: DurableEventStore;
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly runId: string }>;
  readonly from: string;
  readonly to: string;
}

/**
 * The Step-1 fixture, reproduced: a capability turn with an empty first reply
 * (real retry, two billed attempts) plus a follow-up turn, both written by the
 * real runner.
 */
async function stepOneFixture(): Promise<ControlFixture> {
  const responses = [
    usageResponse('', 50, 7),
    usageResponse('Status answer', 60, 9),
    usageResponse('Follow-up answer', 120, 40),
  ];
  const queue = [...responses];
  const next = (): ChatResponse => {
    const response = queue.shift();
    if (!response) throw new Error('unexpected Provider call: the script is exhausted');
    return response;
  };
  const llm: LlmClient = {
    chat: vi.fn(async (_request: ChatRequest) => next()),
    chatStream: vi.fn(async (_request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
      const response = next();
      if (response.content) onDelta({ type: 'delta', delta: response.content });
      onDelta({ type: 'done', finishReason: response.finishReason });
      return response;
    }),
    embed: vi.fn(async () => ({ embeddings: [], model: 'test', usage: { promptTokens: 0 } })),
  };
  const config = structuredClone(DEFAULT_CONFIG);
  config.agents.defaults.workspace = join(dataDir, 'workplace');
  const runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'test/model',
    llm,
    skillsDirs: [],
    containerRoot: dataDir,
  });
  runners.push(runner);
  const capability = await runner.run({ text: '你能调用网络了吗？' });
  expect(capability.status, capability.error).toBe('ok');
  const followUp = await runner.run({ sessionId: capability.sessionId, text: 'hello' });
  expect(followUp.status, followUp.error).toBe('ok');
  const store = runner.infra.durableEventStore as unknown as DurableEventStore;
  const sessions = [
    { sessionId: String(capability.sessionId), runId: capability.runId },
    { sessionId: String(followUp.sessionId), runId: followUp.runId },
  ];
  const responseEvent = (await store.read(sessions[0]!.sessionId, sessions[0]!.runId))
    .find((event) => event.type === 'model_response_received');
  const day = String(responseEvent?.occurredAt).slice(0, 10);
  return { runner, store, sessions, from: day, to: day };
}

/**
 * Verbatim copy of a real run's log under a forked identity, optionally
 * re-minting the Provider request ids so the shipped pipeline cannot recognise
 * the copy. Only session/run identity, the identity-prefixed event ids and
 * (optionally) the request ids change; every usage byte is the real one.
 *
 * A re-mint replaces the id everywhere it appears in a payload — the durable
 * reducer refuses a request whose cache observation names a different id — so
 * the replacement is textual over the whole payload, which is also what "the
 * copy minted new ids" means in practice.
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

/** The Step-1 expectation, re-applied to a series, as a literal failure string. */
function landedExpectationFailure(series: { totals: unknown }): string | undefined {
  try {
    expect(series.totals).toMatchObject({ requests: 3, total: 286, activeDays: 1 });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('O5 dedup control', () => {
  it('double counts the Step-1 fixture when the cross-run fold is bypassed', async () => {
    const fixture = await stepOneFixture();
    for (const run of fixture.sessions) {
      await copyLog(fixture.store, run, { reissueRequestIds: false });
    }
    expect(await fixture.store.listRunPartitions()).toHaveLength(4);

    const service = serviceFor();
    await indexAll(service);
    const query = {
      from: fixture.from,
      to: fixture.to,
      timezone: 'UTC',
      timezoneSource: 'request' as const,
    };

    // Landed behaviour (what the Step-1 test asserts): the copied attempts keep
    // their Provider request ids, so they are the same billable attempts.
    const landed = service.query(query);
    expect(landed.totals).toMatchObject({ requests: 3, total: 286, activeDays: 1 });
    expect(landed.coverage).toMatchObject({ indexedRuns: 4, attempts: 3, duplicateAttempts: 3 });
    expect(landedExpectationFailure(landed)).toBeUndefined();

    // Bypass 1 — dedup disabled: fold each indexed run on its own with the
    // shipped fold and concatenate, then feed the shipped series stage.
    const indexedRuns = service.indexStore.runs;
    expect(indexedRuns).toHaveLength(4);
    const perRun = indexedRuns.flatMap((indexedRun) => (
      foldProviderUsageDailyRuns({ runs: [indexedRun] }).attempts
    ));
    const bypassed = buildProviderUsageDailySeries({
      timezone: 'UTC',
      timezoneSource: 'request',
      from: fixture.from,
      to: fixture.to,
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
    expect(bypassed.totals).toMatchObject({ requests: 6, total: 572, activeDays: 1 });
    expect(bypassed.version).toBe(PROVIDER_USAGE_DAILY_VERSION);

    // The literal red: the Step-1 expectation, applied to the dedup-bypassed
    // series, throws instead of passing.
    const failure = landedExpectationFailure(bypassed);
    expect(failure).toBeDefined();
    expect(failure).toContain('572');
    console.log(`O5 dedup control (fold bypassed): ${failure?.split('\n')[0]}`);
  });

  it('double counts the Step-1 fixture when a copy re-mints Provider request ids', async () => {
    const fixture = await stepOneFixture();
    for (const run of fixture.sessions) {
      await copyLog(fixture.store, run, { reissueRequestIds: true });
    }
    expect(await fixture.store.listRunPartitions()).toHaveLength(4);

    const service = serviceFor();
    await indexAll(service);
    const series = service.query({
      from: fixture.from,
      to: fixture.to,
      timezone: 'UTC',
      timezoneSource: 'request',
    });

    // The untouched pipeline cannot tell the copy from a second real attempt:
    // identity is the Provider request id, and the copy changed it.
    expect(series.totals).toMatchObject({ requests: 6, total: 572 });
    expect(series.coverage).toMatchObject({ indexedRuns: 4, attempts: 6, duplicateAttempts: 0 });

    // The literal red for the same Step-1 expectation.
    const failure = landedExpectationFailure(series);
    expect(failure).toBeDefined();
    expect(failure).toContain('572');
    console.log(`O5 dedup control (ids reissued): ${failure?.split('\n')[0]}`);
  });
});
