// Public, redacted contracts for Memory v3 workload reports.

import type { MemoryWorkloadResourceSummary } from './memory-workload-resources.js';

export const MEMORY_WORKLOAD_OBSERVATION_VERSION = 3 as const;

export interface MemoryWorkloadObservationOptions {
  maxRuns?: number;
  maxUniqueAtomIds?: number;
  sourceRunCount?: number;
  minKnownStateRuns?: number;
  minExplicitUseRuns?: number;
  minProviderUsageRuns?: number;
  minVerificationRecordRuns?: number;
  minResourceSampleRuns?: number;
}

export interface MemoryWorkloadObservation {
  version: typeof MEMORY_WORKLOAD_OBSERVATION_VERSION;
  generatedAt: string;
  runs: {
    available: number;
    inspected: number;
    truncated: boolean;
    boundedInputTruncatedRuns: number;
    status: { ok: number; error: number; aborted: number; other: number };
  };
  coverage: {
    memoryAccessRuns: number;
    knownStateRuns: number;
    verificationRuns: number;
    historicalPassRuns: number;
    explicitUseRuns: number;
    providerUsageRuns: number;
    rates: {
      memoryAccess: number | null;
      knownState: number | null;
      explicitUseReporting: number | null;
      providerUsage: number | null;
      verificationRecordCoverage: number | null;
    };
  };
  memory: {
    accessRecords: number;
    accessActions: Record<string, number>;
    accessStatus: { ok: number; degraded: number; error: number; other: number };
    tokensUsed: { total: number; maximum: number; averagePerMemoryRun: number | null };
    tokenBudgetTotal: number;
    knownReferences: { adopted: number; excluded: number; conflicted: number; reactivated: number };
    explicitUseReferences: number;
    uniqueObservedAtomIds: number;
    uniqueAtomIdsTruncated: boolean;
  };
  quality: {
    verificationVerdicts: { historicalPass: number; needsReplan: number; fail: number; unverified: number; other: number };
    taskExecution: { done: number; incomplete: number; other: number };
    memoryAssisted: {
      adoptedRuns: number;
      adoptedWithoutExplicitUseRuns: number;
      explicitUseWithHistoricalPassRuns: number;
      explicitUseWithOtherRecordRuns: number;
      releaseRuns: number;
      conflictRuns: number;
    };
    diagnosticReferences: {
      adoptedButNotExplicitlyUsed: number;
      usedWithoutAdopted: number;
    };
  };
  cost: {
    providerRequests: number;
    providerPromptTokens: number;
    providerCompletionTokens: number;
    providerCachedPromptTokens: number;
    providerReasoningTokens: number;
    averagePromptTokensPerProviderRun: number | null;
    memoryToProviderPromptRatio: number | null;
  };
  resources: MemoryWorkloadResourceSummary;
  calibration: {
    state: 'ready' | 'insufficient';
    required: {
      knownStateRuns: number;
      explicitUseRuns: number;
      providerUsageRuns: number;
      verificationRecordRuns: number;
      resourceSampleRuns: number;
    };
    missing: string[];
  };
}
