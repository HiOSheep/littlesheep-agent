import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  judgeNodes,
  projectSessions,
  readLedger,
  summarizeSessions,
  totalsOf,
} from './session-cache-ledger.mjs';

const roots = [];

function makeDataRoot({ logs = [], observations = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'ls-session-ledger-'));
  roots.push(root);
  mkdirSync(join(root, 'execution-logs'), { recursive: true });
  mkdirSync(join(root, 'cache-observations'), { recursive: true });
  logs.forEach((log, index) => {
    writeFileSync(join(root, 'execution-logs', `${index + 1}-${log.runId}.json`), JSON.stringify(log));
  });
  observations.forEach((observation, index) => {
    writeFileSync(join(root, 'cache-observations', `obs-${index + 1}.json`), JSON.stringify(observation));
  });
  return root;
}

function request({ id, purpose, at, input, cached, uncached, retryOf }) {
  return {
    id,
    createdAt: at,
    ...(retryOf ? { retryOf } : {}),
    callContract: { purpose },
    ...(input === undefined ? {
      cacheObservation: { providerPrompt: { status: 'unavailable', reason: 'provider_request_failed' } },
    } : {
      cacheObservation: {
        providerPrompt: {
          status: 'complete',
          tokenCount: input,
          cachedTokenCount: cached,
          uncachedTokenCount: uncached ?? input - cached,
        },
      },
    }),
  };
}

function runLog({ sessionId, runId, startedAt, requests, usageCompleteness = 'complete' }) {
  return {
    runId,
    sessionId,
    startedAt,
    status: 'ok',
    usage: { usageCompleteness },
    modelRequests: requests,
  };
}

function observation({
  requestKind, modelRequestId, sessionDigest, input, cached, uncached,
  components, stablePrefixFingerprint, invalidationReasons,
}) {
  return {
    storedAt: '2026-09-22T00:00:00.000Z',
    observation: {
      requestKind,
      modelRequestId,
      scope: { sessionDigest },
      stablePrefix: { fingerprint: stablePrefixFingerprint ?? 'stable-1', byteLength: 14_000, itemCount: 3 },
      normalizedRequest: { byteLength: input },
      invalidationReasons: invalidationReasons ?? [],
      ...(components ? { promptComponents: components } : {}),
      providerPrompt: {
        status: 'complete',
        tokenCount: input,
        cachedTokenCount: cached,
        uncachedTokenCount: uncached ?? input - cached,
      },
    },
  };
}

const DIGEST = 'digest-session-a';

function twoTurnSample(extra = {}) {
  return makeDataRoot({
    logs: [
      runLog({
        sessionId: 'session-a',
        runId: 'run-1',
        startedAt: '2026-09-22T01:00:00.000Z',
        requests: [request({
          id: 'req-1', purpose: 'execute_tool_loop', at: '2026-09-22T01:00:01.000Z', input: 4000, cached: 200,
        })],
      }),
      runLog({
        sessionId: 'session-a',
        runId: 'run-2',
        startedAt: '2026-09-22T01:01:00.000Z',
        requests: [
          request({
            id: 'req-2', purpose: 'execute_tool_loop', at: '2026-09-22T01:01:01.000Z', input: 4600, cached: 4400,
          }),
          request({
            id: 'req-3', purpose: 'reply', at: '2026-09-22T01:01:20.000Z', input: 4400, cached: 4400,
          }),
        ],
      }),
    ],
    observations: [
      observation({
        requestKind: 'execute_tool_loop', modelRequestId: 'req-1', sessionDigest: DIGEST, input: 4000, cached: 200,
      }),
    ],
    ...extra,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session-cumulative cache ledger', () => {
  it('sums the session turns including the cold start instead of averaging percentages', () => {
    const ledger = readLedger(twoTurnSample());
    const projection = projectSessions(ledger);
    const session = projection.sessions[0];

    // 200/4000 = 5.0 % and 8800/9000 = 97.78 %; the average would be 51.39 %.
    expect(session.sessionProjection.requests).toBe(3);
    expect(session.sessionProjection.input).toBe(13_000);
    expect(session.sessionProjection.cached).toBe(9_000);
    expect(session.sessionProjection.hitPercent).toBeCloseTo((9_000 / 13_000) * 100, 6);
    expect(session.sessionProjection.withinTarget).toBe(false);
    // The curve is per request and cumulative, so attribution can read it later.
    expect(session.requestCurve.map((row) => row.cumulativeHitPercent)).toEqual([
      5, (4600 / 8600) * 100, (9000 / 13000) * 100,
    ]);
  });

  it('keeps detached compaction out of H_ui while H_all carries it', () => {
    const root = twoTurnSample();
    writeFileSync(join(root, 'cache-observations', 'detached-compaction.json'), JSON.stringify(observation({
      requestKind: 'session_compaction', modelRequestId: 'req-compaction', sessionDigest: DIGEST, input: 2000, cached: 0,
    })));

    const projection = projectSessions(readLedger(root));
    const session = projection.sessions[0];

    expect(session.sessionProjection.input).toBe(13_000);
    expect(session.sessionProjection.requests).toBe(3);
    expect(session.auxiliary.requests).toBe(1);
    expect(session.auxiliary.input).toBe(2_000);
    expect(session.auxiliaryByPurpose.map((entry) => entry.purpose)).toEqual(['session_compaction']);
    expect(session.all.input).toBe(15_000);
    expect(session.all.cached).toBe(9_000);
    expect(projection.ledger.requests).toBe(4);
    expect(projection.coverage.detachedObservations).toBe(1);
  });

  it('counts missing provider usage as unavailable and never lets a node pass on it', () => {
    const root = twoTurnSample();
    const ledger = readLedger(root);
    const projection = projectSessions(ledger, {
      turnsBySession: {
        'session-a': [
          { turn: 1, id: 'investigation', label: '调查完成', runId: 'run-1' },
          { turn: 2, id: 'delivery', label: '交付完成', runId: 'run-2' },
        ],
      },
    });
    const [first, second] = projection.sessions[0].nodes;

    expect(first.hitPercent).toBeCloseTo(5, 6);
    expect(first.withinTarget).toBe(false);
    expect(second.cumulativeRequests).toBe(3);
    expect(second.input).toBe(13_000);
    expect(judgeNodes([first, second])).toMatchObject({ conclusion: 'not met' });
    expect(judgeNodes([first, second]).failures.map((failure) => failure.id))
      .toEqual(['investigation', 'delivery']);

    // One request loses its usage: the node stays incomplete even though the
    // measured sum would look perfect on its own.
    const broken = makeDataRoot({
      logs: [
        runLog({
          sessionId: 'session-b',
          runId: 'run-1',
          startedAt: '2026-09-22T02:00:00.000Z',
          requests: [request({ id: 'req-1', purpose: 'execute_tool_loop', at: '2026-09-22T02:00:01.000Z', input: 4000, cached: 3900 })],
          usageCompleteness: 'partial',
        }),
        runLog({
          sessionId: 'session-b',
          runId: 'run-2',
          startedAt: '2026-09-22T02:01:00.000Z',
          requests: [request({ id: 'req-2', purpose: 'execute_tool_loop', at: '2026-09-22T02:01:01.000Z' })],
        }),
      ],
    });
    const brokenProjection = projectSessions(readLedger(broken), {
      turnsBySession: {
        'session-b': [
          { turn: 1, id: 'investigation', label: '调查完成', runId: 'run-1' },
          { turn: 2, id: 'delivery', label: '交付完成', runId: 'run-2' },
        ],
      },
    });
    const node = brokenProjection.sessions[0].nodes[1];
    expect(node.availability).toBe('incomplete');
    expect(node.withinTarget).toBeUndefined();
    expect(judgeNodes(brokenProjection.sessions[0].nodes)).toMatchObject({
      conclusion: 'not met',
      failures: [{ id: 'delivery', reason: 'incomplete usage' }],
    });
  });

  it('reports a frozen turn that never ran instead of shrinking the sum', () => {
    const projection = projectSessions(readLedger(twoTurnSample()), {
      turnsBySession: {
        'session-a': [
          { turn: 1, id: 'investigation', label: '调查完成', runId: 'run-1' },
          { turn: 2, id: 'delivery', label: '交付完成', runId: 'run-2' },
          { turn: 3, id: 'verification', label: '验证完成', runId: 'run-3' },
        ],
      },
    });
    const nodes = projection.sessions[0].nodes;
    expect(nodes[2]).toMatchObject({ id: 'verification', missingTurnRequests: true, availability: 'incomplete' });
    expect(judgeNodes(nodes).conclusion).toBe('not met');
  });

  it('counts retries additively and flags a sample above the working range', () => {
    const root = makeDataRoot({
      logs: [
        runLog({
          sessionId: 'session-c',
          runId: 'run-1',
          startedAt: '2026-09-22T03:00:00.000Z',
          requests: [
            request({ id: 'req-1', purpose: 'execute_tool_loop', at: '2026-09-22T03:00:01.000Z', input: 1000, cached: 0 }),
            request({
              id: 'req-2', purpose: 'execute_tool_loop', at: '2026-09-22T03:00:02.000Z', input: 1000, cached: 900, retryOf: 'req-1',
            }),
            request({ id: 'req-3', purpose: 'reply', at: '2026-09-22T03:00:03.000Z', input: 1000, cached: 999 }),
          ],
        }),
      ],
    });
    const projection = projectSessions(readLedger(root));
    const session = projection.sessions[0];

    expect(session.sessionProjection.requests).toBe(3);
    expect(session.sessionProjection.input).toBe(3_000);
    expect(session.sessionProjection.cached).toBe(1_899);
    expect(session.sessionProjection.aboveCeiling).toBe(false);

    const high = totalsOf([
      { input: 10_000, cached: 9_990 },
      { input: 10_000, cached: 9_990 },
    ]);
    expect(high.hitPercent).toBeCloseTo(99.9, 6);
    expect(high.aboveCeiling).toBe(true);
    expect(high.withinTarget).toBe(true);
  });

  it('reports unattributed detached usage instead of dropping it', () => {
    const root = makeDataRoot({
      logs: [
        runLog({
          sessionId: 'session-d',
          runId: 'run-1',
          startedAt: '2026-09-22T04:00:00.000Z',
          requests: [request({ id: 'req-1', purpose: 'reply', at: '2026-09-22T04:00:01.000Z', input: 1000, cached: 950 })],
        }),
      ],
      observations: [
        observation({ requestKind: 'session_compaction', modelRequestId: 'orphan', sessionDigest: 'unknown-digest', input: 500, cached: 0 }),
      ],
    });
    const projection = projectSessions(readLedger(root));

    expect(projection.unattributed.requests).toBe(1);
    expect(projection.unattributed.input).toBe(500);
    expect(projection.unattributedByPurpose.map((entry) => entry.purpose)).toEqual(['session_compaction']);
    // The whole-ledger total still carries it: nothing detaches from H_all.
    expect(projection.ledger.requests).toBe(2);
    expect(projection.ledger.input).toBe(1_500);
    expect(summarizeSessions(projection)[0]).toMatchObject({
      requests: 1,
      auxiliaryRequests: 0,
      allHitPercent: 95,
    });
  });

  it('ranks uncached input into cold start, prefix rewrite and append residual', () => {
    const root = makeDataRoot({
      logs: [
        runLog({
          sessionId: 'session-e',
          runId: 'run-1',
          startedAt: '2026-09-22T05:00:00.000Z',
          requests: [
            request({ id: 'req-1', purpose: 'execute_tool_loop', at: '2026-09-22T05:00:01.000Z', input: 4000, cached: 0 }),
            request({ id: 'req-2', purpose: 'execute_tool_loop', at: '2026-09-22T05:00:02.000Z', input: 5000, cached: 2000 }),
            request({ id: 'req-3', purpose: 'execute_tool_loop', at: '2026-09-22T05:00:03.000Z', input: 5200, cached: 5000 }),
          ],
        }),
      ],
      observations: [
        observation({
          requestKind: 'execute_tool_loop',
          modelRequestId: 'req-1',
          sessionDigest: DIGEST,
          input: 4000,
          cached: 0,
          components: { promptVersion: 'p1', memoryRevision: 'm1' },
        }),
        observation({
          requestKind: 'execute_tool_loop',
          modelRequestId: 'req-2',
          sessionDigest: DIGEST,
          input: 5000,
          cached: 2000,
          components: { promptVersion: 'p1', memoryRevision: 'm2' },
          invalidationReasons: ['prompt_version_changed'],
        }),
        observation({
          requestKind: 'execute_tool_loop',
          modelRequestId: 'req-3',
          sessionDigest: DIGEST,
          input: 5200,
          cached: 5000,
          components: { promptVersion: 'p1', memoryRevision: 'm2' },
        }),
      ],
    });

    const session = projectSessions(readLedger(root)).sessions[0];

    expect(session.losses).toMatchObject({
      coldStart: 4_000,
      rebuild: 3_000,
      appendResidual: 200,
      unknownUsage: 0,
      rebuildThresholdTokens: 1_024,
    });
    expect(session.losses.rebuildEvents).toEqual([{
      ordinal: 2,
      runId: 'run-1',
      purpose: 'execute_tool_loop',
      input: 5_000,
      previousInput: 4_000,
      promptGrowth: 1_000,
      uncached: 3_000,
      reuseWaste: 2_000,
      changedComponents: ['memoryRevision'],
      invalidationReasons: ['prompt_version_changed'],
      stablePrefixFingerprintChanged: false,
    }]);
    expect(session.losses.appendResidualMedian).toBe(200);
    // Measured: 1000 + 200 tokens were genuinely new; 2000 were already sent.
    expect(session.losses.newContent).toBe(1_200);
    expect(session.losses.reuseWaste).toEqual({ total: 2_000, fromRebuild: 2_000, fromAppend: 0 });
    // Derived, explicitly flagged: the re-billed tokens would have been cached,
    // so 9000/14200 with the same tokens sent; 13000/14200 with a free cold start.
    expect(session.losses.derivedBounds.derived).toBe(true);
    expect(session.losses.derivedBounds.reuseWasteRecovered)
      .toMatchObject({ input: 14_200, cached: 9_000 });
    expect(session.losses.derivedBounds.reuseWasteRecovered.hitPercent)
      .toBeCloseTo((9000 / 14200) * 100, 6);
    expect(session.losses.derivedBounds.coldStartAlsoCached)
      .toMatchObject({ input: 14_200, cached: 13_000 });
  });
});
