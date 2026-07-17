// Aggregates redacted, bounded Memory v3 workload signals without retaining content or identifiers.

import type { ExecutionLog } from './execution-log.js';
import {
  MemoryWorkloadResourceAccumulator,
} from './memory-workload-resources.js';
import {
  MEMORY_WORKLOAD_OBSERVATION_VERSION,
  type MemoryWorkloadObservation,
  type MemoryWorkloadObservationOptions,
} from './memory-workload-observation-contracts.js';
import {
  boundedArray,
  boundedPositiveInteger,
  differenceCount,
  finiteNonNegative,
  incrementBounded,
  incrementFixed,
  incrementTaskExecution,
  incrementVerdict,
  nonNegativeInteger,
  ratio,
} from './memory-workload-observation-support.js';

export {
  MEMORY_WORKLOAD_OBSERVATION_VERSION,
  type MemoryWorkloadObservation,
  type MemoryWorkloadObservationOptions,
} from './memory-workload-observation-contracts.js';

const MAX_INSPECTED_RUNS = 10_000;
const MAX_OBSERVED_ATOM_IDS = 16_384;
const MAX_ACCESS_RECORDS_PER_RUN = 4_096;
const MAX_REFERENCES_PER_RUN = 4_096;
const MAX_VERIFICATIONS_PER_RUN = 512;
const MAX_CONTEXT_SNAPSHOTS_PER_RUN = 512;
const MAX_ATOM_IDS_PER_RECORD = 1_024;

export function observeMemoryWorkload(
  logs: readonly ExecutionLog[],
  options: MemoryWorkloadObservationOptions = {},
): MemoryWorkloadObservation {
  const maxRuns = boundedPositiveInteger(options.maxRuns, 1_000, MAX_INSPECTED_RUNS);
  const maxUniqueAtomIds = boundedPositiveInteger(options.maxUniqueAtomIds, 4_096, MAX_OBSERVED_ATOM_IDS);
  const sourceRunCount = Math.max(logs.length, nonNegativeInteger(options.sourceRunCount, logs.length));
  const selected = logs.slice(0, maxRuns);
  const status = { ok: 0, error: 0, aborted: 0, other: 0 };
  const accessStatus = { ok: 0, degraded: 0, error: 0, other: 0 };
  const knownReferences = { adopted: 0, excluded: 0, conflicted: 0, reactivated: 0 };
  const verificationVerdicts = { pass: 0, needsReplan: 0, fail: 0, other: 0 };
  const taskExecution = { done: 0, incomplete: 0, other: 0 };
  const memoryAssisted = {
    adoptedRuns: 0,
    adoptedWithoutExplicitUseRuns: 0,
    explicitUsePassRuns: 0,
    explicitUseNonPassRuns: 0,
    explicitUseUnverifiedRuns: 0,
    releaseRuns: 0,
    conflictRuns: 0,
  };
  const diagnosticReferences = { adoptedButNotExplicitlyUsed: 0, usedWithoutAdopted: 0 };
  const accessActions: Record<string, number> = {};
  const observedAtomIds = new Set<string>();
  const resources = new MemoryWorkloadResourceAccumulator();
  let uniqueAtomIdsTruncated = false;
  let boundedInputTruncatedRuns = 0;
  let memoryAccessRuns = 0;
  let knownStateRuns = 0;
  let verificationRuns = 0;
  let verifiedOutcomeRuns = 0;
  let verifiedPassRuns = 0;
  let explicitUseRuns = 0;
  let providerUsageRuns = 0;
  let accessRecords = 0;
  let tokensUsedTotal = 0;
  let tokensUsedMaximum = 0;
  let tokenBudgetTotal = 0;
  let explicitUseReferences = 0;
  let providerRequests = 0;
  let providerPromptTokens = 0;
  let providerCompletionTokens = 0;
  let providerCachedPromptTokens = 0;
  let providerReasoningTokens = 0;
  let pairedMemoryTokens = 0;
  let pairedProviderPromptTokens = 0;

  const observeAtomId = (value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0 || observedAtomIds.has(value)) return;
    if (observedAtomIds.size >= maxUniqueAtomIds) {
      uniqueAtomIdsTruncated = true;
      return;
    }
    observedAtomIds.add(value);
  };

  for (const log of selected) {
    incrementFixed(status, log.status);
    let inputTruncated = false;
    const records = boundedArray(log.memoryAccess?.records, MAX_ACCESS_RECORDS_PER_RUN);
    const references = boundedArray(log.memoryKnownState?.references, MAX_REFERENCES_PER_RUN);
    const verification = boundedArray(log.verificationHistory, MAX_VERIFICATIONS_PER_RUN);
    const snapshots = boundedArray(log.contextSnapshots, MAX_CONTEXT_SNAPSHOTS_PER_RUN);
    inputTruncated ||= records.truncated || references.truncated || verification.truncated || snapshots.truncated;

    if (records.items.length > 0) memoryAccessRuns += 1;
    let releasedInRun = false;
    for (const record of records.items) {
      accessRecords += 1;
      incrementBounded(accessActions, record.action, 32);
      incrementFixed(accessStatus, record.status);
      if (record.action === 'release') releasedInRun = true;
      const fragmentIds = boundedArray(record.fragmentIds, MAX_ATOM_IDS_PER_RECORD);
      inputTruncated ||= fragmentIds.truncated;
      for (const atomId of fragmentIds.items) observeAtomId(atomId);
    }
    if (releasedInRun) memoryAssisted.releaseRuns += 1;

    const memoryTokens = finiteNonNegative(log.memoryAccess?.tokensUsed);
    if (log.memoryAccess) {
      tokensUsedTotal += memoryTokens;
      tokensUsedMaximum = Math.max(tokensUsedMaximum, memoryTokens);
      tokenBudgetTotal += finiteNonNegative(log.memoryAccess.totalTokenBudget);
    }

    const adopted = new Set<string>();
    const conflicted = new Set<string>();
    if (references.items.length > 0) knownStateRuns += 1;
    for (const reference of references.items) {
      if (reference.decision === 'adopted') {
        knownReferences.adopted += 1;
        adopted.add(reference.atomId);
      } else if (reference.decision === 'excluded') {
        knownReferences.excluded += 1;
      } else if (reference.decision === 'conflicted') {
        knownReferences.conflicted += 1;
        conflicted.add(reference.atomId);
      }
      if (reference.reactivatedCount > 0) knownReferences.reactivated += 1;
      observeAtomId(reference.atomId);
    }
    if (adopted.size > 0) memoryAssisted.adoptedRuns += 1;
    if (conflicted.size > 0) memoryAssisted.conflictRuns += 1;

    if (verification.items.length > 0) verificationRuns += 1;
    if (verification.items.some((record) => record.verdict === 'pass')) verifiedPassRuns += 1;
    const latestVerification = verification.items.at(-1);
    if (latestVerification) {
      verifiedOutcomeRuns += 1;
      incrementVerdict(verificationVerdicts, latestVerification.verdict);
    }
    const usedInRun = new Set<string>();
    for (const record of verification.items) {
      const atomIds = boundedArray(record.usedMemoryAtomIds, MAX_ATOM_IDS_PER_RECORD);
      inputTruncated ||= atomIds.truncated;
      for (const atomId of atomIds.items) {
        if (typeof atomId !== 'string' || !atomId) continue;
        usedInRun.add(atomId);
        observeAtomId(atomId);
      }
    }
    if (usedInRun.size > 0) {
      explicitUseRuns += 1;
      if (!latestVerification) memoryAssisted.explicitUseUnverifiedRuns += 1;
      else if (latestVerification.verdict === 'pass') memoryAssisted.explicitUsePassRuns += 1;
      else memoryAssisted.explicitUseNonPassRuns += 1;
    }
    if (adopted.size > 0 && usedInRun.size === 0) memoryAssisted.adoptedWithoutExplicitUseRuns += 1;
    explicitUseReferences += usedInRun.size;
    diagnosticReferences.adoptedButNotExplicitlyUsed += differenceCount(adopted, usedInRun);
    diagnosticReferences.usedWithoutAdopted += differenceCount(usedInRun, adopted);

    incrementTaskExecution(taskExecution, log.taskExecution?.status);

    let runProviderRequests = 0;
    let runPromptTokens = 0;
    for (const snapshot of snapshots.items) {
      const usage = snapshot.providerUsage;
      if (!usage || usage.source !== 'provider') continue;
      runProviderRequests += 1;
      const promptTokens = finiteNonNegative(usage.promptTokens);
      runPromptTokens += promptTokens;
      providerPromptTokens += promptTokens;
      providerCompletionTokens += finiteNonNegative(usage.completionTokens);
      providerCachedPromptTokens += finiteNonNegative(usage.cachedPromptTokens);
      providerReasoningTokens += finiteNonNegative(usage.reasoningTokens);
    }
    if (runProviderRequests > 0) {
      providerUsageRuns += 1;
      providerRequests += runProviderRequests;
      pairedMemoryTokens += memoryTokens;
      pairedProviderPromptTokens += runPromptTokens;
    }

    resources.observe(log.runtimeResources);
    if (inputTruncated) boundedInputTruncatedRuns += 1;
  }

  const resourceSummary = resources.snapshot();
  const required = {
    knownStateRuns: nonNegativeInteger(options.minKnownStateRuns, 20),
    explicitUseRuns: nonNegativeInteger(options.minExplicitUseRuns, 10),
    providerUsageRuns: nonNegativeInteger(options.minProviderUsageRuns, 10),
    verifiedOutcomeRuns: nonNegativeInteger(options.minVerifiedOutcomeRuns, 20),
    resourceSampleRuns: nonNegativeInteger(options.minResourceSampleRuns, 20),
  };
  const missing = [
    knownStateRuns < required.knownStateRuns ? 'known-state-runs' : '',
    explicitUseRuns < required.explicitUseRuns ? 'explicit-use-runs' : '',
    providerUsageRuns < required.providerUsageRuns ? 'provider-usage-runs' : '',
    verifiedOutcomeRuns < required.verifiedOutcomeRuns ? 'verified-outcome-runs' : '',
    resourceSummary.sampledRuns < required.resourceSampleRuns ? 'resource-sample-runs' : '',
  ].filter(Boolean);

  return {
    version: MEMORY_WORKLOAD_OBSERVATION_VERSION,
    generatedAt: new Date().toISOString(),
    runs: {
      available: sourceRunCount,
      inspected: selected.length,
      truncated: sourceRunCount > selected.length,
      boundedInputTruncatedRuns,
      status,
    },
    coverage: {
      memoryAccessRuns,
      knownStateRuns,
      verificationRuns,
      verifiedOutcomeRuns,
      verifiedPassRuns,
      explicitUseRuns,
      providerUsageRuns,
      rates: {
        memoryAccess: ratio(memoryAccessRuns, selected.length),
        knownState: ratio(knownStateRuns, selected.length),
        explicitUseReporting: ratio(explicitUseRuns, verifiedOutcomeRuns),
        providerUsage: ratio(providerUsageRuns, selected.length),
        verifiedOutcome: ratio(verifiedOutcomeRuns, selected.length),
      },
    },
    memory: {
      accessRecords,
      accessActions,
      accessStatus,
      tokensUsed: {
        total: tokensUsedTotal,
        maximum: tokensUsedMaximum,
        averagePerMemoryRun: ratio(tokensUsedTotal, memoryAccessRuns),
      },
      tokenBudgetTotal,
      knownReferences,
      explicitUseReferences,
      uniqueObservedAtomIds: observedAtomIds.size,
      uniqueAtomIdsTruncated,
    },
    quality: {
      verificationVerdicts,
      taskExecution,
      memoryAssisted,
      diagnosticReferences,
    },
    cost: {
      providerRequests,
      providerPromptTokens,
      providerCompletionTokens,
      providerCachedPromptTokens,
      providerReasoningTokens,
      averagePromptTokensPerProviderRun: ratio(providerPromptTokens, providerUsageRuns),
      memoryToProviderPromptRatio: ratio(pairedMemoryTokens, pairedProviderPromptTokens),
    },
    resources: resourceSummary,
    calibration: {
      state: missing.length === 0 ? 'ready' : 'insufficient',
      required,
      missing,
    },
  };
}
