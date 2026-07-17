import { describe, expect, it } from 'vitest';
import { asSessionId, type ContextSnapshot } from '@littlesheep/types';
import type { ExecutionLog } from './execution-log.js';
import { observeMemoryWorkload } from './memory-workload-observability.js';

describe('Memory v3 workload observability', () => {
  it('aggregates only bounded metadata and never returns conversation content', () => {
    const report = observeMemoryWorkload([
      log({
        inboundText: 'PRIVATE-USER-CONTENT',
        reply: 'PRIVATE-ASSISTANT-CONTENT',
        taskExecution: {
          goal: 'inspect the task',
          complexity: 'simple',
          status: 'done',
          startedAt: TIME,
          endedAt: TIME,
          steps: [],
        },
        memoryAccess: {
          runId: 'run-1', sessionId: asSessionId('session-1'), workspace: 'D:/workspace', startedAt: TIME,
          totalTokenBudget: 600, tokensUsed: 120, expandedBranches: ['project'], dedupKeys: [],
          records: [{
            id: 'access-1', action: 'expand', at: TIME, branchId: 'project', status: 'ok',
            fragmentIds: ['atom-a', 'atom-b'], sourceCount: 2, dedupedCount: 0,
            tokensUsed: 120, tokenBudget: 300,
          }],
          knownState: { version: 1, runId: 'run-1', revision: 1, updatedAt: TIME, references: [] },
        },
        memoryKnownState: {
          version: 1, runId: 'run-1', revision: 2, updatedAt: TIME,
          references: [
            knownReference('atom-a', 'adopted', 1),
            knownReference('atom-b', 'excluded', 0),
          ],
        },
        verificationHistory: [{
          attempt: 1, verdict: 'pass', source: 'model', verifiedAt: TIME,
          reason: 'PRIVATE-VERIFICATION-REASON', usedMemoryAtomIds: ['atom-a'],
        }],
        contextSnapshots: [providerContextSnapshot()],
        runtimeResources: runtimeResources(),
      }),
    ], {
      minKnownStateRuns: 1,
      minExplicitUseRuns: 1,
      minProviderUsageRuns: 1,
      minVerifiedOutcomeRuns: 1,
      minResourceSampleRuns: 1,
    });

    expect(report.version).toBe(2);
    expect(report.coverage).toMatchObject({
      memoryAccessRuns: 1,
      knownStateRuns: 1,
      verificationRuns: 1,
      verifiedPassRuns: 1,
      explicitUseRuns: 1,
      providerUsageRuns: 1,
      verifiedOutcomeRuns: 1,
      rates: { verifiedOutcome: 1 },
    });
    expect(report.memory).toMatchObject({
      accessRecords: 1,
      accessActions: { expand: 1 },
      tokensUsed: { total: 120, maximum: 120, averagePerMemoryRun: 120 },
      knownReferences: { adopted: 1, excluded: 1, conflicted: 0, reactivated: 1 },
      explicitUseReferences: 1,
      uniqueObservedAtomIds: 2,
    });
    expect(report.quality).toMatchObject({
      verificationVerdicts: { pass: 1 },
      taskExecution: { done: 1, incomplete: 0 },
    });
    expect(report.cost).toMatchObject({
      providerRequests: 1,
      providerPromptTokens: 1_024,
      providerCompletionTokens: 128,
      providerCachedPromptTokens: 256,
      providerReasoningTokens: 64,
    });
    expect(report.resources).toMatchObject({
      sampledRuns: 1,
      rssBytes: { averageStart: 100, averageEnd: 120, averageDelta: 20, maximumIncrease: 20 },
      heapUsedBytes: { averageStart: 40, averageEnd: 50, averageDelta: 10, maximumIncrease: 10 },
    });
    expect(report.calibration.state).toBe('ready');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE-|D:\/workspace/u);
  });

  it('bounds inspected runs and unique Atom state while preserving coverage gaps', () => {
    const report = observeMemoryWorkload([
      log({ runId: 'run-newest', memoryAccess: memoryAccess('run-newest', ['atom-a', 'atom-b']) }),
      log({ runId: 'run-middle', status: 'error', memoryAccess: memoryAccess('run-middle', ['atom-c']) }),
      log({ runId: 'run-oldest', status: 'aborted', memoryAccess: memoryAccess('run-oldest', ['atom-d']) }),
    ], {
      maxRuns: 2,
      sourceRunCount: 8,
      maxUniqueAtomIds: 2,
    });

    expect(report.runs).toMatchObject({
      available: 8,
      inspected: 2,
      truncated: true,
      status: { ok: 1, error: 1, aborted: 0, other: 0 },
    });
    expect(report.memory.uniqueObservedAtomIds).toBe(2);
    expect(report.memory.uniqueAtomIdsTruncated).toBe(true);
    expect(report.calibration).toMatchObject({
      state: 'insufficient',
      missing: [
        'known-state-runs',
        'explicit-use-runs',
        'provider-usage-runs',
        'verified-outcome-runs',
        'resource-sample-runs',
      ],
    });
  });

  it('keeps rates null when there is no trustworthy denominator', () => {
    const report = observeMemoryWorkload([]);

    expect(report.coverage.rates).toEqual({
      memoryAccess: null,
      knownState: null,
      explicitUseReporting: null,
      providerUsage: null,
      verifiedOutcome: null,
    });
    expect(report.memory.tokensUsed.averagePerMemoryRun).toBeNull();
  });

  it('keeps caller-provided collection limits within hard process bounds', () => {
    const boundedAccess = memoryAccess('run-bounded', []);
    boundedAccess.records = Array.from({ length: 17 }, (_, recordIndex) => ({
      id: `access-${recordIndex}`,
      action: 'branch_index' as const,
      at: TIME,
      status: 'ok' as const,
      fragmentIds: Array.from(
        { length: 1_024 },
        (_, atomIndex) => `atom-${recordIndex * 1_024 + atomIndex}`,
      ),
      sourceCount: 1_024,
      dedupedCount: 0,
      tokensUsed: 10,
      tokenBudget: 600,
    }));
    const report = observeMemoryWorkload([
      log({ memoryAccess: boundedAccess }),
    ], {
      maxRuns: Number.MAX_SAFE_INTEGER,
      maxUniqueAtomIds: Number.MAX_SAFE_INTEGER,
    });

    expect(report.runs.inspected).toBe(1);
    expect(report.memory.uniqueObservedAtomIds).toBe(16_384);
    expect(report.memory.uniqueAtomIdsTruncated).toBe(true);
  });
});

const TIME = '2026-07-17T00:00:00.000Z';

function log(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    startedAt: TIME,
    endedAt: TIME,
    status: 'ok',
    model: 'test/model',
    inboundText: '',
    reply: '',
    trace: [],
    toolCalls: [],
    durationMs: 100,
    ...overrides,
  };
}

function memoryAccess(runId: string, fragmentIds: string[]): NonNullable<ExecutionLog['memoryAccess']> {
  return {
    runId,
    sessionId: asSessionId('session-1'),
    workspace: 'D:/workspace',
    startedAt: TIME,
    totalTokenBudget: 600,
    tokensUsed: 100,
    expandedBranches: [],
    dedupKeys: [],
    records: [{
      id: `${runId}-access`, action: 'branch_index', at: TIME, status: 'ok', fragmentIds,
      sourceCount: fragmentIds.length, dedupedCount: 0, tokensUsed: 100, tokenBudget: 600,
    }],
    knownState: { version: 1, runId, revision: 1, updatedAt: TIME, references: [] },
  };
}

function providerContextSnapshot(): ContextSnapshot {
  return {
    version: 1,
    id: 'context-1',
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    provider: 'test-provider',
    model: 'test-model',
    createdAt: TIME,
    budget: {
      status: 'known',
      maxContextTokens: 128_000,
      reservedOutputTokens: 8_000,
      availablePromptTokens: 120_000,
      compressionThresholdRatio: 0.8,
    },
    items: [],
    totalItemCount: 0,
    itemsTruncated: false,
    compressionRecommended: false,
    providerUsage: {
      version: 1,
      source: 'provider',
      provider: 'test-provider',
      model: 'test-model',
      promptTokens: 1_024,
      completionTokens: 128,
      cachedPromptTokens: 256,
      reasoningTokens: 64,
      reportedAt: TIME,
    },
  };
}

function runtimeResources(): NonNullable<ExecutionLog['runtimeResources']> {
  return {
    version: 1,
    device: {
      platform: 'win32',
      arch: 'x64',
      totalMemoryMiBBucket: 16_384,
      logicalCpuBucket: 16,
    },
    start: {
      sampledAt: TIME,
      rssBytes: 100,
      heapUsedBytes: 40,
      externalBytes: 1,
      arrayBuffersBytes: 1,
    },
    end: {
      sampledAt: TIME,
      rssBytes: 120,
      heapUsedBytes: 50,
      externalBytes: 2,
      arrayBuffersBytes: 2,
    },
  };
}

function knownReference(
  atomId: string,
  decision: 'adopted' | 'excluded' | 'conflicted',
  reactivatedCount: number,
): NonNullable<ExecutionLog['memoryKnownState']>['references'][number] {
  return {
    atomId,
    atomRevision: 1,
    sourceRefs: [],
    evidenceRefs: [],
    decision,
    reason: 'redacted test reason',
    envelope: {} as never,
    stages: [],
    firstSeenAt: TIME,
    updatedAt: TIME,
    reactivatedCount,
  };
}
