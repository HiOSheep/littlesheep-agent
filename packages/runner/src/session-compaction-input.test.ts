// SP-07: a compaction request carries only what a summary needs.
//
// Compaction merges an older transcript into a versioned summary. It makes no
// judgement that a capability snapshot, retrieval rule or volatile run state
// could inform, and those blocks are re-billed on every attempt (up to two).
// Measured in the harness before this change: the injected Runtime facts block
// was 355 bytes against a 32-byte payload for a trivial range -- eleven times
// the content being summarized.
//
// This is a source-level assertion plus a live check, because the compaction
// prompt and its request options are inline in the compaction call.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { createRunner } from './runner.js';
import { textResponse } from '../../harness/src/tests/helpers.js';

const source = readFileSync(new URL('./session-continuity.ts', import.meta.url), 'utf8');
const created: Array<{ shutdown: () => Promise<void> }> = [];

afterAll(async () => {
  for (const runner of created) {
    try {
      await runner.shutdown();
    } catch {
      // Best-effort teardown: a shutdown failure must not fail the assertions.
    }
  }
});

describe('session compaction input boundary', () => {
  /**
   * A runner whose session compacts after one run. Compaction is triggered by real
   * context pressure, not by a message count: a tiny compression ratio makes the
   * occupancy check fire on the first non-empty prompt, which is what a long
   * session would hit naturally.
   */
  async function createCompactionRunner(llm: unknown) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.defaults.contextCompressionThresholdRatio = 0.000_001;
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm: llm as never,
    });
    created.push(runner);
    return runner;
  }

  it('marks the compaction request as summary-only', () => {
    // The request recorder must not inject the Runtime tail into it.
    expect(source).toMatch(/session_compaction[\s\S]{0,1200}skipRuntimeTail: true/u);
  });

  it('still states the summary contract and fidelity priorities', () => {
    // The simplification must not touch the prompt contract itself.
    expect(source).toContain('You maintain a versioned session summary for an AI agent.');
    expect(source).toContain('Allowed `branch` values are exactly: long-term, project, experience');
    expect(source).toContain('Preserve unfinished work, open decisions, artifact paths and exact `label: value` pairs');
    expect(source).toContain('Return one JSON object with `summary` and `candidates`.');
  });

  it('sends no capability snapshot, retrieval contract or run state to the summarizer', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    // Pressure-triggered compaction, as in a real long session.
    config.agents.defaults.contextCompressionThresholdRatio = 0.000_001;
    config.sessions.compaction.threshold = 2;
    config.sessions.compaction.keepRecent = 1;
    const llm = {
      chat: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const system = String(request.messages[0]?.content ?? '');
        if (system.includes('versioned session summary')) return textResponse('summary text');
        return textResponse('ok');
      }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    };
    const runner = await createRunner({
      config,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm: llm as never,
    });
    created.push(runner);

    const result = await runner.run({ text: 'remember this request' });
    const calls = llm.chat.mock.calls as unknown as Array<[{ messages: Array<{ content: unknown }> }]>;
    const compaction = calls.find(([request]) => (
      String(request.messages[0]?.content ?? '').includes('versioned session summary')
    ));
    expect(compaction, 'a compaction request was recorded').toBeDefined();
    const carried = compaction![0].messages
      .map((message) => String(message.content))
      .join('\n');

    // The summary request is the summarizer prompt plus the transcript.
    expect(carried).toContain('versioned session summary');
    expect(carried).toContain('New messages to merge:');
    // Nothing about the Runtime's capability or run state belongs here.
    expect(carried).not.toContain('# Runtime Facts');
    expect(carried).not.toContain('Runtime retrieval intent');
    expect(carried).not.toContain('# Runtime State');
    expect(carried).not.toContain('capability_epoch');
    expect(carried).not.toContain('permission_policy');

    // The run published the summary and the boundary did not change.
    const metadata = await runner.sessionManager.loadMetadata(result.sessionId);
    expect(metadata?.compaction?.summary).toBe('summary text');
  });

  it('counts a retried summary attempt into the operation cost', async () => {
    const llm = {
      chat: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const system = String(request.messages[0]?.content ?? '');
        if (!system.includes('versioned session summary')) return textResponse('ok');
        summaryCalls += 1;
        // The first answer is unusable, so the operation issues a second request.
        return summaryCalls === 1
          ? textResponse('a summary that is not JSON')
          : textResponse(JSON.stringify({ summary: 'second attempt summary', candidates: [] }));
      }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    };
    const runner = await createCompactionRunner(llm);
    let summaryCalls = 0;

    const result = await runner.run({ text: 'remember this request' });

    expect(summaryCalls).toBe(2);
    const operation = runner.compactionOperations?.()[0];
    expect(operation).toMatchObject({
      status: 'completed',
      result: 'compacted',
      // Both issued requests count, not only the one that produced a summary.
      usage: { requestCount: 2, retryRequests: 1, usageStatus: 'unavailable' },
    });
    // No usage was reported, so no token totals are invented.
    expect(operation?.usage?.totalTokens).toBeUndefined();
    const metadata = await runner.sessionManager.loadMetadata(result.sessionId);
    expect(metadata?.compaction?.summary).toBe('second attempt summary');
  });

  it('counts attempts that never reached a response into the operation cost', async () => {
    // A transport error produces no Provider usage at all, so a cost report built
    // only from responses would show nothing spent for a request that was issued.
    const failing = {
      chat: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const system = String(request.messages[0]?.content ?? '');
        if (!system.includes('versioned session summary')) return textResponse('ok');
        throw new Error('provider unreachable');
      }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    };
    const failingRunner = await createCompactionRunner(failing);
    const failedRun = await failingRunner.run({ text: 'remember this request' });

    const failedOperation = failingRunner.compactionOperations?.()[0];
    expect(failedOperation).toMatchObject({
      status: 'failed',
      usage: { requestCount: 1, failedRequests: 1, usageStatus: 'unavailable' },
    });
    expect(failedOperation?.usage?.totalTokens).toBeUndefined();
    // A failed switch leaves the session without a summary rather than with a
    // half-installed one.
    const metadata = await failingRunner.sessionManager.loadMetadata(failedRun.sessionId);
    expect(metadata?.compaction).toBeUndefined();

    // The mixed case: one unusable answer, then a transport failure.
    let summaryCalls = 0;
    const mixed = {
      chat: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const system = String(request.messages[0]?.content ?? '');
        if (!system.includes('versioned session summary')) return textResponse('ok');
        summaryCalls += 1;
        if (summaryCalls === 1) return textResponse('a summary that is not JSON');
        throw new Error('provider unreachable');
      }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    };
    const mixedRunner = await createCompactionRunner(mixed);
    await mixedRunner.run({ text: 'remember this request' });

    expect(mixedRunner.compactionOperations?.()[0]).toMatchObject({
      status: 'failed',
      usage: { requestCount: 2, retryRequests: 1, failedRequests: 1, usageStatus: 'unavailable' },
    });
  });
});
